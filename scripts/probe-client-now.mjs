// 自包含：启动真实 OpenCode 客户端发一轮，然后结束。
// 用来在任意时刻回答「此刻客户端还能不能用免费额度」。
import { spawn } from 'node:child_process'

const PORT = 7811
const USER = 'probe'
const PASS = 'probe1234'
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
const H = { 'content-type': 'application/json', Authorization: auth }
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
  env: { ...process.env, OPENCODE_SERVER_USERNAME: USER, OPENCODE_SERVER_PASSWORD: PASS },
  stdio: 'ignore',
  shell: true,
})
child.unref()

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: H })
    if (r.ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}

const s = await (await fetch(`http://127.0.0.1:${PORT}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })).json()
const t0 = Date.now()
const res = await fetch(`http://127.0.0.1:${PORT}/session/${s.id}/message`, {
  method: 'POST', headers: H, signal: AbortSignal.timeout(120000),
  body: JSON.stringify({
    model: { providerID: 'opencode', modelID: MODEL },
    parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }),
})
const text = await res.text()
const limit = /FreeUsageLimitError|Rate limit/.test(text)
const gate = /within OpenCode/.test(text)
const over = /exceeds the model window|futile round/.test(text)
const ok = !limit && !gate && !over
console.log(`真实客户端 ${MODEL} -> HTTP ${res.status} ${limit ? '[429 限流]' : gate ? '[403]' : over ? '[502 超窗]' : '[成功]'} (${Date.now() - t0}ms)`)
const out = (text.match(/"text":"(.*?)"/g) || []).slice(-1)
if (out.length) console.log('  回复:', out[0].slice(0, 80))
if (!ok) console.log('  ', (text.match(/"message":"([^"]*)"/) || [])[1]?.slice(0, 200))
process.exit(ok ? 0 : 1)
