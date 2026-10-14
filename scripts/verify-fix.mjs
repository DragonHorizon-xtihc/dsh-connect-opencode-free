// End-to-end proof for the free-tier fix: drive the REAL adapter, not a probe.
//
// Every probe under scripts/ re-implements the request by hand, so a probe
// passing says the gateway accepts *a* request, never that this adapter sends
// one. This one imports lib/provider.js and lets it build everything — headers
// through buildHeaders(), tools through gateTools(), the session id from the
// local OpenCode database — and only stubs the transport so the exact bytes
// that would have gone out can be printed.
//
// Run: node scripts/verify-fix.mjs [model]

import { OpenCodeFreeAdapter } from '../lib/provider.js'
import { realSessionId } from '../lib/oc-session.js'

const MODEL = process.argv[2] ?? 'big-pickle'

const probe = await realSessionId()
console.log('session:', probe.id ?? `(none — ${probe.reason})`)
if (probe.id === undefined) process.exit(2)

let captured = null
const original = globalThis.fetch
globalThis.fetch = async (url, init) => {
  captured = { url, headers: { ...init.headers }, body: JSON.parse(init.body) }
  return original(url, init) // real network: the point is the real answer
}

const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, { credentials: () => [] })
adapter.setModels([{ id: MODEL, name: MODEL, maxTokens: 32000 }])

let ok = false
let text = ''
try {
  for await (const chunk of adapter.stream({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  ok = true
} catch (error) {
  console.log('\nFAILED:', error.code ?? '', error.message)
} finally {
  globalThis.fetch = original
}

console.log('\n--- what the adapter actually put on the wire ---')
for (const [name, value] of Object.entries(captured?.headers ?? {})) {
  console.log(`  ${name}: ${name.toLowerCase() === 'authorization' ? 'Bearer ***' : value}`)
}
const names = (captured?.body?.tools ?? []).map((t) => t?.function?.name)
console.log(`  tools: ${names.join(', ')} (tool_choice=${captured?.body?.tool_choice})`)
console.log(`  model: ${captured?.body?.model}`)

const ua = Object.entries(captured?.headers ?? {}).find(([k]) => k.toLowerCase() === 'user-agent')?.[1]
console.log(`\nuser-agent resolves to: ${ua}`)
console.log(`case-duplicated header names: ${(() => {
  const seen = (captured?.headers ?? {})
  const lower = Object.keys(seen).map((k) => k.toLowerCase())
  return lower.length === new Set(lower).size ? 'none' : 'PRESENT (bug)'
})()}`)

console.log(`\nresult: ${ok ? '200 · ' + JSON.stringify(text.trim().slice(0, 120)) : 'request rejected'}`)
process.exit(ok ? 0 : 1)
