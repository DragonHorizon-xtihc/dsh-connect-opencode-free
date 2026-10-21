// 你那把 Key 到底有没有额度？
//
// 背景：插件直连带这把 Key 得到 429，keycheck 把它记成「额度已用尽」。但如果 429
// 是「发出者身份」的伪装，那么这条诊断本身就是错的——Key 可能好得很，只是插件
// 被判成非客户端。
//
// 分辨方法：同一把 Key，改由真实 OpenCode 客户端发出去。
//   200 → Key 有额度，问题只在出网身份（那「用自己的 Key」也得走 bridge）
//   429 → 这个账号的额度确实用尽
//
// 用法：node scripts/probe-key-via-client.mjs <api-key> [模型]

import { spawn } from 'node:child_process'

const KEY = process.argv[2] ?? process.env.OPENCODE_API_KEY
const MODEL = process.argv[3] ?? 'deepseek-v4.1-flash-free'

if (!KEY) {
  console.log('缺少 api key：node scripts/probe-key-via-client.mjs <api-key>')
  process.exit(1)
}

const PORT = 7831
const USER = 'probe'
const PASS = 'probe1234'
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')
const H = { 'content-type': 'application/json', Authorization: auth }

const CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  model: `opencode-keyed/${MODEL}`,
  provider: {
    'opencode-keyed': {
      npm: '@ai-sdk/openai-compatible',
      name: 'OpenCode Zen (keyed)',
      options: { baseURL: 'https://opencode.ai/zen/v1', apiKey: KEY },
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

let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/global/health`, { headers: H })
    if (r.ok) { ready = true; break }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000))
}
if (!ready) {
  console.log('serve 未就绪')
  process.exit(1)
}

const s = await (await fetch(`http://127.0.0.1:${PORT}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })).json()
const t0 = Date.now()
const res = await fetch(`http://127.0.0.1:${PORT}/session/${s.id}/message`, {
  method: 'POST', headers: H, signal: AbortSignal.timeout(180000),
  body: JSON.stringify({
    model: { providerID: 'opencode-keyed', modelID: MODEL },
    parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }),
})
const text = await res.text()
const limit = /FreeUsageLimitError|Rate limit/.test(text)
const gate = /within OpenCode/.test(text)
const authErr = /AuthError|Invalid API key|401/.test(text)
const out = (text.match(/"text":"(.*?)"/g) || []).slice(-1)

console.log(`Key + 真实客户端 -> HTTP ${res.status} (${Date.now() - t0}ms)`)
if (out.length) console.log('  回复:', out[0].slice(0, 60))
if (limit) console.log('  [429] 这个账号的额度确实用尽')
else if (gate) console.log('  [403] 闸门（不是额度问题）')
else if (authErr) console.log('  [认证失败] Key 无效')
else if (res.status === 200) console.log('  [200] Key 有额度，问题只在「谁发出的」')
else console.log('  ', text.slice(0, 300).replace(/\n/g, ' '))
process.exit(0)
