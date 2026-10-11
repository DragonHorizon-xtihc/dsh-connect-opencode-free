// Probe: does the anonymous Zen lane return correctly-typed tool arguments?
// The user reports `view_range: "[415, 479]"` (string) and `insert_line: "239"`
// (string) through this adapter, but the same model is smooth in OpenCode.
// This sends one realistic schema and compares request shapes.
import { createHash } from 'node:crypto'

const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const BASE = 'https://opencode.ai/zen/v1'

function session(seed) {
  const d = createHash('sha256').update(String(seed)).digest('hex')
  return `ses_${d.slice(0, 12)}${d.slice(12, 26)}`
}

// Mirrors the real str_replace_editor schema shapes that failed.
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
        view_range: {
          oneOf: [{ type: 'array', items: { type: 'number' } }, { type: 'null' }],
        },
        insert_line: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      },
      required: ['command', 'path'],
    },
  },
}

const STUBS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
]

const variants = [
  { label: 'A: editor only (no stubs)', tools: [EDITOR], strict: false },
  { label: 'B: editor + gate stubs (what we send)', tools: [EDITOR, ...STUBS], strict: false },
  { label: 'C: editor only + strict:true', tools: [EDITOR], strict: true },
  { label: 'D: editor + stubs + strict:true', tools: [EDITOR, ...STUBS], strict: true },
]

async function run(label, tools, strict) {
  const body = {
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'Show me lines 415 through 479 of /tmp/a.cs' }],
    stream: true,
    max_tokens: 200,
    tools: strict
      ? tools.map((t) => ({ ...t, function: { ...t.function, strict: true } }))
      : tools,
    tool_choice: { type: 'function', function: { name: 'str_replace_editor' } },
  }
  let res
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': UA,
        'x-opencode-session': session('probe-' + label),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    return `${label} -> NETWORK ERR ${e?.message}`
  }
  if (!res.ok) {
    return `${label} -> HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 90)}`
  }
  // Accumulate streamed tool_call fragments.
  const calls = new Map()
  const text = await res.text()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk
    try { chunk = JSON.parse(data) } catch { continue }
    for (const choice of chunk.choices || []) {
      for (const c of choice.delta?.tool_calls || []) {
        const key = c.index ?? 0
        const cur = calls.get(key) ?? { name: '', args: '' }
        if (c.function?.name) cur.name += c.function.name
        if (c.function?.arguments) cur.args += c.function.arguments
        calls.set(key, cur)
      }
    }
  }
  const out = [...calls.values()].map((c) => {
    let parsed = c.args
    try { parsed = JSON.stringify(JSON.parse(c.args)) } catch { /* keep raw */ }
    return `${c.name || '(no name)'}: ${parsed}`
  })
  return `${label} -> ${out.join(' | ') || '(no tool call)'}`
}

for (const v of variants) {
  console.log(await run(v.label, v.tools, v.strict))
}
