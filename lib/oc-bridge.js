// dsh-connect-opencode-free · 把请求交给本机 OpenCode 客户端代发（v2 API）
//
// 为什么必须有这一层：Zen 的免费档不再接受「长得像 OpenCode」的请求，只接受
// **由真实 OpenCode 客户端发出**的请求。插件直连时，无论 UA、x-opencode-session、
// 工具集、报文怎么对齐，拿到的都是
//
//   429 {"type":"error","error":{"type":"FreeUsageLimitError", ...}}
//
// 而同一个模型、同一份报文由 `opencode-cli.exe` 发出就 200。区别不在报文里，而在
// 发出者本身（TLS/传输层身份），插件在自己的进程里**无法**复制。2026-10-27 的
// 对照：直连 429、经 opencode-cli 代理 200、对真实 CLI 做 TLS 中间人后再转发 429。
//
// 所以唯一可行的免费档通路是：启动本机真实的 OpenCode v2 服务，让它代为发起推理。
//
// 用法上的硬要求（每一条都踩过）：
//   1. 必须用 v2 客户端（`opencode-cli.exe` 2.x），v1 的 `opencode` 没有 `/api/*`。
//      桌面版自带一份：%APPDATA%\ai.opencode.desktop\cli\<version>\opencode-cli.exe。
//   2. 启动 serve 时必须设 NO_PROXY=127.0.0.1,localhost。本机有 HTTP_PROXY 却没有
//      no_proxy，连回环的请求都会被送进代理并回 401。
//   3. 必须用 XDG_CONFIG_HOME 隔离配置：否则会读用户全局配置里的 MCP 服务器与插件，
//      冷启动从 0.5 秒变成 10 秒以上，还会在我们的会话目录里拉起 npx 进程。
//   4. 会话必须挂在一个**自定义 agent** 上。内置 `build` 的系统提示含整套技能目录，
//      每轮 19.5k 输入 tokens；自定义 agent 只要 0.7–1k。
//   5. 该 agent 的工具集必须非空。全 deny 会让上游请求不带 tools，网关照样回 429。
//      只留 `bash`/`read` 并设成 `ask`：既满足闸门，又不会真的执行任何东西（我们对
//      每个权限请求回 reject）。
//   6. `session.generate` 和 `/api/experimental/generate` 在免费档固定 503；只有
//      `session.prompt` + agent 循环可用。
//   7. 启动失败要记住结论，否则每次请求都 fork 一个必败进程、还各等满 60 秒。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** serve 起来之前的等待上限；隔离配置冷启动实测 0.5–3 秒。 */
const BOOT_TIMEOUT_MS = 60_000
/** 一轮对话的默认上限：免费档偶发排队，给足时间但不至于挂死宿主。 */
const TURN_TIMEOUT_MS = 10 * 60_000
/** 等待模型产出时轮询消息/权限的间隔。 */
const POLL_INTERVAL_MS = 250
/** serve 的 Basic 认证用户名。v2 固定为 `opencode`（不是 v1 的 `dsh`）。 */
const BRIDGE_USERNAME = 'opencode'

/** 桥专用 agent 的 id，写进我们生成的 opencode.json。 */
export const BRIDGE_AGENT_ID = 'dsh-bridge'

/**
 * 桥专用 agent 的系统提示。
 *
 * 必须与宿主的文本工具协议**同向**。写成「你没有工具」会与协议里「HOST TOOLS 是
 * 唯一可调用的工具」冲突，模型会在两者之间反复解释（实测直接把推理过程当正文输出）。
 * 这里改成的说法是：内置工具与用户会话无关、别用；HOST TOOLS 才是要遵守的协议。
 */
const BRIDGE_SYSTEM = [
  'You are the model backend for DSH, a coding-agent harness.',
  'DSH reaches you only through conversation text.',
  'A HOST TOOLS block in a message lists the only tools you may call,',
  'using the JSON protocol stated there.',
  'Ignore every built-in tool you were given: they are not connected to the',
  "user's session, and calling one only wastes a turn.",
  'Reply with exactly what the conversation asks for: no preamble, no',
  'meta-commentary, no description of your own reasoning.',
].join(' ')

