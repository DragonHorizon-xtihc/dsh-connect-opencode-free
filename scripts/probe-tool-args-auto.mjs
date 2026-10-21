// Probe 2: reproduce the REAL conditions — tool_choice auto, many tools, gate
// stubs present — and measure how often the model mistypes arguments.
import { createHash } from 'node:crypto'

const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const BASE = 'https://opencode.ai/zen/v1'

function session(seed) {
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

const fn = (name, props = {}) => ({
  type: 'function',
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: props, required: Object.keys(props).slice(0, 1) },
  },
})

const EDITOR = {
  type: 'function',
  function: {
    name: 'str_replace_editor',
    description: 'View or edit a file.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        path: { type: 'string' },
        view_range: { oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }] },
        insert_line: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['command', 'path'],
    },
  },
}

const STUBS = [
  fn('bash', { command: { type: 'string' } }),
  fn('read', { path: { type: 'string' } }),
]

// Mimic a realistic large toolset (the user had 30+ enabled).
const EXTRA = Array.from({ length: 20 }, (_, i) => fn(`ego_tool_${i}`, { q: { type: 'string' } }))

const TOOLS = [EDITOR, ...STUBS, ...EXTRA]

async function once(i) {
  const body = {
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'Show me lines 415 through 479 of /tmp/a.cs' }],
    stream: true,
    max_tokens: 300,
    tools: TOOLS,
    tool_choice: 'auto',
  }
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': UA,
        'x-opencode-session': session('auto-' + i),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    return `run${i}: NETWORK ERR ${e?.message}`
  }
  if (!res.ok) return `run${i}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 80)}`
  const calls = new Map()
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(data) } catch { continue }
    for (const choice of chunk.choices || []) {
      for (const c of choice.delta?.tool_calls || []) {
        const cur = calls.get(c.index ?? 0) ?? { name: '', args: '' }
        if (c.function?.name) cur.name += c.function.name
        if (c.function?.arguments) cur.args += c.function.arguments
        calls.set(c.index ?? 0, cur)
      }
    }
  }
  return [...calls.values()].map((c) => {
    let verdict = 'RAW'
    try {
      const p = JSON.parse(c.args)
      const vr = p.view_range
      const vrOk = vr === undefined || vr === null || (Array.isArray(vr) && vr.every((n) => typeof n === 'number'))
      const il = p.insert_line
      const ilOk = il === undefined || il === null || typeof il === 'number'
      verdict = vrOk && ilOk ? 'TYPES-OK' : `TYPES-BAD(view_range=${JSON.stringify(vr)}, insert_line=${JSON.stringify(il)})`
    } catch { /* unparsable */ }
    return `run${i}: ${c.name || '(no name)'} ${verdict} args=${c.args.slice(0, 120)}`
  }).join(' || ')
}

for (let i = 1; i <= 4; i += 1) console.log(await once(i))
