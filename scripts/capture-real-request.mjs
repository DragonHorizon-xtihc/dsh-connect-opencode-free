// 抓取真实 OpenCode 客户端发出的完整明文报文（headers + body）。
//
// 做法（不改动用户配置）：
//   1. 本地起一个明文 HTTP 服务器（scripts/capture-cli-request.mjs，端口 8899），
//      它记录每个请求的全部 headers/body 并回一个合法的 OpenAI SSE 响应。
//   2. 用 OPENCODE_CONFIG_CONTENT 注入一个 baseURL 指向 8899 的 provider，
//      再启动真实 `opencode serve`，通过它的 HTTP API 触发一次会话消息。
//   3. 客户端会照常走它自己的请求构造逻辑 —— 捕获到的就是「能过免费档闸门」的真实形状。
//
// 本脚本负责第 2、3 步，并打印捕获结果。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve(process.argv[2] ?? '.tmp_capture.jsonl')
try { fs.unlinkSync(OUT) } catch {}

const CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  // 关键：providerID 必须以 "opencode" 开头。
  // 客户端里是 `input.model.providerID.startsWith("opencode")` 决定走哪条分支：
  //   真 → 发 x-opencode-session/project/request/client（免费档闸门那一套）
  //   假 → 只发 x-session-affinity / X-Session-Id（普通 OpenAI 兼容分支）
  // 我们要抓的是前者，所以这里必须叫 opencode-*。
  model: 'opencode-probe/probe-model',
  provider: {
    'opencode-probe': {
      npm: '@ai-sdk/openai-compatible',
      name: 'Probe',
      options: { baseURL: 'http://127.0.0.1:8899/v1', apiKey: 'public' },
      models: {
        'probe-model': { name: 'Probe Model', limit: { context: 128000, output: 4096 } },
      },
    },
  },
}

const PORT = 7799
const USER = 'probe'
const PASS = 'probe1234'
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')

const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG),
    OPENCODE_SERVER_USERNAME: USER,
    OPENCODE_SERVER_PASSWORD: PASS,
    // 关键：系统设了 HTTP_PROXY 但没有 no_proxy，客户端会把连 127.0.0.1:8899 的
    // 请求也送进代理，代理回 401 `Basic realm="Secure Area"` —— 这是上一轮捕获
    // 失败的原因。放行环回地址后才能抓到明文报文。
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
let log = ''
child.stdout.on('data', (c) => { log += c })
child.stderr.on('data', (c) => { log += c })

const H = { 'content-type': 'application/json', Authorization: auth }

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: H })
      if (r.ok) return await r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('serve 未就绪:\n' + log)
}

try {
  const health = await waitReady()
  console.log('serve ready:', JSON.stringify(health))

  const created = await fetch(`http://127.0.0.1:${PORT}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })
  const session = await created.json()
  console.log('session:', session.id)

  const res = await fetch(`http://127.0.0.1:${PORT}/session/${session.id}/message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: { providerID: 'opencode-probe', modelID: 'probe-model' },
      parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
    }),
  })
  const text = await res.text()
  console.log('message ->', res.status)
  if (/error/i.test(text)) console.log('resp:', text.slice(0, 800))
} catch (e) {
  console.log('ERR', e.message)
} finally {
  // Windows + shell:true 时 kill 会波及父进程，直接让它随主进程退出即可。
  child.unref()
}

console.log('\n=== CAPTURED ===')
try {
  const raw = fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)
  console.log('records:', raw.length)
  for (const line of raw) {
    const rec = JSON.parse(line)
    console.log(`\n--- ${rec.method} ${rec.url} HTTP/${rec.httpVersion} ---`)
    console.log('headers:', JSON.stringify(rec.headers, null, 1))
    let parsed = null
    try { parsed = JSON.parse(rec.body) } catch {}
    if (parsed) {
      const { messages, tools, ...rest } = parsed
      console.log('body(除 messages/tools):', JSON.stringify(rest))
      console.log('messages:', JSON.stringify((messages ?? []).map((m) => ({ role: m.role, len: String(m.content ?? JSON.stringify(m.content)).length, keys: Object.keys(m) }))))
      console.log('tools:', JSON.stringify((tools ?? []).map((t) => t?.function?.name ?? t?.name ?? '?')))
    } else {
      console.log('body:', rec.body.slice(0, 1500))
    }
  }
} catch (e) {
  console.log('(无捕获)', e.message)
  console.log('--- serve log ---\n' + log.slice(-3000))
}
