// Probe: is the key wrong, or is the account behind it refused?
//
// `GET /models` answers 200 with no auth at all, so it proves nothing. What
// discriminates is whether Zen answers a *rejected* credential differently from
// an *accepted* one:
//
//   garbage key  -> 401/"invalid api key"  => the gateway does read the key,
//                    and our key's FreeTierError means it was ACCEPTED
//   garbage key  -> the same FreeTierError => the gateway is not reading the
//                    key on this route at all, and nothing about the key matters
//
// The control that matters most is `Bearer public` with the CLI disguise: that
// is the lane this plugin actually runs on, and if it now answers FreeTierError
// too then the refusal is global rather than about this operator's key.
//
// Run: node scripts/probe-key-discriminate.mjs <key>

const BASE = 'https://opencode.ai/zen/v1'
const KEY = process.argv[2]

if (!KEY) {
  console.error('usage: node scripts/probe-key-discriminate.mjs <key>')
  process.exit(1)
}

const fn = (name) => ({
  type: 'function',
  function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: {} } },
})

const UA_CLI = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const GATE = [fn('bash'), fn('read')]
const SESSION = 'ses_probe00000000000000000000'

async function chat(label, headers, tools) {
  const body = { model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: false }
  if (tools) body.tools = tools
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    let type = ''
    let message = ''
    try {
      type = JSON.parse(text)?.error?.type ?? ''
      message = JSON.parse(text)?.error?.message ?? ''
    } catch { /* not JSON */ }
    console.log(`${label.padEnd(52)} -> ${response.status} ${type} (${Date.now() - started}ms)`)
    if (message) console.log(`${''.padEnd(52)}    ${message.slice(0, 150)}`)
    return { status: response.status, type, message }
  } catch (error) {
    console.log(`${label.padEnd(52)} -> THREW ${error?.name}: ${error?.message}`)
    return { status: 0, type: '', message: String(error?.message) }
  }
}

console.log(`key under test: ${KEY.slice(0, 14)}…${KEY.slice(-4)}`)
console.log('')

// 1. Does the gateway tell a rejected credential apart from an accepted one?
console.log('--- does the gateway read the key at all? ---')
const garbage = await chat('garbage key (oc_sk_totally_invalid)', { Authorization: 'Bearer oc_sk_totally_invalid_key_value' })
const empty = await chat('empty bearer', { Authorization: 'Bearer ' })
const none = await chat('no Authorization header', {})
const real = await chat('the operator key', { Authorization: `Bearer ${KEY}` })
console.log('')

// 2. The lane this plugin actually runs on. If this is 200 the plugin works and
//    the key question is separate; if it is also FreeTierError the lane is closed
//    for everyone, which changes what the operator should do.
console.log('--- the plugin own lane, for comparison ---')
await chat('Bearer public + CLI UA + session + bash/read', {
  Authorization: 'Bearer public',
  'User-Agent': UA_CLI,
  'x-opencode-session': SESSION,
}, GATE)
await chat('Bearer public + gate tools, no UA/session', { Authorization: 'Bearer public' }, GATE)
console.log('')

// 3. Verdict.
console.log('--- reading ---')
if (garbage.type === 'FreeTierError' && real.type === 'FreeTierError') {
  console.log('A rejected key and the operator key get the SAME error, so this route does not')
  console.log('decide on the key. Nothing about the key value can be concluded from it — and no')
  console.log('change to the key will make chat/completions answer differently.')
} else if (garbage.type !== real.type) {
  console.log('The gateway answers a rejected key differently from the operator key, so it DOES')
  console.log('read the key: the operator key was accepted, and the FreeTierError is about the')
  console.log('account behind it, not about the credential.')
}
