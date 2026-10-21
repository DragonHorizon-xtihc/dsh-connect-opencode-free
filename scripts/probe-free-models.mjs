// Probe: which of Zen's CURRENT free models answer, and on which endpoint.
// The previous rounds probed stale ids (ling-3.0-flash-fin-free, mimo-v2.5-free)
// that are no longer in /models — hence 400 "unavailable" / 410 "deprecated",
// which was misread as a closed lane. These ids come from GET /models today.
const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

import { createHash } from 'node:crypto'

function session(seed) {
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

// Free models exactly as listed by GET /models.
const FREE = [
  'big-pickle',
  'ling-3.1-flash-free',
  'cat-jam-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3.5-lightning-free',
  'jev-1.13-free',
  'step-5-preview-free',
  'longcat-2.5-preview-free',
  'space-bunny-free',
]

const toolsFor = (shape) => (shape === 'responses'
  ? [
    { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { type: 'function', name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ]
  : [
    { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ])

async function probe(model, endpoint, withTools) {
  const body = endpoint === 'responses'
    ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply exactly: OK' }] }], stream: true }
    : { model, messages: [{ role: 'user', content: 'Reply exactly: OK' }], stream: true, max_tokens: 16 }
  if (withTools) body.tools = toolsFor(endpoint)
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': UA,
        'x-opencode-session': session(`${model}-${endpoint}-${withTools}`),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    status = res.status
    detail = (await res.text().catch(() => '')).slice(0, 95)
  } catch (e) {
    detail = e?.message ?? String(e)
  }
  return `${String(status).padEnd(5)} | ${endpoint.padEnd(17)} tools=${withTools ? 'Y' : 'N'} | ${detail.replace(/\n/g, ' ')}`
}

for (const model of FREE) {
  console.log(`\n### ${model}`)
  for (const endpoint of ['chat/completions', 'responses']) {
    for (const withTools of [true, false]) {
      console.log('  ' + await probe(model, endpoint, withTools))
    }
  }
}
