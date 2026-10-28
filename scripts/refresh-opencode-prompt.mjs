// 刷新 lib/opencode-system-prompt.txt（2026-10-27）。
//
// 为什么需要它：Zen 免费档要求请求的 system 完整包含 OpenCode 官方提示词，
// 而这份提示词随 OpenCode 版本变化。升级 OpenCode 之后若发现又开始 429，
// 第一件事就是跑这个脚本重新取样（见 lib/zen-prompt.js 顶部）。
//
// 做法：把 OpenCode 的 provider baseURL 临时指到本地，让它把真实请求发过来，
// 取出 system 后**立刻回一个假的 200 SSE**。
// ⚠️ 关键：不转发到上游，所以这一趟**不消耗免费额度**。
//
// 用法：node scripts/refresh-opencode-prompt.mjs
//   可选 OPENCODE_CLI=<opencode-cli 路径> 覆盖自动发现结果。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../lib/opencode-system-prompt.txt', import.meta.url))
const PORT = 18081
/** 必须显式指定：不指定时 CLI 会用用户默认模型，那条路根本不经过这里的 baseURL。 */
const MODEL = 'opencode/deepseek-v4.1-flash-free'
/**
 * 采纳门槛。
 *
 * 完整提示词约 5.5 万字符；标题/摘要类小请求的 system 只有一两千。用长度把它们
 * 分开，比匹配具体措辞稳——官方换个句子不会让这里失效。
 */
const MIN_PROMPT_CHARS = 20_000
/** 见过的最长 system，用于超时时给出诊断。 */
let longest = ''
const TIMEOUT_MS = 180_000

/** OpenCode CLI 的候选路径，和 lib/zen-egress.js 保持同一套判断。 */
function findCli() {
  const win = process.platform === 'win32'
  const list = [
    process.env.OPENCODE_CLI,
    win && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'OpenCode', 'resources', 'opencode-cli.exe') : undefined,
    win ? 'C:\\Program Files\\OpenCode\\resources\\opencode-cli.exe' : undefined,
    '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
    '/opt/OpenCode/resources/opencode-cli',
    '/usr/lib/opencode/resources/opencode-cli',
  ].filter(Boolean)
  return list.find((p) => existsSync(p))
}

const cli = findCli()
if (!cli) {
  console.error('找不到 opencode-cli。请用 OPENCODE_CLI=<路径> 指定，或先安装 OpenCode。')
  process.exit(1)
}
console.log('使用 OpenCode CLI：', cli)

let settled = false
/** 子进程句柄；`finish` 与 `listen` 回调都要用，必须在它们之前声明。 */
let child
function finish(code, message) {
  if (settled) return
  settled = true
  if (message) console.log(message)
  try { child?.kill() } catch { /* ignore */ }
  server.close()
  setTimeout(() => process.exit(code), 50)
}

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let system
    try {
      const body = JSON.parse(raw)
      system = (body.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    } catch {
      /* 不是 JSON 就忽略 */
    }
    if (!system) {
      // /models 之类的非对话请求：直接给个空 200，让 CLI 继续走。
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
      return
    }

    // 一轮对话会先发几个小请求（会话标题、摘要），它们的 system 只有一两千字符。
    // 采信它们会把 54 KB 的完整提示词换成一份残篇，网关照样 429，所以只接受
    // 主请求那一份；其余照常回假响应，让 CLI 继续往下走。
    console.log('  收到请求：system %d 字符，messages %d 条', system.length, (JSON.parse(raw).messages ?? []).length)
    if (system.length < MIN_PROMPT_CHARS) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      res.end()
      if (system.length > longest.length) longest = system
      return
    }

    writeFileSync(OUT, system)
    console.log(`已写入 ${OUT}\n  长度 ${system.length} 字符\n  开头：${system.slice(0, 80)}`)
    // 回一个最小的合法 SSE，让 CLI 认为这一轮成功了；不转发上游，不耗额度。
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
    finish(0)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  // 隔离配置：不碰用户全局设置，也不加载他的 MCP / 插件。
  const cfgDir = join(tmpdir(), 'oc-prompt-refresh')
  mkdirSync(join(cfgDir, 'opencode'), { recursive: true })
  writeFileSync(join(cfgDir, 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      opencode: { options: { baseURL: `http://127.0.0.1:${PORT}/inference/openai/v1` } },
    },
  }, null, 2))

  // `--serve`：只起服务，由操作者在自己的终端里跑 CLI。
  // 有些环境下 CLI 需要 TTY，被 Node spawn 后会一直不出声，这时用它。
  if (process.argv.includes('--serve')) {
    const quote = (v) => `'${v}'`
    console.log('\n取样服务已就绪（不会把请求发往上游，不消耗额度）。')
    console.log('请另开一个终端执行下面这条，完成后本进程会自动退出：\n')
    console.log(
      `$env:XDG_CONFIG_HOME=${quote(cfgDir)}; $env:XDG_DATA_HOME=${quote(join(cfgDir, 'data'))}; `
      + `$env:NO_PROXY='127.0.0.1'; & ${quote(cli)} run --standalone -m ${MODEL} "reply with exactly: OK"`,
    )
    setTimeout(() => finish(1, '超时：没有收到带 system 的请求。'), TIMEOUT_MS).unref?.()
    return
  }

  console.log('启动 OpenCode 取样（不会发往上游）…')
  child = spawn(cli, ['run', '--standalone', '-m', MODEL, 'reply with exactly: OK'], {
    env: (() => {
      const env = {
        ...process.env,
        XDG_CONFIG_HOME: cfgDir,
        // 数据目录也隔离：本机 OpenCode 桌面版通常正开着，共用 opencode.db 会卡在
        // 写锁上。取样只关心 system 的形状，不需要真实会话，所以隔离更稳。
        XDG_DATA_HOME: join(cfgDir, 'data'),
      }
      // 代理要保留（CLI 启动时还要拉模型目录，某些网络下必须靠它），
      // 但本机回环必须绕过，否则取样请求会被塞进代理，永远到不了这里。
      env.NO_PROXY = ['127.0.0.1', 'localhost', env.NO_PROXY].filter(Boolean).join(',')
      env.no_proxy = env.NO_PROXY
      return env
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-1500) })
  child.stdout.resume()
  child.on('exit', (code) => {
    // 正常情况下 finish(0) 已经先跑了；走到这里说明没抓到 system。
    finish(1, `CLI 提前退出（code=${code}），没抓到 system。${stderr ? `\n${stderr}` : ''}`)
  })

  setTimeout(() => finish(1, `超时：没有收到带 system 的请求。${stderr ? `\nCLI 输出：\n${stderr}` : '（CLI 没有任何输出，可能卡在等 TTY；改用 --serve 手工取样）'}`), TIMEOUT_MS).unref?.()
})
