// Probe: why does a real key get answered with FreeTierError?
//
// The operator pasted a key from opencode.ai/zen and the check answered
// HTTP 403 FreeTierError. That error is documented as the *anonymous* free lane
// refusing a caller, so a key being answered with it means one of:
//   A. the key is not what the probe thinks it is (revoked, mistyped, wrong kind)
//   B. Zen applies the free-tier gate to keyed requests on this route too
//   C. the probe is missing a signal the gateway wants before it looks at auth
// Each case below varies exactly one of those, so the answer is which one.
//
// Run: node scripts/probe-key-403.mjs <key>

const BASE = 'https://opencode.ai/zen/v1'
const KEY = process.argv[2]

if (!KEY) {
  console.error('usage: node scripts/probe-key-403.mjs <key>')
  process.exit(1)
}

// A shape-correct stand-in. Only used where a session id is required at all;
// the point of those cases is whether the id is consulted when a key is present.
const SESSION = 'ses_probe00000000000000000000'

const fn = (name) => ({
  type: 'function',
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  },
})

const UA_CLI = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

/** POST one chat completion and report the verdict without throwing. */
async function chat(label, headers, tools) {
  const body = {
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  }
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
    const ms = Date.now() - started
    let type = ''
    try { type = JSON.parse(text)?.error?.type ?? '' } catch { /* not JSON */ }
    console.log(`${label.padEnd(46)} -> ${response.status} ${type} (${ms}ms) ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    return response.status
  } catch (error) {
    console.log(`${label.padEnd(46)} -> THREW ${error?.name}: ${error?.message}`)
    return 0
  }
}

/** GET the model list with the key; a 200 here proves the key authenticates. */
async function models(label, headers) {
  const started = Date.now()
  try {
    const response = await fetch(`${BASE}/models`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    console.log(`${label.padEnd(46)} -> ${response.status} (${Date.now() - started}ms) ${text.slice(0, 120).replace(/\s+/g, ' ')}`)
    return response.status
  } catch (error) {
    console.log(`${label.padEnd(46)} -> THREW ${error?.name}: ${error?.message}`)
    return 0
  }
}

console.log(`key: ${KEY.slice(0, 12)}…${KEY.slice(-4)}  (${KEY.length} chars, prefix ${KEY.slice(0, 6)})`)
console.log('')

// The key's own shape is the first thing to rule out: OpenCode Zen keys start
// with `oc_sk_`, and a truncated or mistyped one is a 401/403 with no useful body.
console.log('--- what the key authenticates against ---')
await models('GET /models  (Bearer key)', { Authorization: `Bearer ${KEY}` })
await models('GET /models  (no auth)', {})
await models('GET /models  (Bearer public)', { Authorization: 'Bearer public' })
console.log('')

console.log('--- chat/completions with the key, varying one signal at a time ---')
await chat('A key only (what the probe sends today)', { Authorization: `Bearer ${KEY}` })
await chat('B key + CLI User-Agent', { Authorization: `Bearer ${KEY}`, 'User-Agent': UA_CLI })
await chat('C key + x-opencode-session', { Authorization: `Bearer ${KEY}`, 'x-opencode-session': SESSION })
await chat('D key + UA + session', { Authorization: `Bearer ${KEY}`, 'User-Agent': UA_CLI, 'x-opencode-session': SESSION })
await chat('E key + UA + session + bash/read tools', { Authorization: `Bearer ${KEY}`, 'User-Agent': UA_CLI, 'x-opencode-session': SESSION }, [fn('bash'), fn('read')])
await chat('F key, no Content-Type', { Authorization: `Bearer ${KEY}` })
console.log('')

console.log('--- is it the model, or the account? ---')
await chat('G key on a second model (grok-code)', { Authorization: `Bearer ${KEY}` })
await chat('H key with max_tokens=1', { Authorization: `Bearer ${KEY}` })