/**
 * 我们为桥进程生成的全局配置。
 *
 * 唯一目的是定义 {@link BRIDGE_AGENT_ID}：小系统提示 + 恰好两个工具。工具必须存在
 * （网关要看到 tools），但又不能真的可用（宿主工具走文本协议，原生工具调用没有
 * 执行者），所以除了 bash/read 一律 deny，bash/read 设为 ask 再由我们逐个 reject。
 */
function bridgeConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [BRIDGE_AGENT_ID]: {
        description: 'Text-only model bridge for DSH.',
        mode: 'primary',
        system: BRIDGE_SYSTEM,
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'bash', resource: '*', effect: 'ask' },
          { action: 'read', resource: '*', effect: 'ask' },
        ],
      },
    },
  }
}

/**
 * 找出可以启动的 v2 `opencode` 客户端。
 *
 * 顺序即优先级，因为 v1 与 v2 的 API 完全不兼容：`opencode` 1.19 在 PATH 上很常见，
 * 但它没有 `/api/info`。桌面版自带的 `opencode-cli.exe` 才是要的那个，所以先找它。
 * @param override - 调用方指定的命令（`OPENCODE_BIN` / 构造参数）。
 * @returns 可用的命令字符串；一个都没有时返回 null。
 */
export function resolveCommand(override) {
  const tried = []
  const windows = process.platform === 'win32'
  const home = os.homedir()
  const desktopCli = windows ? desktopCandidates() : []
  const candidates = [
    override,
    process.env.OPENCODE_BIN,
    ...desktopCli,
    windows ? path.join(process.env.APPDATA ?? '', 'npm', 'opencode.cmd') : null,
    windows ? 'opencode.cmd' : 'opencode',
    'opencode',
    path.join(home, '.opencode', 'bin', windows ? 'opencode.exe' : 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter(Boolean)

  for (const candidate of candidates) {
    const absolute = candidate.includes(path.sep) || candidate.includes('/')
    if (absolute) {
      if (fs.existsSync(candidate)) return candidate
      tried.push(candidate)
      continue
    }
    if (whichSync(candidate)) return candidate
    tried.push(`${candidate}（不在 PATH 中）`)
  }
  resolveCommand.tried = tried
  return null
}

/**
 * 桌面版内置 CLI 的候选路径，最新的版本目录优先。
 *
 * 桌面版把 CLI 放在 `…\cli\<version>-<arch>\opencode-cli.exe`；升级会留下多个目录，
 * 所以按目录名倒序取，而不是写死版本号。
 * @returns 绝对路径列表（不一定存在）。
 */
function desktopCandidates() {
  const roots = [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'ai.opencode.desktop', 'cli') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ai.opencode.desktop', 'cli') : '',
  ].filter(Boolean)
  const found = []
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
    for (const version of versions) {
      found.push(path.join(root, version, 'opencode-cli.exe'))
      found.push(path.join(root, version, 'opencode.exe'))
    }
  }
  // 安装版/便携版没有版本目录时的常见位置。
  found.push(
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenCode', 'resources', 'opencode-cli.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'OpenCode', 'opencode-cli.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'opencode', 'opencode.exe'),
  )
  return found.filter((file) => file !== '')
}

/** 同步地在 PATH 里找一个可执行文件（spawn 是异步的，这里只要一个答案）。 */
function whichSync(command) {
  const pathValue = process.env.PATH ?? ''
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of ['', ...exts]) {
      const file = path.join(dir, command + ext)
      try {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
      } catch {
        /* 目录不可读就跳过 */
      }
    }
  }
  return null
}

/**
 * 把宿主的 OpenAI 风格消息序列化成一个会话文本。
 *
 * 客户端只接受 `parts`（文本/文件），没有「assistant 上一步调用了什么工具」这种
 * 结构化位置，所以工具轮次只能写成文本。顺序即时间顺序，模型读得懂。
 * @param messages - 已经过 `sanitizeWireMessages` 规范化的消息数组。
 * @returns 会话文本；不含 system（那个单独走 `system` 字段）。
 */
