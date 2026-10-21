// dsh-connect-opencode-free · 可选：把请求交给本机 OpenCode 客户端代发
//
// ⚠️ 默认关闭（bridgeMode: off）。本模块是**实验性备选**，不是必需路径。
//
// 它源于 2026-10-18 的一次误判：当时以为「同一时刻客户端 200、插件 429」说明网关在
// 识别发出者，于是造了这一层绕过。后来证明那个对照没控制住「额度会随时间消耗」——
// 客户端那次 200 恰好用掉了最后的余量。停手一段时间后，同一会话、同一模型、同一份
// 报文直连连打 8 次全部 200（scripts/probe-rate-limit.mjs），身份假设不成立。
//
// 保留它的理由：万一将来真的出现「客户端能过、插件不能」且已排除额度，这是唯一
// 可用的退路。代价必须清楚——客户端的工具集要原样留在报文里，宿主工具因此只能改走
// system 里的一段 JSON 协议，比原生 function-calling 弱。
//
// 用法上的两条硬要求（都踩过）：
//   1. 启动 serve 时必须设 NO_PROXY=127.0.0.1,localhost。本机有 HTTP_PROXY 却没有
//      no_proxy，连环回的请求都会被送进代理并回 401。
//   2. 启动失败要记住结论，否则每次请求都 fork 一个必败进程、还各等满 60 秒。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** serve 起来之前的等待上限；冷启动实测 5–15 秒。 */
const BOOT_TIMEOUT_MS = 60_000

/**
 * 找出可以启动的 `opencode` 命令。
 *
 * 不能只信 PATH。dsh 可能由桌面快捷方式、计划任务或另一个 shell 启动，那条环境
 * 里未必有 npm 的全局目录（Windows 上 `opencode` 装在 `%APPDATA%\npm`，靠
 * `npm install -g` 加进 PATH），于是 spawn 直接 ENOENT——而这个错误原先被 health
 * check 的 `fetch failed` 盖住，宿主只看到一句"无法启动本机客户端"，完全指不到
 * 真因上。
 *
 * 所以按「显式覆盖 → PATH → 常见安装位置」逐个试，每个候选都真的存在才算数。
 * @param override - 调用方指定的命令（`OPENCODE_BIN` / 构造参数）。
 * @returns 可用的命令字符串；一个都没有时返回 null。
 */
