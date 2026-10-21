// 同一个请求，用 Bun 的 fetch 发一次。
// 目的：验证「差异在运行时」这一假设 —— 若 Bun 200 而 Node 429，
// 说明网关按客户端指纹（TLS/HTTP 栈）而非 IP/头部来区分「来源」。
const BASE = 'https://opencode.ai/zen/v1'
const SESSION = process.env.PROBE_SESSION ?? 'ses_eb55ed479ffeNn2TADfgda0RAB'
const PROJECT = '17c2c713b7bee7b3305512caa4c4ff1c34588a64'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'

const fn = (name) => ({
  type: 'function',
  function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } },
})

const res = await fetch(`${BASE}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer public',
    'User-Agent': 'opencode/1.18.35',
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-opencode-project': PROJECT,
    'x-opencode-request': 'msg_14aa168da001Qc4Zx6inM0vfeC',
    'x-opencode-client': 'desktop',
  },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 32,
    tools: [fn('bash'), fn('read')],
    tool_choice: 'auto',
  }),
})

const interesting = {}
for (const [k, v] of res.headers) if (/ratelimit|retry|limit|x-/i.test(k)) interesting[k] = v
const text = await res.text()
console.log(`Bun fetch -> HTTP ${res.status}`)
console.log('headers:', JSON.stringify(interesting))
console.log('body:', text.slice(0, 300))
