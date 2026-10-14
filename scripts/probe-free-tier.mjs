// Probe: which part of Zen's anonymous free-tier gate rejects us now?
// 2026-10-11 verified: UA + x-opencode-session + bash/read tools => 200.
// 2026-10-13: the same body answers 403 FreeTierError, so one of the three
// signals stopped being accepted. Vary one at a time to find which.
const BASE = 'https://opencode.ai/zen/v1'
const MODEL = 'big-pickle'

import { createHash } from 'node:crypto'

function session(seed) {
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

const UA_CURRENT = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const GATE_TOOLS = [fn('get_weather'), fn('bash'), fn('read')]

// Each case: [label, headers overrides, tools]
const cases = [
  ['A baseline (UA + session + bash/read)', { 'User-Agent': UA_CURRENT, 'x-opencode-session': session('c-A') }, GATE_TOOLS],
  ['B no User-Agent', { 'x-opencode-session': session('c-B') }, GATE_TOOLS],
  ['C no x-opencode-session', { 'User-Agent': UA_CURRENT }, GATE_TOOLS],
  ['D no tools at all', { 'User-Agent': UA_CURRENT, 'x-opencode-session': session('c-D') }, undefined],
  ['E UA opencode/1.19.0', { 'User-Agent': 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', 'x-opencode-session': session('c-E') }, GATE_TOOLS],
  ['F UA opencode/1.20.0', { 'User-Agent': 'opencode/1.20.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', 'x-opencode-session': session('c-F') }, GATE_TOOLS],
  ['G UA opencode/1.22.0', { 'User-Agent': 'opencode/1.22.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', 'x-opencode-session': session('c-G') }, GATE_TOOLS],
  ['H UA bare "opencode"', { 'User-Agent': 'opencode', 'x-opencode-session': session('c-H') }, GATE_TOOLS],
  ['I short session (ses_abc)', { 'User-Agent': UA_CURRENT, 'x-opencode-session': 'ses_abc' }, GATE_TOOLS],
  ['J no auth header', { 'User-Agent': UA_CURRENT, 'x-opencode-session': session('c-J') }, GATE_TOOLS],
]

for (const [label, headers, tools] of cases) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 32,
    ...(tools === undefined ? {} : { tools, tool_choice: 'auto' }),
  }
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(label.startsWith('J') ? {} : { Authorization: 'Bearer public' }),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    })
    status = res.status
    detail = (await res.text().catch(() => '')).slice(0, 120)
  } catch (e) {
    detail = e?.message ?? String(e)
  }
  console.log(`${String(status).padEnd(5)} | ${label.padEnd(38)} | ${detail.replace(/\n/g, ' ')}`)
}
