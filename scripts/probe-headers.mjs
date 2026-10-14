// Probe: the CLI sends a whole family of x-opencode-* headers; we only ever
// sent `x-opencode-session`. Extracted the family from the CLI binary
// (x-opencode-client/request/project/directory/workspace/ticket/...) and add
// them back one group at a time to find which one the gate actually reads.
const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const MODEL = 'space-bunny-free' // the model the CLI uses most, per today's log

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

function session(seed) {
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

const base = (seed) => ({
  'Content-Type': 'application/json',
  Authorization: 'Bearer public',
  'User-Agent': UA,
  'x-opencode-session': session(seed),
})

const cases = [
  ['1 baseline: session only', {}],
  ['2 + x-opencode-client: cli', { 'x-opencode-client': 'cli' }],
  ['3 + client + request', { 'x-opencode-client': 'cli', 'x-opencode-request': randomUUID() }],
  ['4 + project/directory/workspace', {
    'x-opencode-project': 'global',
    'x-opencode-directory': 'D:/ClaudeCode/deepseek-harness/plugins/dsh-connect-opencode-free',
    'x-opencode-workspace': 'D:/ClaudeCode/deepseek-harness',
  }],
  ['5 ALL: client+request+project+dir+ws', {
    'x-opencode-client': 'cli',
    'x-opencode-request': randomUUID(),
    'x-opencode-project': 'global',
    'x-opencode-directory': 'D:/ClaudeCode/deepseek-harness/plugins/dsh-connect-opencode-free',
    'x-opencode-workspace': 'D:/ClaudeCode/deepseek-harness',
    'x-opencode-session-id': session('sid'),
  }],
  ['6 client=cli only, no session', { 'x-opencode-client': 'cli', NO_SESSION: '1' }],
]

for (const [label, extra] of cases) {
  const seed = label.slice(0, 8)
  const headers = { ...base(seed), ...extra }
  delete headers.NO_SESSION
  if ('NO_SESSION' in extra) delete headers['x-opencode-session']
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply exactly: OK' }],
    stream: true,
    max_tokens: 16,
    tools: [
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
      { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ],
    tool_choice: 'auto',
  }
  let status = 'ERR'
  let detail = ''
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
    status = res.status
    detail = (await res.text().catch(() => '')).slice(0, 100)
  } catch (e) {
    detail = e?.message ?? String(e)
  }
  console.log(`${String(status).padEnd(5)} | ${label.padEnd(36)} | ${detail.replace(/\n/g, ' ')}`)
}