export function resolveCommand(override) {
  const tried = []
  const windows = process.platform === 'win32'
  const home = os.homedir()
  const candidates = [
    override,
    process.env.OPENCODE_BIN,
    windows ? 'opencode.cmd' : 'opencode',
    'opencode',
    // npm 全局前缀：装 CLI 的地方，也是 Windows 上最常见的漏网之鱼。
    windows ? path.join(process.env.APPDATA ?? '', 'npm', 'opencode.cmd') : null,
    windows ? path.join(process.env.APPDATA ?? '', 'npm', 'opencode') : null,
    path.join(home, '.opencode', 'bin', windows ? 'opencode.exe' : 'opencode'),
    path.join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ].filter(Boolean)

  for (const candidate of candidates) {
    const file = candidate.includes(path.sep) || candidate.includes('/')
      ? candidate
      // 裸命令名交给 PATH 自己解析（含 PATHEXT 在内的 Windows 解析规则）。
      : candidate
    if (file.includes(path.sep) || file.includes('/')) {
      if (fs.existsSync(file)) return file
      tried.push(file)
      continue
    }
    if (whichSync(file)) return file
    tried.push(`${file}（不在 PATH 中）`)
  }
  resolveCommand.tried = tried
  return null
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
 * 把宿主的 OpenAI 风格消息序列化成一段会话文本。
 *
 * 客户端只接受 `parts`（文本/文件），没有「assistant 上一步调用了什么工具」这种
 * 结构化位置，所以工具轮次只能写成文本。顺序即时间顺序，模型读得懂。
 * @param messages - 已经过 `serializeMessages` 规范化的消息数组。
 * @returns 会话文本；不含 system（那个单独走 `system` 字段）。
 */
export function transcriptOf(messages) {
  const lines = []
  for (const message of messages ?? []) {
    const role = message?.role
    const text = flatten(message?.content)
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
 * 客户端自带 49 个工具且必须留在报文里（否则 403），所以这里要显式禁掉它们，
 * 否则模型会去调 `bash`——那不是宿主的 bash，回调上来宿主执行不了。
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

/** 从客户端返回的 parts 里取出 assistant 正文。 */
function textOfParts(parts) {
  const chunks = []
  for (const part of parts ?? []) {
    if (part?.type === 'text' && typeof part.text === 'string') chunks.push(part.text)
  }
  return chunks.join('')
}

/**
 * 模型按协议给出的 JSON。
 *
 * `format: json_schema` 已经约束了形状，但模型仍可能在 JSON 外面裹一句散文
 * （实测出现过），所以这里再手工兜一次：从第一个 `{` 到最后一个 `}` 之间取。
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
 * 本机 `opencode serve` 的驱动者。
 *
 * 进程只起一次，之后所有请求复用。凭据是随机的，仅本机环回可见；serve 自带 Basic
 * 认证，端口不对外监听。
 */
export class OpenCodeBridge {
  /** @param options - `{ port, cwd, log, timeoutMs, command }`。 */
  constructor(options = {}) {
    this.port = options.port ?? 0
    this.cwd = options.cwd
    this.log = options.log ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.command = options.command ?? null
    this.commandOverride = options.command ?? null
    this.username = options.username ?? 'dsh'
    this.password = options.password ?? randomPassword()
    this.base = null
    this.child = null
    this.booting = null
    /** spawn 本身失败的原因；health check 的 `fetch failed` 会盖住它，所以单独留着。 */
    this.spawnError = null
    /**
     * 上一次启动失败的结论与时间。
     *
     * 没有这个，每次请求都会重新 fork 一个必定失败的进程，还要等满 60 秒——操作者
     * 看到的就是同一行报错连刷好几次（实测一次连续三条）。失败一次就够了：把结论
     * 记住，冷却期内直接把同一个错误再抛出去。
     */
    this.failedAt = 0
    this.failure = null
    this.failureCooldownMs = options.failureCooldownMs ?? 10 * 60_000
    this.bootTimeoutMs = options.bootTimeoutMs ?? BOOT_TIMEOUT_MS
  }

  get auth() {
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64')
  }

  /**
   * 确保 serve 在跑。
   * @returns 基地址；启动失败抛出 `code = 'BRIDGE_UNAVAILABLE'` 的错误。
   */
  async ensure() {
    if (this.base) return this.base
    // 刚失败过就不要再 fork 一次：同一个环境里的失败不会自己好，重来只是再等 60 秒。
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
        '找不到可执行的 opencode。请在「设置 → OpenCode 免费模型 → bridgeMode」改用 auto/on 之前先装好 OpenCode CLI 并确保它在 PATH 中；'
        + '也可以设置环境变量 OPENCODE_BIN 指向它的绝对路径。已尝试：' + tried.join('、'),
      )
      err.code = 'BRIDGE_UNAVAILABLE'
      throw err
    }
    const port = this.port || (await freePort())
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
    if (this.cwd) args.push('--cwd', this.cwd)
    const child = spawn(this.command, args, {
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: this.username,
        OPENCODE_SERVER_PASSWORD: this.password,
        // 系统代理会把连 127.0.0.1 的请求也送进代理（本机有 HTTP_PROXY 却没有
        // no_proxy），代理回 401，bridge 就永远起不来。
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stdio: 'ignore',
      // Windows 上 `opencode` 是 .cmd，没有 shell 找不到。
      shell: true,
    })
    // spawn 失败时 child 会 emit 'error'，而且**不会**自己退出。若不接住，它会变成
    // 一个 unhandled 'error' 把宿主进程带走；接住之后它也解释了后面 60 秒 health
    // check 为什么只会得到 `fetch failed`——因为要等的那个进程从来没起来。
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
        const res = await fetch(`${base}/global/health`, {
          headers: { Authorization: this.auth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          this.base = base
          this.failure = null
          this.failedAt = 0
          this.log(`bridge: opencode serve 就绪于 ${base}（${this.command}）`)
          return base
        }
        last = `HTTP ${res.status}`
      } catch (err) {
        last = err?.message ?? String(err)
      }
      await sleep(1000)
    }
    const err = new Error(
      this.spawnError
        ? `无法启动本机 OpenCode 客户端（${this.command}）：${this.spawnError.message}`
        : `无法启动本机 OpenCode 客户端（${this.command} serve）：${last}。`
          + '若 opencode 已安装，请确认它能在当前环境里启动（试着手工跑一次 `opencode serve`）。',
    )
    err.code = 'BRIDGE_UNAVAILABLE'
    throw err
  }

  /**
   * 发一轮对话。
   *
   * @param input - `{ model, system, messages, tools, maxTokens }`。
   * @returns `{ text, usage, raw }`；上游报错时抛出带 `code`、`status` 的错误。
   */
  async turn(input) {
    const base = await this.ensure()
    const session = await this.post(base, '/session', {})
    if (!session?.id) {
      throw bridgeError('创建会话失败', 'BRIDGE_ERROR', 502, session)
    }
    const body = {
      model: { providerID: 'opencode', modelID: input.model },
      parts: [{ type: 'text', text: input.prompt }],
    }
    if (input.system) body.system = input.system
    if (input.schema) body.format = { type: 'json_schema', schema: input.schema }
    // 不要动 `tools`：客户端默认那套工具是网关闸门的组成部分，收窄它会 403。
    const result = await this.post(base, `/session/${session.id}/message`, body)
    return this.interpret(result)
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
    if (!res.ok) throw bridgeError(`bridge HTTP ${res.status}`, 'BRIDGE_ERROR', res.status, text)
    return parsed
  }

  /**
   * 把客户端的响应收敛成 `{ text, usage, error }`。
   *
   * 响应形状随版本略有出入：1.18.x 的 `/session/:id/message` 回一个
   * `{ info, parts }` 对象，但也见过数组形式，两种都接。
   */
  interpret(result) {
    const node = Array.isArray(result) ? result[result.length - 1] : result
    const info = node?.info ?? node ?? {}
    const text = textOfParts(node?.parts ?? info?.parts)
    const usage = info?.tokens ?? null
    if (info?.error) {
      const data = info.error?.data ?? info.error
      const err = new Error(data?.message ?? 'OpenCode 客户端返回错误')
      err.code = data?.statusCode === 429 ? 'RATE_LIMITED' : data?.statusCode === 403 ? 'FREE_TIER_REFUSED' : 'PROVIDER_ERROR'
      err.status = data?.statusCode
      err.usage = usage
      throw err
    }
    return { text, usage, raw: result }
  }

  /** 释放子进程。宿主卸载插件时调用。 */
  dispose() {
    try {
      this.child?.kill()
    } catch {
      /* 进程已退出 */
    }
    this.child = null
    this.base = null
    this.booting = null
    this.failure = null
    this.failedAt = 0
  }
}

function bridgeError(message, code, status, detail) {
  const err = new Error(message)
  err.code = code
  err.status = status
  err.detail = typeof detail === 'string' ? detail.slice(0, 500) : detail
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
 * **默认不下发**。实测它在免费档模型上并不稳：同一模型、同一时刻，带 schema 的
 * 请求会以 `Model did not produce structured output` 告终（短 system 也照样失败），
 * 而只把协议写进 system、不开 `format` 的那一路，模型反而稳定输出了符合约定的
 * JSON。推测是 Zen 侧把 schema 转成了上游不支持的约束。
 *
 * 留在这里是因为 `OpenCodeBridge.turn()` 仍然接受它：换模型、或者将来网关修好，
 * 都可以再打开。放宽到最保守的关键字（`additionalProperties` 会额外触发上面的
 * 失败），且 {@link parseProtocol} 本来就容得下多余字段。
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
