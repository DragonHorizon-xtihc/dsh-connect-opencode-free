// Probe: does Zen's anonymous free-tier gate still require bash/read tool stubs?
// Re-verified today because the user is repeatedly hitting stub tool calls.
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const BASE = 'https://opencode.ai/zen/v1'
const MODEL = 'big-pickle'

import { createHash } from 'node:crypto'

function session(seed) {
  // canonical: ses_ + 26 chars
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

const fn = (name) => ({
  type: 'function',
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  },
})

const cases = [
  ['no stubs (real tool only)', [fn('get_weather')]],
  ['bash only', [fn('get_weather'), fn('bash')]],
  ['read only', [fn('get_weather'), fn('read')]],
  ['bash + read', [fn('get_weather'), fn('bash'), fn('read')]],
  ['bash + read renamed? (foo,bar)', [fn('get_weather'), fn('foo'), fn('bar')]],
]

for (const [label, tools] of cases) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 32,
    tools,
    tool_choice: 'auto',
  }
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': UA,
        'x-opencode-session': session('probe-' + label),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    })
    status = res.status
    detail = (await res.text().catch(() => '')).slice(0, 160)
  } catch (e) {
    detail = e?.message ?? String(e)
  }
  console.log(`${String(status).padEnd(5)} | ${label.padEnd(30)} | ${detail.replace(/\n/g, ' ')}`)
}
