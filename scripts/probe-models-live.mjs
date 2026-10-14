// Probe: which cached free models actually serve on the anonymous lane now.
// The browser picks from a cached catalog, and that cache is older than
// GET /models — a model that left the free tier (or was renamed) would answer
// 403 FreeTierError on every call even with a real session and bash/read.
import { readFileSync } from 'node:fs'
import { realSessionId } from '../lib/oc-session.js'

const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

const catalog = JSON.parse(readFileSync('E:/UserAgentData/.dsh/cache/opencode-zen-catalog.json', 'utf8'))
const models = (catalog.catalog ?? catalog).map(m => m.id).filter(Boolean)

const { id: SID, reason } = await realSessionId()
if (SID === undefined) { console.log('读不到真实 session:', reason); process.exit(1) }
console.log(`session: ${SID}\n`)

const tools = [
  { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]

for (const model of models) {
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-opencode-session': SID, Authorization: 'Bearer public' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply exactly: OK' }], stream: true, max_tokens: 16, tools, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(45000),
    })
    status = res.status
    const text = await res.text().catch(() => '')
    detail = /FreeTierError/.test(text) ? 'FreeTierError' : /"content":"([^"]*)"/.test(text) ? 'OK' : text.slice(0, 60).replace(/\n/g, ' ')
  } catch (e) { detail = e?.message ?? String(e) }
  console.log(`${String(status).padEnd(5)} | ${model.padEnd(34)} | ${detail}`)
}
