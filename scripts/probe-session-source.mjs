// Probe: (a) can we read a REAL Zen session id from the local OpenCode db?
//        (b) does the gate need the real session AND the bash/read tools?
import { DatabaseSync } from 'node:sqlite'

const DB = 'C:/Users/user/.local/share/opencode/opencode.db'
const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

const db = new DatabaseSync(DB, { readOnly: true })
const rows = db.prepare('SELECT id, time_created FROM session ORDER BY time_created DESC LIMIT 5').all()
db.close()

console.log('=== 本地 OpenCode 库里最近的 session ===')
rows.forEach(r => console.log(`   ${r.id}   ${new Date(r.time_created).toISOString()}`))

const tools = [
  { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
]

async function probe(label, sid, withTools) {
  const body = {
    model: 'space-bunny-free',
    messages: [{ role: 'user', content: 'Reply exactly: OK' }],
    stream: true,
    max_tokens: 16,
    ...(withTools ? { tools, tool_choice: 'auto' } : {}),
  }
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-opencode-session': sid },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40000),
    })
    status = res.status
    detail = (await res.text().catch(() => '')).slice(0, 80)
  } catch (e) { detail = e?.message ?? String(e) }
  console.log(`${String(status).padEnd(5)} | ${label.padEnd(32)} | ${detail.replace(/\n/g, ' ')}`)
}

console.log('=== 2x2：真实 session × 有无 tools ===')
await probe('真实session(最新) + tools', rows[0].id, true)
await probe('真实session(最新) 无 tools', rows[0].id, false)
await probe('真实session(最旧) + tools', rows[rows.length - 1].id, true)
await probe('伪造session + tools', `ses_${'a'.repeat(26)}`, true)