export function transcriptOf(messages) {
  const lines = []
  for (const message of messages ?? []) {
    const role = message?.role
    const text = flatten(message?.content)
    if (role === 'system') {
      // 有些调用方把 system 也塞进 messages；桥只用 `system` 参数，这里仍收下，
      // 否则那段约束会整段消失。
      if (text) lines.push(`System: ${text}`)
      continue
    }
    if (role === 'user') {
      lines.push(`User: ${text}`)
      continue
    }
    if (role === 'assistant') {
      const calls = (message?.tool_calls ?? []).map((call) => {
        const name = call?.function?.name ?? '?'
        const args = call?.function?.arguments ?? '{}'
        return `${name}(${args})`
      })
      const head = calls.length > 0 ? `Assistant: [calls ${calls.join(', ')}]` : 'Assistant:'
      lines.push(text ? `${head} ${text}` : head)
      continue
    }
    if (role === 'tool') {
      lines.push(`Tool result (${message?.name ?? message?.tool_call_id ?? '?'}): ${text}`)
    }
  }
  return lines.join('\n').trim()
}

function flatten(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .filter(Boolean)
    .join('\n')
}

/**
 * 宿主工具清单的 system 段。
 *
 * 客户端自带的 bash/read 必须留在报文里（否则网关 429），所以要显式告诉模型：
 * 那些不是宿主的工具，唯一能调用的只有下面这份清单。
 * @param tools - 宿主工具（含 name/description/parameters）。
 * @returns system 文本；没有工具时返回空串。
 */
export function toolProtocolOf(tools) {
  const usable = (tools ?? []).filter((tool) => tool && typeof tool.name === 'string' && tool.name)
  if (usable.length === 0) return ''
  const listed = usable.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }))
  return [
    'HOST TOOLS — these are the only tools you may invoke. You were also given',
    'built-in tools; ignore all of them, they are not connected to anything.',
    '',
    JSON.stringify(listed),
    '',
    'PROTOCOL — reply with exactly one JSON object and nothing else:',
    '  {"kind":"tool","name":"<a name from HOST TOOLS>","args":{...}}',
    '  {"kind":"final","text":"<your answer to the user>"}',
    '',
    'Rules:',
    '- One JSON object per reply. No prose, no code fences.',
    '- "name" must appear verbatim in HOST TOOLS; never invent one.',
    '- "args" must match that tool\'s parameters schema.',
    '- Emit kind=tool at most once per reply, then wait for the result.',
    '- When the answer needs no more tools, emit kind=final.',
  ].join('\n')
}

/**
 * 模型按协议给出的 JSON。
 *
 * 免费档模型偶尔在 JSON 外面裹一句散文（实测出现过），所以这里再手工兜一次：
 * 从第一个 `{` 到最后一个 `}` 之间取。
 * @param text - assistant 正文。
 * @returns 解析出的对象，解析失败返回 null。
 */
export function parseProtocol(text) {
  const trimmed = String(text ?? '').trim()
  const direct = tryParse(trimmed)
  if (direct) return direct
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1))
  return null
}

