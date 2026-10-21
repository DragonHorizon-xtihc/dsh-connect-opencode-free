// 最干净的 A/B：同一时刻、同一会话 id、同一模型，唯一变量是「谁发这个请求」。
//
//   A. 真实 OpenCode 客户端（Bun 内嵌 fetch，走它自己的请求构造）
//   B. Node fetch（undici）—— 插件宿主所用的通路
//
// 把 provider 的 baseURL 直接指向真实网关 https://opencode.ai/zen/v1，
// providerID 仍以 "opencode" 开头以走免费档分支，模型用 CLI 正在用的那个。
// 若 A 成功 B 429，则差异不在任何 header/body 字段，而在流量特征
// （TLS/JA3 指纹、undici 自动加的 sec-fetch-mode 等）——结论指向「让插件复用
// 本机客户端的通道」，而不是继续伪造头部。

import { spawn } from 'node:child_process'

const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const PORT = 7801
const USER = 'probe'
const PASS = 'probe1234'
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
const H = { 'content-type': 'application/json', Authorization: auth }

const CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  model: `opencode-real/${MODEL}`,
  provider: {
    'opencode-real': {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenCode Zen (real)',
      options: { baseURL: 'https://opencode.ai/zen/v1', apiKey: 'public' },
      models: { [MODEL]: { name: MODEL, limit: { context: 128000, output: 4096 } } },
    },
  },
}

const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
  env: {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(CONFIG),
    OPENCODE_SERVER_USERNAME: USER,
    OPENCODE_SERVER_PASSWORD: PASS,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  },
  stdio: 'ignore',
  shell: true,
})
child.unref()

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: H })
      if (r.ok) return await r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('serve 未就绪')
}

let sessionId = null
try {
  await waitReady()
  const created = await fetch(`http://127.0.0.1:${PORT}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })
  const session = await created.json()
  sessionId = session.id
  console.log('session:', sessionId)

  const res = await fetch(`http://127.0.0.1:${PORT}/session/${sessionId}/message`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: { providerID: 'opencode-real', modelID: MODEL },
      parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
    }),
  })
  const text = await res.text()
  const err = text.match(/"error":\{[^}]*"message":"([^"]*)"[^}]*"statusCode":(\d+)/)
  const ok = text.match(/"text":"(.*?)"/)
  console.log('\n### A 真实 OpenCode 客户端 ->', err ? `HTTP ${err[2]} ${err[1]}` : (ok ? `成功，回复=${ok[1].slice(0, 40)}` : '未知'))
  if (err) console.log('   ', text.slice(0, 400))
} catch (e) {
  console.log('A ERR', e.message)
}

// B：同一会话 id、同一模型、同一组头，改由 Node fetch 发出
if (sessionId) {
  const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })
  const payload = {
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    max_tokens: 4096,
    stream: true,
    stream_options: { include_usage: true },
    tool_choice: 'auto',
    tools: [fn('bash'), fn('read')],
  }
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer public',
      'User-Agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      'x-opencode-client': 'cli',
      'x-opencode-project': '17c2c713b7bee7b3305512caa4c4ff1c34588a64',
      'x-opencode-request': 'msg_14af12e0f001I2lVqU5iaRrBja',
      'x-opencode-session': sessionId,
      'x-opencode-session-id': sessionId,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  })
  const body = await res.text()
  console.log('\n### B Node fetch（复刻真实报文）-> HTTP', res.status)
  console.log('   retry-after:', res.headers.get('retry-after'), '| body:', body.slice(0, 200).replace(/\n/g, ' '))
}
process.exit(0)
