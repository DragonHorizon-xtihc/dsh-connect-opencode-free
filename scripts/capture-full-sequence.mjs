// 抓「真实 OpenCode 客户端」从启动到发出对话的**全部** HTTP 请求。
//
// 之前的捕获只记到了两条 chat/completions —— 因为捕获服务器是在 serve 已经跑起来
// 之后才接管的，启动阶段（拉模型、注册之类）的请求全漏了。
//
// 怀疑点：如果客户端在对话之前先打一个请求，服务端据此建立某种记账/绑定，那么
// 单发一条 chat 的插件就永远对不上账——这能解释「同一时刻客户端 200、插件 429」
// 而所有应用层字段又都一致。
//
// 用法：node scripts/capture-full-sequence.mjs

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

const OUT = path.resolve('.tmp_sequence.jsonl')
try { fs.unlinkSync(OUT) } catch {}

const CAPTURE_PORT = 8899
const records = []

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const rec = { at: Date.now(), method: req.method, url: req.url, headers: req.headers, body: body.slice(0, 4000) }
    records.push(rec)
    fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
    console.log(`<< ${req.method} ${req.url}  (${body.length}B)`)

    if (req.url?.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const chunk = (delta, finish) => `data: ${JSON.stringify({
        id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
        model: 'probe-model', choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      })}\n\n`
      res.write(chunk({ role: 'assistant', content: 'captured' }))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model', created: 0, owned_by: 'probe' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
})

await new Promise((r) => server.listen(CAPTURE_PORT, '127.0.0.1', r))
console.log(`捕获服务器就绪 127.0.0.1:${CAPTURE_PORT}`)

const PORT = 7841
const USER = 'probe'
const PASS = 'probe1234'
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
const H = { 'content-type': 'application/json', Authorization: auth }

const CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  model: 'opencode-probe/probe-model',
  provider: {
    'opencode-probe': {
      npm: '@ai-sdk/openai-compatible',
      name: 'probe',
      options: { baseURL: `http://127.0.0.1:${CAPTURE_PORT}/v1`, apiKey: 'public' },
      models: { 'probe-model': { name: 'probe-model', limit: { context: 128000, output: 4096 } } },
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

let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: H })
    if (r.ok) { ready = true; break }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('serve ready:', ready)

if (ready) {
  const s = await (await fetch(`http://127.0.0.1:${PORT}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })).json()
  console.log('session:', s.id)
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/session/${s.id}/message`, {
      method: 'POST', headers: H, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ model: { providerID: 'opencode-probe', modelID: 'probe-model' }, parts: [{ type: 'text', text: 'hi' }] }),
    })
    await res.text()
  } catch (e) {
    console.log('message 超时/失败:', e.message)
  }
}

await new Promise((r) => setTimeout(r, 1500))
server.close()

console.log(`\n=== 共捕获 ${records.length} 个请求 ===`)
for (const [i, r] of records.entries()) {
  console.log(`\n[${i}] ${r.method} ${r.url}`)
  const interesting = {}
  for (const [k, v] of Object.entries(r.headers)) {
    if (/^(x-|authorization|user-agent|cookie|referer|origin)/i.test(k)) interesting[k] = v
  }
  console.log('  headers:', JSON.stringify(interesting))
  if (r.body) console.log('  body:', r.body.slice(0, 300).replace(/\n/g, ' '))
}
process.exit(0)
