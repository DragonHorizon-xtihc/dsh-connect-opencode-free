// Probe: maybe the free lane moved to the Responses API, not away entirely.
// Previous rounds probed ONLY /zen/v1/chat/completions and concluded the free
// lane was closed. The CLI commmunity notes a per-model endpoint split
// (2026-09-22): some Zen free models answer /v1/responses only, and a model
// posted to the wrong endpoint answers 403 FreeTierError — which is exactly
// the symptom. Test both shapes, both endpoints.
const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

import { createHash } from 'node:crypto'

function session(seed) {
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

const MODELS = ['big-pickle', 'ling-3.0-flash-fin-free', 'mimo-v2.5-free']

// Responses API tools are flat, Chat Completions tools are nested in `function`.
const toolsFor = (shape) => (shape === 'responses'
  ? [
    { type: 'function', name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  ]
  : [
    { type: 'function', function: { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ])

const bodyFor = (endpoint, model) => (endpoint === 'responses'
  ? { model, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply exactly: OK' }] }], stream: true }
  : { model, messages: [{ role: 'user', content: 'Reply exactly: OK' }], stream: true, max_tokens: 16 })

for (const endpoint of ['responses', 'chat/completions']) {
  for (const model of MODELS) {
    for (const withTools of [false, true]) {
      const body = { ...bodyFor(endpoint, model) }
      if (withTools) body.tools = toolsFor(endpoint)
      const label = `${endpoint.padEnd(17)} ${model.padEnd(26)} tools=${withTools ? 'Y' : 'N'}`
      let status = 'ERR'
      let detail = ''
      try {
        const res = await fetch(`${BASE}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer public',
            'User-Agent': UA,
            'x-opencode-session': session(`${endpoint}-${model}-${withTools}`),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })
        status = res.status
        detail = (await res.text().catch(() => '')).slice(0, 110)
      } catch (e) {
        detail = e?.message ?? String(e)
      }
      console.log(`${String(status).padEnd(5)} | ${label} | ${detail.replace(/\n/g, ' ')}`)
    }
  }
}
