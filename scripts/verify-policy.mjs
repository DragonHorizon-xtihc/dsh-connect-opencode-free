// End-to-end proof for the three usage rules.
//
// verify-fix.mjs proves the anonymous lane still works; this one proves the
// policy decides which lane is spent — and, crucially, that a key lying around
// is NOT spent unless the operator both configured it and chose a keyed rule.
//
// Run: node scripts/verify-policy.mjs [model]

import { OpenCodeFreeAdapter } from '../lib/provider.js'
import { realSessionId } from '../lib/oc-session.js'

const MODEL = process.argv[2] ?? 'big-pickle'

const probe = await realSessionId()
console.log('session:', probe.id ?? `(none — ${probe.reason})`)

/** One request through the real adapter; returns the bearer each attempt used. */
async function spend(policy, credentials) {
  const bearers = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bearers.push(String(init?.headers?.Authorization ?? ''))
    return original(url, init)
  }
  const hooks = {
    credentials: () => credentials,
    session: async () => ({ id: probe.id, source: 'test' }),
    quotaPolicy: () => policy,
    keyVerified: () => true,
  }
  let ok = false
  let text = ''
  let error
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, hooks)
    adapter.setModels([{ id: MODEL, name: MODEL, maxTokens: 32000 }])
    for await (const chunk of adapter.stream({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
    }
    ok = true
  } catch (caught) {
    error = caught
  } finally {
    globalThis.fetch = original
  }
  return { ok, text: text.trim(), error, bearers }
}

// A key that will certainly be refused upstream. Its only job is to show up in
// the Authorization header, which proves whether it was spent at all.
const FAKE = [{ name: 'probe-key', key: 'sk-fake-should-never-be-spent' }]

const cases = [
  ['publicOnly（默认）', 'publicOnly', FAKE],
  ['preferPublic', 'preferPublic', FAKE],
  ['preferKey', 'preferKey', FAKE],
  ['publicOnly，未配置 key', 'publicOnly', []],
]

for (const [label, policy, credentials] of cases) {
  const r = await spend(policy, credentials)
  const spentFake = r.bearers.some((b) => b.includes('sk-fake'))
  const verdict = r.ok
    ? `200 ${JSON.stringify(r.text.slice(0, 40))}`
    : `failed: ${(r.error?.message ?? '').slice(0, 60)}`
  console.log(`${label.padEnd(26)} ${verdict.padEnd(50)} spent fake key: ${spentFake ? 'YES ← 不该发生' : 'no'}`)
}

console.log('\n默认规则下，即使配了 key 也不能花掉它 —— 这是本插件"免 key"的底线。')
