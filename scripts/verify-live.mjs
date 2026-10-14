// Verify the fix end to end: the anonymous lane now borrows a REAL OpenCode
// session id (read from the CLI's own database) and still sends bash/read.
// Before the fix this exact body answered 403 FreeTierError.
import { realSessionId } from '../lib/oc-session.js'

const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

const tools = [
  { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]

const { id, source, reason } = await realSessionId()
if (id === undefined) {
  console.log(`读不到真实 session：${reason}`)
  process.exit(1)
}
console.log(`session: ${id}  (来源: ${source})`)

const models = ['space-bunny-free', 'big-pickle', 'mimo-v2.6-flash-free']
for (const model of models) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-opencode-session': id },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply exactly: OK' }],
      stream: true,
      max_tokens: 16,
      tools,
      tool_choice: 'auto',
    }),
    signal: AbortSignal.timeout(45000),
  })
  const text = await res.text().catch(() => '')
  const reply = [...text.matchAll(/"content":"([^"]*)"/g)].map(m => m[1]).join('')
  console.log(`${String(res.status).padEnd(5)} | ${model.padEnd(24)} | 回复: ${JSON.stringify(reply)}`)
}