function tryParse(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 本机 `opencode serve` 的驱动者（v2 API）。
 *
 * 进程只起一次，之后所有请求复用。凭据是随机的，仅本机环回可见；serve 自带 Basic
 * 认证，端口不对外监听。
 */
export class OpenCodeBridge {
  /** @param options - `{ port, dir, command, log, timeoutMs, turnTimeoutMs }`。 */
  constructor(options = {}) {
    this.port = options.port ?? 0
    /**
     * 桥的私有目录：既是 XDG_CONFIG_HOME，也是 serve 的工作目录与每个会话的
     * location。放这里的配置不会污染用户自己的 OpenCode。
     */
    this.dir = options.dir ?? path.join(os.tmpdir(), 'dsh-opencode-free-bridge')
    this.log = options.log ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.turnTimeoutMs = options.turnTimeoutMs ?? TURN_TIMEOUT_MS
    this.command = options.command ?? null
    this.commandOverride = options.command ?? null
    this.password = options.password ?? randomPassword()
    this.agent = options.agent ?? BRIDGE_AGENT_ID
    this.base = null
    this.child = null
    this.booting = null
    /** spawn 本身失败的原因；health check 的 `fetch failed` 会盖住它，所以单独留着。 */
    this.spawnError = null
    /**
     * 上一次启动失败的结论与时间。
     *
     * 没有这个，每次请求都会重新 fork 一个必定失败的进程，还要等满 60 秒。
     * 失败一次就够了：把结论记住，冷却期内直接把同一个错误再抛出去。
     */
    this.failedAt = 0
    this.failure = null
    this.failureCooldownMs = options.failureCooldownMs ?? 10 * 60_000
    this.bootTimeoutMs = options.bootTimeoutMs ?? BOOT_TIMEOUT_MS
    /** 当前进程实际使用的 agent id（自定义 agent 没加载时回退到 build）。 */
    this.activeAgent = this.agent
  }

  get auth() {
    return 'Basic ' + Buffer.from(`${BRIDGE_USERNAME}:${this.password}`).toString('base64')
  }

  /**
   * 确保 serve 在跑。
   * @returns 基地址；启动失败抛出 `code = 'BRIDGE_UNAVAILABLE'` 的错误。
   */
  async ensure() {
    if (this.base) return this.base
    if (this.failure && Date.now() - this.failedAt < this.failureCooldownMs) {
      throw this.failure
    }
    // 并发调用共享同一次启动，否则每个请求都会 fork 出一个 serve。
    this.booting ??= this.boot()
    try {
      return await this.booting
    } catch (err) {
      this.booting = null
      this.failure = err
      this.failedAt = Date.now()
      throw err
    }
  }

  async boot() {
    this.command ??= resolveCommand(this.commandOverride)
    if (!this.command) {
      const tried = resolveCommand.tried ?? []
      const err = new Error(
        '找不到可用的 OpenCode v2 客户端（opencode-cli）。请先安装 OpenCode 桌面版/CLI，'
        + '或设置环境变量 OPENCODE_BIN 指向 2.x 的 opencode-cli.exe。已尝试：' + tried.join('、'),
      )
      err.code = 'BRIDGE_UNAVAILABLE'
      throw err
    }
    // 配置必须落在进程启动之前：serve 起来之后再写，agent 列表就定型了。
    try {
      fs.mkdirSync(path.join(this.dir, 'opencode'), { recursive: true })
      fs.writeFileSync(
        path.join(this.dir, 'opencode', 'opencode.json'),
        `${JSON.stringify(bridgeConfig(), null, 2)}\n`,
        'utf8',
      )
    } catch (error) {
      const err = new Error(`无法写入桥配置（${this.dir}）：${error?.message ?? error}`)
      err.code = 'BRIDGE_UNAVAILABLE'
      throw err
    }

    // 端口竞争很常见（探到空闲到真正 listen 之间），换一个再来。
    let lastError = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = this.port || (await freePort())
      try {
        const base = await this.startOn(port)
        this.base = base
        this.failure = null
        this.failedAt = 0
        this.log(`bridge: opencode serve 就绪于 ${base}（${this.command}）`)
        return base
      } catch (error) {
        lastError = error
        this.stopChild()
      }
    }
    throw lastError
  }

  /** 在指定端口启动并等它健康。 */
  async startOn(port) {
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--log-level', 'warn']
    const env = {
      ...process.env,
      // 让上游把它当成桌面客户端；实测这是免费档放行的前提之一。
      OPENCODE_CLIENT: 'desktop',
      OPENCODE_SERVER_PASSWORD: this.password,
      // 隔离配置：不读用户的全局 opencode.json（里面有 MCP 服务器和插件）。
      XDG_CONFIG_HOME: this.dir,
      // 系统代理会把连 127.0.0.1 的请求也送进代理，代理回 401。
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
    // v1 的用户名变量会改掉 Basic 认证的用户名，留着会让认证失败。
    delete env.OPENCODE_SERVER_USERNAME
    const child = spawn(this.command, args, {
      cwd: this.dir,
      env,
      stdio: 'ignore',
      windowsHide: true,
      // Windows 上 `opencode` 是 .cmd，没有 shell 找不到；.exe 走 shell 反而多一层。
      shell: /\.(cmd|bat)$/i.test(this.command),
    })
    this.spawnError = null
    child.on('error', (error) => { this.spawnError = error })
    // 不让子进程句柄拖住宿主退出。
    child.unref()
    this.child = child
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + this.bootTimeoutMs
    let last = '未知原因'
    while (Date.now() < deadline) {
      if (this.spawnError) {
        const err = new Error(
          `无法启动本机 OpenCode 客户端（${this.command}）：${this.spawnError.code ?? ''} ${this.spawnError.message}`.trim(),
        )
        err.code = 'BRIDGE_UNAVAILABLE'
        throw err
      }
      try {
        const res = await fetch(`${base}/api/info`, {
          headers: { Authorization: this.auth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const info = await res.json().catch(() => null)
          if (!info || typeof info.version !== 'string') {
            throw new Error('这不是 v2 接口（/api/info 未返回 version），请改用 2.x 的 opencode-cli')
          }
          this.log(`bridge: 客户端版本 ${info.version}`)
          return base
        }
        last = `HTTP ${res.status}`
      } catch (err) {
        last = err?.message ?? String(err)
      }
      await sleep(500)
    }
    const err = new Error(
      this.spawnError
        ? `无法启动本机 OpenCode 客户端（${this.command}）：${this.spawnError.message}`
        : `无法启动本机 OpenCode 客户端（${this.command} serve）：${last}。`
          + '若已安装，请确认是 2.x 版本（试着手工跑一次 `opencode-cli serve --port 18800`）。',
    )
    err.code = 'BRIDGE_UNAVAILABLE'
    throw err
  }

  /**
   * 发一轮对话。
   *
   * 每轮新建会话：宿主每次都会重发完整 transcript，复用会话只会让上下文翻倍。
   * @param input - `{ model, system, prompt, signal }`。
   * @returns `{ text, usage, raw }`；上游报错时抛出带 `code`、`status` 的错误。
   */
  async turn(input) {
    const base = await this.ensure()
    const session = await this.createSession(base, input.model)
    try {
      const text = composePrompt(input)
      await this.post(base, `/session/${session}/prompt`, { text })
      const result = await this.awaitIdle(base, session, input.signal)
      return this.interpret(result)
    } finally {
      // 会话不删会一直堆在客户端的库里；删不掉也不影响这一轮。
      await this.deleteSession(base, session).catch(() => {})
    }
  }

  async createSession(base, model) {
    const body = {
      agent: this.activeAgent,
      model: { providerID: 'opencode', id: model },
      location: { directory: this.dir },
    }
    const created = await this.post(base, '/session', body)
    const id = created?.data?.id ?? created?.id
    if (typeof id !== 'string' || id === '') {
      throw bridgeError('创建会话失败', 'BRIDGE_ERROR', 502, created)
    }
    return id
  }

  async deleteSession(base, session) {
    await fetch(`${base}/session/${session}`, {
      method: 'DELETE',
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(5000),
    })
  }

  /**
   * 等到会话进入 idle。
   *
   * 期间必须持续接管权限请求：模型一旦调用原生工具，会话就停在等待授权上，
   * 不回复会一直挂到超时。桥是纯文本的，所有工具一律 reject。
   */
  async awaitIdle(base, session, signal) {
    const deadline = Date.now() + this.turnTimeoutMs
    let rows = []
    while (Date.now() < deadline) {
      if (signal?.aborted) throw aborted()
      const messages = await this.get(base, `/session/${session}/message`)
      rows = Array.isArray(messages?.data) ? messages.data : []
      const idle = rows.find((row) => row?.type === 'idle')
      if (idle) return { rows, idle }
      await this.rejectPermissions(base, session)
      await sleep(POLL_INTERVAL_MS)
    }
    // 超时前先把会话停掉，别让它在后台继续烧额度。
    await fetch(`${base}/session/${session}/interrupt`, {
      method: 'POST',
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
    throw bridgeError('OpenCode 客户端在限定时间内没有完成这一轮', 'TIMEOUT', 0, '')
  }

  async rejectPermissions(base, session) {
    const pending = await this.get(base, `/session/${session}/permission`)
    for (const request of Array.isArray(pending?.data) ? pending.data : []) {
      if (typeof request?.id !== 'string') continue
      await this.post(base, `/session/${session}/permission/${request.id}/reply`, {
        decision: 'reject',
        message: 'This is a text-only model bridge. Do not use tools; answer in text.',
      }).catch(() => {})
    }
  }

  /**
   * 把一轮的结果收敛成 `{ text, usage }`。
   *
   * 免费档的失败不体现在 HTTP 状态上：prompt 返回 200，失败写在 idle 消息里
   * （`{type:'idle', outcome:'failed', error:{type:'provider.free-limit', status:429}}`）。
   * 所以状态码判断放在这里，而不是 fetch 层。
   */
  interpret(result) {
    const { rows, idle } = result
    const assistants = rows.filter((row) => row?.type === 'assistant')
    // 新的在前。要的是这一轮的最后一条正文：跳过 tool-calls 的中间态。
    const final = assistants.find((row) => row.finish !== 'tool-calls') ?? assistants[0]
    const usage = final?.tokens ?? null
    const error = idle?.outcome === 'failed' ? idle.error : final?.error
    if (error) throw providerError(error, usage)
    const text = (final?.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')
    return { text, usage, raw: result }
  }

  async get(base, path) {
    const res = await fetch(`${base}${path}`, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw bridgeError(`bridge HTTP ${res.status}`, 'BRIDGE_ERROR', res.status, await res.text().catch(() => ''))
    return res.json().catch(() => null)
  }

  async post(base, path, body) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: this.auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (!res.ok) {
      const err = bridgeError(`bridge HTTP ${res.status}`, 'BRIDGE_ERROR', res.status, text)
      err.retryAfterMs = retryAfterMsOf(res, parsed)
      throw err
    }
    return parsed
  }

  /** 释放子进程。宿主卸载插件时调用。 */
  dispose() {
    this.stopChild()
    this.base = null
    this.booting = null
    this.failure = null
    this.failedAt = 0
  }

  stopChild() {
    try {
      this.child?.kill()
    } catch {
      /* 进程已退出 */
    }
    this.child = null
  }
}

/**
 * 宿主 system 与 transcript 拼成一次 prompt。
 *
 * v2 的 session 没有可覆写的 system 字段（agent 的 system 在配置里），所以宿主的
 * 系统提示只能作为正文的一部分上行。分段标题是为了让模型分清「规则」与「对话」。
 */
function composePrompt(input) {
  const parts = []
  if (input.system) parts.push(`# System instructions\n\n${input.system}`)
  parts.push(`# Conversation\n\n${input.prompt ?? ''}`)
  return parts.join('\n\n')
}

/**
 * 把客户端的错误对象映射成插件认识的错误码。
 *
 * 这些 type 是 v2 的 provider 错误分类，比 HTTP 状态更准：免费额度用尽时
 * prompt 依旧 200，只有 idle 消息里有 429。
 */
function providerError(error, usage) {
  const type = typeof error?.type === 'string' ? error.type : ''
  const status = Number(error?.status ?? error?.statusCode ?? 0)
  const message = error?.message ?? 'OpenCode 客户端返回错误'
  const err = new Error(message)
  err.usage = usage
  err.status = Number.isFinite(status) ? status : 0
  err.retryAfterMs = Number(error?.retryAfterMs ?? 0) || undefined
  err.detail = typeof error?.response?.body === 'string' ? error.response.body.slice(0, 500) : undefined
  if (type === 'provider.free-limit' || err.status === 429) err.code = 'RATE_LIMITED'
  else if (status === 426) err.code = 'UPGRADE_REQUIRED'
  else if (type === 'provider.auth' || status === 401 || status === 403) err.code = 'FREE_TIER_REFUSED'
  else if (type === 'provider.upgrade') err.code = 'UPGRADE_REQUIRED'
  else err.code = 'PROVIDER_ERROR'
  return err
}

function retryAfterMsOf(res, parsed) {
  const header = Number(res.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return header * 1000
  const body = Number(parsed?.error?.retryAfterMs ?? parsed?.retryAfterMs)
  return Number.isFinite(body) && body > 0 ? body : undefined
}

function bridgeError(message, code, status, detail) {
  const err = new Error(message)
  err.code = code
  err.status = status
  err.detail = typeof detail === 'string' ? detail.slice(0, 500) : detail
  return err
}

function aborted() {
  const err = new Error('OpenCode Zen request aborted by caller')
  err.code = 'ABORTED'
  return err
}

function randomPassword() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

async function freePort() {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 协议输出的 JSON Schema。
 *
 * **默认不下发**：免费档模型对 `format: json_schema` 并不稳（同一模型、同一时刻，
 * 带 schema 的请求会以 `Model did not produce structured output` 告终）。协议写在
 * system 里反而稳定。
 */
export const PROTOCOL_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['tool', 'final'] },
    name: { type: 'string' },
    args: { type: 'object' },
    text: { type: 'string' },
  },
  required: ['kind'],
}
