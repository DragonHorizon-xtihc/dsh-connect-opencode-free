// Probe: is the session id the gate, and does a key bypass it?
//
// Established by probe-key-discriminate: a garbage key, an empty bearer, no auth
// at all, and the operator's real key ALL get the same FreeTierError, while
// `Bearer public` with a REAL session id gets 200. So the credential is not what
// this route decides on.
//
// The remaining question is the one that decides the fix: with a REAL session id
// in place, does the operator's key get through? If yes, the key is fine and the
// probe was simply missing the signal the gateway wants before it looks at auth
// — which is also true of every keyed request the plugin makes.
//
// Run: node scripts/probe-key-real-session.mjs <key>

import { realSessionId } from '../lib/oc-session.js'

const BASE = 'https://opencode.ai/zen/v1'
const KEY = process.argv[2]

if (!KEY) {
  console.error('usage: node scripts/probe-key-real-session.mjs <key>')
  process.exit(1)
}

const fn = (name) => ({
  type: 'function',
  function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: {} } },
})
const UA_CLI = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const GATE = [fn('bash'), fn('read')]

const { id: session, source } = await realSessionId()
if (session === undefined) {
  console.log('读不到真实 session，无法完成对照')
  process.exit(1)
}
console.log(`真实 session: ${session}  (来源: ${source})`)
console.log(`key: ${KEY.slice(0, 14)}…${KEY.slice(-4)}`)
console.log('')

async function chat(label, headers, tools, stream = false) {
  const body = { model: 'big-pickle', messages: [{ role: 'user', content: 'Reply exactly: OK' }], max_tokens: 16, stream }
  if (tools) { body.tools = tools; body.tool_choice = 'auto' }
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    const reply = stream ? [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('') : text.slice(0, 100)
    let type = ''
    try { type = JSON.parse(text)?.error?.type ?? '' } catch { /* not JSON */ }
    console.log(`${label.padEnd(50)} -> ${response.status} ${type} (${Date.now() - started}ms) ${JSON.stringify(reply).slice(0, 90)}`)
    return response.status
  } catch (error) {
    console.log(`${label.padEnd(50)} -> THREW ${error?.name}: ${error?.message}`)
    return 0
  }
}

console.log('--- same body, only the credential differs, real session throughout ---')
await chat('Bearer public  (the plugin lane, control)', {
  Authorization: 'Bearer public', 'User-Agent': UA_CLI, 'x-opencode-session': session,
}, GATE, true)
await chat('Bearer <operator key>', {
  Authorization: `Bearer ${KEY}`, 'User-Agent': UA_CLI, 'x-opencode-session': session,
}, GATE, true)
await chat('Bearer <operator key>, no gate tools', {
  Authorization: `Bearer ${KEY}`, 'User-Agent': UA_CLI, 'x-opencode-session': session,
}, undefined, true)
await chat('Bearer <operator key>, no UA, no session', { Authorization: `Bearer ${KEY}` }, GATE, true)
console.log('')

console.log('--- and the reverse: public lane with a FAKE session, for symmetry ---')
await chat('Bearer public + fake session', {
  Authorization: 'Bearer public', 'User-Agent': UA_CLI, 'x-opencode-session': 'ses_probe00000000000000000000',
}, GATE, true)
