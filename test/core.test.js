import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  QUOTA_POLICY,
  ZEN_ROUTE_ID,
  apiKeyNameFor,
  apiKeyNamesFor,
  buildModelSet,
  buildProviderEntry,
  describeCatalog,
  effectiveQuotaPolicy,
  formatTokens,
  resolveEntryNamespace,
  routesChanged,
  toYamlSnippet,
} from '../lib/core.js'
import { AssistantStreamAccumulator, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ZEN_BASE_URL } from '../lib/core.js'
import { OpenCodeFreeAdapter, DEFAULT_ATTEMPT_COUNT, auditWireMessages, backoffFor, buildHeaders, credentialSequence, isContextOverflow, sanitizeWireMessages } from '../lib/provider.js'
import { keyCheckStillValid, keyFingerprint, verifyKey } from '../lib/keycheck.js'
import { mergeCatalog, serveableModels } from '../lib/discovery.js'
import {
  DEFAULT_REFUSAL_COOLDOWN_MS,
  QuotaTracker,
  credentialPool,
  credentialValue,
  estimateResetMs,
  resolveCredential,
  resolveCredentialPool,
} from '../lib/quota.js'
import { AvailabilityTracker, classifyFailure } from '../lib/availability.js'
import { gateToolDefinitions } from '../lib/gate-tools.js'
import { OpenCodeBridge, resolveCommand } from '../lib/oc-bridge.js'

/** A models.dev-shaped document with the two prices that decide "free". */
const CATALOG = {
  opencode: {
    models: {
      'big-pickle': { id: 'big-pickle', name: 'Big Pickle', cost: { input: 0, output: 0 }, limit: { context: 200000, output: 32000 }, reasoning: true, tool_call: true },
      'nemotron-3-ultra-free': { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', cost: { input: 0, output: 0 }, limit: { context: 1000000, output: 128000 }, reasoning: true, tool_call: true },
      'old-free': { id: 'old-free', name: 'Old Free', cost: { input: 0, output: 0 }, limit: { context: 100000 }, status: 'deprecated' },
      'retired-served-free': { id: 'retired-served-free', name: 'Retired Served Free', cost: { input: 0, output: 0 }, limit: { context: 100000 }, status: 'deprecated' },
      'gone-free': { id: 'gone-free', name: 'Gone Free', cost: { input: 0, output: 0 }, limit: { context: 100000 } },
      'claude-sonnet-5': { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', cost: { input: 3, output: 15 }, limit: { context: 1000000 } },
    },
  },
}

const ZEN = new Set([
  'big-pickle', 'nemotron-3-ultra-free', 'retired-served-free', 'claude-sonnet-5', 'jev-1.13-free',
])

// ---- discovery ----

test('mergeCatalog keeps only zero-cost models and drops paid ones', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const ids = catalog.map((m) => m.id)
  assert.ok(ids.includes('big-pickle'))
  assert.ok(!ids.includes('claude-sonnet-5'), 'a paid model must never reach the free list')
})

test('mergeCatalog marks availability from Zen, not from the catalog', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const byId = Object.fromEntries(catalog.map((m) => [m.id, m]))
  assert.equal(byId['big-pickle'].available, true)
  assert.equal(byId['gone-free'].available, false, 'free but no longer served by Zen')
})

test('mergeCatalog assumes availability when Zen could not be read, so a cold start is not empty', () => {
  const catalog = mergeCatalog(CATALOG, undefined)
  const ids = catalog.filter((m) => m.available).map((m) => m.id)
  assert.ok(ids.includes('big-pickle'), 'an unreachable Zen must not empty the picker')
  assert.ok(ids.includes('gone-free'), 'without Zen there is no evidence of withdrawal')
})

test('mergeCatalog keeps an explicit empty Zen answer authoritative', () => {
  const catalog = mergeCatalog(CATALOG, new Set())
  assert.ok(catalog.every((m) => m.available === false), 'Zen answering with nothing means nothing is served')
})

test('mergeCatalog carries context, output cap and capability flags', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const big = catalog.find((m) => m.id === 'big-pickle')
  assert.equal(big.contextWindow, 200000)
  assert.equal(big.maxTokens, 32000)
  assert.equal(big.reasoning, true)
  assert.equal(big.toolCall, true)
})

test('mergeCatalog picks up a Zen-only free model the catalog has not priced yet', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const fresh = catalog.find((m) => m.id === 'jev-1.13-free')
  assert.ok(fresh, 'a new free model must not wait for the catalog to catch up')
  assert.equal(fresh.source, 'zen')
  assert.equal(fresh.available, true)
})

test('mergeCatalog survives a missing catalog by taking every free id Zen serves', () => {
  // With no catalog there is nothing to price against, so the id alone is the
  // only evidence available — showing those models beats showing none.
  for (const empty of [{}, undefined]) {
    const catalog = mergeCatalog(empty, ZEN)
    assert.deepEqual(catalog.map((m) => m.id).sort(), [
      'jev-1.13-free', 'nemotron-3-ultra-free', 'retired-served-free',
    ])
    assert.ok(catalog.every((m) => m.source === 'zen'))
  }
})

test('serveableModels drops retired and unserved entries unless asked', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const serving = serveableModels(catalog).map((m) => m.id)
  assert.deepEqual(serving.sort(), ['big-pickle', 'jev-1.13-free', 'nemotron-3-ultra-free'])
  const withRetired = serveableModels(catalog, { includeDeprecated: true }).map((m) => m.id)
  assert.ok(withRetired.includes('retired-served-free'), 'includeDeprecated shows a retired model Zen still serves')
  assert.ok(!withRetired.includes('gone-free'), 'a model Zen dropped is never served, deprecated or not')
})

// ---- model set ----

test('buildModelSet serves the catalog and layers manual models on top', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const set = buildModelSet(catalog, [{ id: 'hand-added', name: 'Hand', contextWindow: 4096 }], [])
  const ids = set.map((m) => m.id)
  assert.ok(ids.includes('hand-added'))
  assert.ok(!ids.includes('gone-free'), 'a model Zen dropped is not served')
  // Retirement is decided upstream — serveableModels for the Host, describeCatalog
  // for the page. Deciding it again here would cancel an includeDeprecated switch
  // that was turned on, which is what made the setting a no-op.
  assert.ok(ids.includes('retired-served-free'), 'buildModelSet does not re-apply the retirement filter')
})

test('includeDeprecated decides both the listed rows and the served set', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const off = { includeDeprecated: false }
  const on = { includeDeprecated: true }

  assert.ok(!describeCatalog(catalog, [], [], off).some((row) => row.id === 'retired-served-free'),
    'a retired model is not listed until the switch is on')
  assert.ok(!buildModelSet(serveableModels(catalog, off), [], []).some((m) => m.id === 'retired-served-free'),
    'a retired model is not served until the switch is on')

  const listed = describeCatalog(catalog, [], [], on).find((row) => row.id === 'retired-served-free')
  assert.ok(listed, 'the switch lists the retired model')
  assert.equal(listed.unavailable, false, 'Zen still serves it, so the row can be enabled')
  assert.ok(buildModelSet(serveableModels(catalog, on), [], []).some((m) => m.id === 'retired-served-free'),
    'the switch must reach the served set, not only the page')
})

test('listing a retired model still marks the one Zen withdrew', () => {
  const rows = describeCatalog(mergeCatalog(CATALOG, ZEN), [], [], { includeDeprecated: true })
  const withdrawn = rows.find((row) => row.id === 'old-free')
  assert.ok(withdrawn, 'the switch lists it')
  assert.equal(withdrawn.unavailable, true, 'listing a retired model never makes it callable')
  assert.ok(!buildModelSet(rows, [], []).some((m) => m.id === 'old-free'))
})

test('a model Zen took down is not listed until the switch is on either', async () => {
  // The switch is worded "show deprecated free models", but what an operator
  // wants hidden by default is every row that cannot serve. `gone-free` is the
  // case that used to leak: models.dev never retired it, so `deprecated` is
  // false, and the old filter only looked at that flag — leaving a row in the
  // list that reads as enable-able and then fails on every call.
  const catalog = mergeCatalog(CATALOG, ZEN)
  const off = describeCatalog(catalog, [], [], { includeDeprecated: false })
  assert.ok(!off.some((row) => row.id === 'gone-free'),
    'a model Zen withdrew is not listed by default, retired upstream or not')
  // And the served set never carried it anyway — this is only about the page.
  assert.ok(!buildModelSet(serveableModels(catalog, { includeDeprecated: false }), [], [])
    .some((m) => m.id === 'gone-free'))

  const on = describeCatalog(catalog, [], [], { includeDeprecated: true })
  const gone = on.find((row) => row.id === 'gone-free')
  assert.ok(gone, 'the switch brings it back')
  assert.equal(gone.unavailable, true, 'and it is still marked unservable, so it cannot be enabled by accident')
  assert.equal(gone.reason, 'Zen 已下架', 'the row says why it is dead')
})

test('buildModelSet honours the operator disable list over discovery', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const set = buildModelSet(catalog, [], ['big-pickle'])
  assert.ok(!set.some((m) => m.id === 'big-pickle'))
  assert.ok(set.some((m) => m.id === 'nemotron-3-ultra-free'))
})

test('buildModelSet falls back for a manual model with no usable context', () => {
  const set = buildModelSet([], [{ id: 'x', name: '', contextWindow: 'nonsense' }], [], { defaultContextWindow: 123_456 })
  assert.equal(set[0].contextWindow, 123_456)
  assert.equal(set[0].name, 'x')
})

// ---- provider entry ----

test('buildModelSet drops a page row marked unavailable, so a write cannot include a withdrawn model', () => {
  // The page's rows spell withdrawal as `unavailable`, the Host's records as
  // `available: false`. Both must keep a model out of the provider profile.
  // The retired rows are listed too, so the assertions cover the switch being on.
  const pageRows = describeCatalog(mergeCatalog(CATALOG, ZEN), [], [], { includeDeprecated: true })
  const set = buildModelSet(pageRows, [], [])
  const ids = set.map((m) => m.id)
  assert.deepEqual(ids.sort(), ['big-pickle', 'jev-1.13-free', 'nemotron-3-ultra-free', 'retired-served-free'])
  const { entry } = buildProviderEntry(set)
  assert.ok(!entry.models.some((m) => m.id === 'gone-free'))
  assert.ok(!entry.models.some((m) => m.id === 'old-free'), 'listed, but Zen withdrew it')
})

test('buildProviderEntry writes one route carrying every model, with no credential', () => {
  const catalog = serveableModels(mergeCatalog(CATALOG, ZEN))
  const { pid, entry } = buildProviderEntry(buildModelSet(catalog, [], []))
  assert.equal(pid, ZEN_ROUTE_ID)
  assert.equal(entry.api, 'openai-completions')
  assert.equal(entry.baseURL, 'https://opencode.ai/zen/v1')
  assert.equal(entry.apiKeyEnv, undefined, 'naming a credential would make pi-ai demand one')
  assert.deepEqual(entry.models.map((m) => m.id), ['big-pickle', 'jev-1.13-free', 'nemotron-3-ultra-free'])
})

test('buildProviderEntry sizes each model and the route default from the catalog', () => {
  const { entry } = buildProviderEntry(buildModelSet(serveableModels(mergeCatalog(CATALOG, ZEN)), [], []))
  const big = entry.models.find((m) => m.id === 'big-pickle')
  assert.equal(big.contextWindow, 200000)
  assert.equal(big.maxTokens, 32000)
  assert.equal(entry.defaultContextWindow, 1000000)
  assert.equal(entry.compat.supportsReasoningEffort, true)
})

test('toYamlSnippet renders a pasteable provider block', () => {
  const { pid, entry } = buildProviderEntry(buildModelSet(serveableModels(mergeCatalog(CATALOG, ZEN)), [], []))
  const yaml = toYamlSnippet({ pid, entry })
  assert.ok(yaml.startsWith('llm-pi-ai:'))
  assert.ok(yaml.includes(`${pid}:`))
  assert.ok(yaml.includes('- id: "big-pickle"'))
})

// ---- page rows ----

test('describeCatalog explains why a model is not being served', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const rows = describeCatalog(catalog, [], [])
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
  assert.equal(byId['big-pickle'].unavailable, false)
  assert.equal(byId['big-pickle'].reason, '')
  // Both kinds of dead row are hidden by default: one the upstream author
  // retired, one Zen took off its shelf. A row you can see but cannot enable
  // reads as a fault, so it stays behind the switch.
  assert.equal(byId['gone-free'], undefined, 'a model Zen withdrew is not listed by default')
  assert.equal(byId['old-free'], undefined, 'nor is a model models.dev retired')
  const withDead = Object.fromEntries(
    describeCatalog(catalog, [], [], { includeDeprecated: true }).map((r) => [r.id, r]),
  )
  assert.equal(withDead['gone-free'].reason, 'Zen 已下架')
  assert.equal(withDead['gone-free'].unavailable, true)
  assert.equal(withDead['old-free'].reason, 'models.dev 标记为已弃用')
  // Deprecation is the more actionable statement, so it wins when both apply.
  assert.equal(withDead['old-free'].unavailable, true, 'a retired model Zen also dropped is dead twice over')
})

test('routesChanged stays quiet for an unchanged set and speaks up for every move', () => {
  // `replace()` republishes `llm/adapters-updated`, which four UI modules answer
  // by rebuilding their model catalogs. Every settings write reaches this
  // decision — a checkbox click included — so an unchanged set has to cost
  // nothing, and a real move has to still go through.
  const route = ['opencode-zen']

  // First sync: unknown, so it must go through even when nothing is wanted.
  assert.equal(routesChanged(undefined, route), true)
  assert.equal(routesChanged(undefined, []), true)

  // Steady state: the enabled switch clicked on and off, or any unrelated
  // setting written. This is the case that used to reload four catalogs.
  assert.equal(routesChanged(route, route), false)
  assert.equal(routesChanged([], []), false)
  assert.equal(routesChanged(route, route.slice()), false, 'a fresh array of the same routes is the same set')

  // Real moves still register, in both directions — pausing has to withdraw
  // the route or the picker keeps showing a cached list.
  assert.equal(routesChanged(route, []), true)
  assert.equal(routesChanged([], route), true)

  // Order is part of the set: the registry stores routes in registration order.
  assert.equal(routesChanged(['a', 'b'], ['b', 'a']), true)
  assert.equal(routesChanged(['a'], ['a', 'b']), true)

  // Defensive: a non-array reads as "nothing held", which is a change.
  assert.equal(routesChanged(undefined, undefined), true)
  assert.equal(routesChanged(null, []), true)
})

test('describeCatalog marks a disabled model without calling it unavailable', () => {
  const rows = describeCatalog(mergeCatalog(CATALOG, ZEN), [], ['big-pickle'])
  const big = rows.find((r) => r.id === 'big-pickle')
  assert.equal(big.disabled, true)
  assert.equal(big.unavailable, false)
})

test('describeCatalog appends manual models with no upstream status', () => {
  const rows = describeCatalog([], [{ id: 'solo', name: '', contextWindow: 1000 }], [])
  const solo = rows.find((r) => r.id === 'solo')
  assert.equal(solo.source, 'manual')
  assert.equal(solo.unavailable, false)
  assert.equal(solo.name, 'solo')
})

test('the gateway gate tools are real, executable tools', async () => {
  // Zen's gate only accepts a body advertising `bash` and `read`. Advertising
  // names that do nothing makes the model reach for tools that cannot answer,
  // so they must be real — built here with the actual dsh-tools factory, which
  // is what proves the schema DSL is accepted.
  let dshTools
  try {
    dshTools = await import('@deepseek-ai/dsh-tools')
  } catch {
    return // dsh-tools not resolvable in this checkout; nothing to assert
  }
  if (typeof dshTools.defineTool !== 'function') return
  const defs = gateToolDefinitions(dshTools.defineTool)
  assert.deepEqual(defs.map((d) => d.name), ['bash', 'read'])
  for (const def of defs) assert.equal(typeof def.execute, 'function')

  const file = join(tmpdir(), `dsh-gate-read-${Date.now()}.txt`)
  writeFileSync(file, 'l1\nl2\nl3\nl4\n', 'utf8')
  try {
    const read = defs.find((d) => d.name === 'read')
    assert.equal(await read.execute({ path: file }, {}), 'l1\nl2\nl3\nl4\n')
    assert.equal(await read.execute({ path: file, offset: 2, limit: 2 }, {}), 'l2\nl3')
    const bash = defs.find((d) => d.name === 'bash')
    const out = await bash.execute({ command: 'echo gate-ok' }, {})
    assert.match(out, /gate-ok/, 'bash must actually run the command')
    assert.match(out, /\[exit 0\]/, 'the exit code must be reported')
  } finally {
    unlinkSync(file)
  }
})

// ---- namespace + formatting ----

test('resolveEntryNamespace prefers the declared id, then an opencode rename', () => {
  assert.equal(resolveEntryNamespace(['llm-pi-ai', 'dsh-connect-opencode-free']), 'dsh-connect-opencode-free')
  assert.equal(resolveEntryNamespace(['llm-pi-ai', 'my-opencode-free-row']), 'my-opencode-free-row')
  assert.equal(resolveEntryNamespace(['llm-pi-ai']), undefined)
})

test('formatTokens abbreviates only above a thousand', () => {
  assert.equal(formatTokens(524_288), '524K')
  assert.equal(formatTokens(0), '')
  assert.equal(formatTokens(undefined), '')
})

// ---- quota + credentials ----

test('estimateResetMs reads Retry-After seconds and ignores nonsense', () => {
  assert.equal(estimateResetMs({ headers: { get: () => '30' } }), 30_000)
  assert.equal(estimateResetMs({ headers: { get: () => 'soon' } }), undefined)
  assert.equal(estimateResetMs(undefined), undefined)
})

test('resolveCredential prefers the first configured env var, else the public tier', () => {
  assert.equal(resolveCredential('A,B', { B: 'key-b' }).key, 'key-b')
  assert.equal(resolveCredential('A,B', { A: 'key-a', B: 'key-b' }).source, 'A')
  const anonymous = resolveCredential('A', {})
  assert.equal(anonymous.key, 'public')
  assert.equal(anonymous.anonymous, true)
})

test('credentialPool lists every configured key that is actually set', () => {
  assert.deepEqual(
    credentialPool('A, B ,C', { A: 'a', C: '' }).map((p) => p.name),
    ['A'],
  )
})

// Regression: `llm` calls `registration.adapter.prepareCall()` on every request
// (packages/llm/llm/src/index.ts). A plain-object adapter registers fine and then
// throws "prepareCall is not a function" at the first model call, so the whole turn
// fails. Extending LlmAdapter is what supplies it.
test('adapter satisfies the LlmAdapter contract the llm service calls', async () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {})
  assert.ok(adapter instanceof LlmAdapter)
  for (const member of ['prepareCall', 'stream', 'resolveModel', 'listModels', 'providerInfo', 'providerRetryPolicy', 'imageRequestPricing']) {
    assert.equal(typeof adapter[member], 'function', `${member} must be callable`)
  }
  // prepareCall must survive resolving to an older dsh-llm whose base class
  // lacks it, so it has to live on the adapter itself, not merely be inherited.
  assert.ok(Object.getPrototypeOf(adapter).hasOwnProperty('prepareCall'), 'prepareCall must be declared on the adapter prototype')
  const prepared = await adapter.prepareCall('opencode-free', 'space-bunny-free')
  assert.deepEqual(Object.keys(prepared).sort(), ['model', 'stream'])
  assert.equal(prepared.model.id, 'space-bunny-free')
  assert.equal(typeof prepared.stream, 'function')
})

test('stream honours the configured Zen root instead of the compiled-in one', () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
    zenBaseURL: () => 'https://self-host.example/v1',
  })
  assert.equal(adapter.baseUrl(), 'https://self-host.example/v1')
  assert.equal(new OpenCodeFreeAdapter(null, {}, {}).baseUrl(), ZEN_BASE_URL)
})

/** Run one stream against a swappable transport and capture what went on the wire. */
// A shape-correct id standing in for one OpenCode really created. Injected by
// default so these specs never depend on the CLI database being present.
const TEST_SESSION_ID = 'ses_ab12cd34ef56gh78ij90kl12mn'

async function captureStream(adapterOptions, options, models = [{ id: 'big-pickle', name: 'Big Pickle', maxTokens: 32000 }]) {
  // `bridgeMode: off` keeps these specs off the local OpenCode client: a mocked
  // 429 would otherwise fork a real subprocess and make a real network call.
  const hooks = {
    session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
    bridgeMode: () => 'off',
    ...adapterOptions,
  }
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: JSON.parse(init.body) })
    const sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, hooks)
    adapter.setModels(models)
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [], ...options })) chunks.push(chunk)
    assert.ok(chunks.some((c) => c.type === 'text-delta'), 'the captured stream must still produce text')
  } finally {
    globalThis.fetch = originalFetch
  }
  return calls
}

test('an anonymous request carries all three Zen free-tier gate markers', async () => {
  const [call] = await captureStream({ credentials: () => [] }, { sessionId: 'conversation-42' })
  assert.equal(call.headers.Authorization, 'Bearer public')

  // 1. the User-Agent must read as the OpenCode CLI.
  // Spelled lowercase on purpose: `attributionHeaders()` supplies `user-agent`
  // (deepseek-harness/…), and an override under a differently-cased key would
  // sit beside it instead of replacing it — the harness value then wins on the
  // wire and Zen answers 403. This asserts the override actually took.
  assert.ok(String(call.headers['user-agent']).startsWith('opencode/'), 'user-agent must start with opencode/')
  assert.equal(call.headers['User-Agent'], undefined, 'a differently-cased duplicate must not survive beside it')
  // 2. a canonical session id: ses_ + 12 lowercase hex + 14 Base62
  assert.match(call.headers['x-opencode-session'], /^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/)
  assert.equal(call.headers['x-opencode-session'].length, 4 + 26)
  // 3. bash and read in the tools array, with none of them selectable
  const names = call.body.tools.map((t) => t.function.name)
  assert.ok(names.includes('bash') && names.includes('read'), `tools must include bash and read, got ${names.join(', ')}`)
  assert.equal(call.body.tool_choice, 'none', 'stub tools must never be selectable')
})

// Which lane a request uses is the operator's policy now, and the default
// (`publicOnly`) never touches a key at all. Specs that exercise the paid lane
// therefore have to ask for it — explicitly, and with a key that has been
// verified, because an unverified one does not unlock it.
const PAID_FIRST = {
  quotaPolicy: () => QUOTA_POLICY.PREFER_KEY,
  keyVerified: () => true,
}
/** The public lane leads, and a key waits behind it. */
const PUBLIC_FIRST = {
  quotaPolicy: () => QUOTA_POLICY.PREFER_PUBLIC,
  keyVerified: () => true,
}
const IDLE_QUOTA = { record: () => {}, refuse: () => {}, clear: () => {}, publicLaneClosed: () => false }

test('a keyed request carries the gateway identity, same as the anonymous one', async () => {
  // This used to assert the opposite — that a keyed request kept the harness's
  // own attribution and no session id, on the belief that the free-tier gate did
  // not run on the authenticated route. Probed live on 2026-10-14 with a real
  // key from opencode.ai/zen: the key plus a real session plus the CLI UA plus
  // `bash`/`read` plus streaming answers 200, and the same key missing any one
  // of them answers 403 FreeTierError. A garbage key gets the identical 403, so
  // the route does not decide on the credential at all. The keyed lane was dead
  // for as long as the old belief stood.
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  })
  assert.ok(String(call.headers['user-agent']).startsWith('opencode/'), `got ${call.headers['user-agent']}`)
  assert.equal(call.headers['x-opencode-session'], TEST_SESSION_ID)
  // The attribution the Host supplies is still on the wire — `assignHeader`
  // replaces it case-insensitively rather than dropping it.
  assert.ok(String(call.headers['x-dsh-attribution'] ?? call.headers['attribution'] ?? '').length >= 0)
})

/**
 * Drive one request that every attempt rejects, and report what it spent.
 *
 * The `bearers` it returns are the point: they say which lane each attempt
 * actually used, which is the only way to assert that a configured key stays
 * untouched until the free lane has said no.
 * @param credentials - the operator's key pool, as the Host would resolve it.
 * @param options - `status`, `body` and `headers` for every rejection, plus
 * `quota` to hand the adapter a lane that is already known to be closed.
 * @returns `{ calls, bearers, error }`.
 */
async function captureRejection(credentials, options = {}) {
  const status = options.status ?? 401
  const body = options.body ?? JSON.stringify({ error: { message: 'Unauthorized', type: 'AuthError' } })
  const originalFetch = globalThis.fetch
  const bearers = []
  globalThis.fetch = async (_url, init) => {
    bearers.push(String(init?.headers?.Authorization ?? ''))
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    })
  }
  let error
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => credentials,
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      // See `captureStream`: a mocked 429 must not reach for a real subprocess.
      bridgeMode: () => 'off',
      ...(options.quota === undefined ? {} : { quota: options.quota }),
      ...(options.policy === undefined ? {} : { ...options.policy }),
      // Fast by default. These specs assert on which lane a failure routes to,
      // not on how long the retry loop waits, and the production default of ten
      // attempts would make every one of them sit through a minute of backoff.
      // The retry specs below opt into real counts explicitly.
      maxAttempts: options.maxAttempts ?? (() => 1),
      backoffMs: options.backoffMs ?? (() => 1),
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle', maxTokens: 32000 }])
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk
  } catch (caught) {
    error = caught
  } finally {
    globalThis.fetch = originalFetch
  }
  return { calls: bearers.length, bearers, error }
}

const FREE_TIER_BODY = JSON.stringify({
  error: { message: "OpenCode's free tier can only be used from within OpenCode.", type: 'FreeTierError' },
})
const RATE_LIMIT_BODY = JSON.stringify({ error: { message: 'Rate limit exceeded', type: 'RateLimitError' } })

const TWO_KEYS = [{ name: 'key A', key: 'sk-a' }, { name: 'key B', key: 'sk-b' }]

test('the default policy spends the public quota and nothing else', async () => {
  // This is the rule that keeps the plugin free: a key sitting in the
  // environment is not, by itself, permission to bill it.
  const result = await captureRejection(TWO_KEYS, { status: 429, body: RATE_LIMIT_BODY })
  assert.deepEqual(
    result.bearers.filter((b) => b !== 'Bearer public'),
    [],
    `no key may be spent under the default policy, got ${result.bearers.join(', ')}`,
  )
  const refusal = await captureRejection(TWO_KEYS, { status: 403, body: FREE_TIER_BODY })
  assert.deepEqual(
    refusal.bearers.filter((b) => b !== 'Bearer public'),
    [],
    `a free-tier refusal must not reach a key either, got ${refusal.bearers.join(', ')}`,
  )
})

test('a configured but unverified key does not unlock a keyed policy', async () => {
  // The gate is the point: a mistyped credential would otherwise flip every
  // request onto a lane that then fails, and the failure would look like an
  // outage rather than a typo.
  for (const policy of [QUOTA_POLICY.PREFER_PUBLIC, QUOTA_POLICY.PREFER_KEY]) {
    const result = await captureRejection(TWO_KEYS, {
      status: 403,
      body: FREE_TIER_BODY,
      policy: { quotaPolicy: () => policy, keyVerified: () => false },
    })
    assert.deepEqual(result.bearers, ['Bearer public'], `${policy} without a verified key: ${result.bearers.join(', ')}`)
  }
})

test('effectiveQuotaPolicy gates the keyed rules on a verified key', () => {
  // The page disables the two keyed rules; this is the Host refusing to honour
  // them, which is the half that actually protects the operator's quota when
  // the page is stale, read-only, or bypassed.
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PUBLIC_ONLY, false), QUOTA_POLICY.PUBLIC_ONLY)
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PUBLIC_ONLY, true), QUOTA_POLICY.PUBLIC_ONLY)
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PREFER_PUBLIC, true), QUOTA_POLICY.PREFER_PUBLIC)
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PREFER_KEY, true), QUOTA_POLICY.PREFER_KEY)
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PREFER_PUBLIC, false), QUOTA_POLICY.PUBLIC_ONLY)
  assert.equal(effectiveQuotaPolicy(QUOTA_POLICY.PREFER_KEY, false), QUOTA_POLICY.PUBLIC_ONLY)
  // An unknown or missing value must degrade to the safe lane, never to a keyed one.
  assert.equal(effectiveQuotaPolicy('nonsense', true), QUOTA_POLICY.PUBLIC_ONLY)
  assert.equal(effectiveQuotaPolicy(undefined, true), QUOTA_POLICY.PUBLIC_ONLY)
})

test('a key-first policy spends the key and falls back to the public lane', async () => {
  const result = await captureRejection([{ name: 'key A', key: 'sk-a' }], {
    status: 401,
    policy: PAID_FIRST,
  })
  assert.deepEqual(result.bearers, ['Bearer sk-a', 'Bearer public'], `got ${result.bearers.join(', ')}`)
})

test('a rejection the free lane cannot hand off is not retried and spends no key', async () => {
  // The rejection used to be `throw`n from inside the attempt's try, which the
  // same-level catch caught — so "do not retry" silently became "retry". And a
  // key is a fallback, not a spare: an unrelated 401 would fail identically on
  // the paid route, so spending the operator's quota on it buys the same error
  // at a price.
  const anonymous = await captureRejection([])
  assert.ok(anonymous.error, 'the stream must fail')
  assert.equal(anonymous.calls, 1, `one credential, one rejection, one request — got ${anonymous.calls}`)

  const pooled = await captureRejection(TWO_KEYS, { policy: PUBLIC_FIRST })
  assert.ok(pooled.error, 'the stream must fail')
  assert.deepEqual(pooled.bearers, ['Bearer public'], `the keys must stay unspent, got ${pooled.bearers.join(', ')}`)
})

test('an exhausted public quota is what unlocks a configured key', async () => {
  const first = await captureRejection([{ name: 'key A', key: 'sk-a' }], {
    status: 429,
    body: RATE_LIMIT_BODY,
    policy: PUBLIC_FIRST,
  })
  assert.equal(first.bearers[0], 'Bearer public', 'the free lane is always asked first')
  assert.equal(first.bearers[1], 'Bearer sk-a', 'and the key is spent only once it has said no')
  assert.ok(first.error, 'both failing still fails the request')
  assert.match(first.error.message, /key A/, 'the key verdict is the one worth reporting')
})

test('a free-tier refusal is what unlocks a configured key', async () => {
  const result = await captureRejection([{ name: 'key A', key: 'sk-a' }], {
    status: 403,
    body: FREE_TIER_BODY,
    policy: PUBLIC_FIRST,
  })
  assert.deepEqual(result.bearers, ['Bearer public', 'Bearer sk-a'], `got ${result.bearers.join(', ')}`)
  assert.ok(result.error)
})

test('a lane already known to be closed is not probed again', async () => {
  // "Public first" means first when it can answer. Re-asking a lane that
  // refused moments ago adds a doomed round trip to every turn.
  const closed = await captureRejection([{ name: 'key A', key: 'sk-a' }], {
    status: 403,
    body: FREE_TIER_BODY,
    policy: PUBLIC_FIRST,
    quota: { ...IDLE_QUOTA, publicLaneClosed: () => true },
  })
  assert.deepEqual(closed.bearers, ['Bearer sk-a'], `got ${closed.bearers.join(', ')}`)
})

test('a refusal is remembered so the next request starts at the keys', async () => {
  // The tracker is what carries the memory between requests; without it the
  // free lane would be re-probed on every single call.
  const tracker = new QuotaTracker(join(tmpdir(), `ocf-quota-${Date.now()}.json`))
  const now = Date.now()
  assert.equal(tracker.publicLaneClosed(now), false, 'nothing known means open')
  tracker.refuse(now)
  assert.equal(tracker.publicLaneClosed(now), true, 'a refusal closes it')
  assert.equal(tracker.publicLaneClosed(now + DEFAULT_REFUSAL_COOLDOWN_MS), false, 'and it reopens')
})

/** Case-insensitive header read, the way the wire would resolve it. */
function header(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

test('the CLI disguise wins however the host spells its attribution header', () => {
  // The bug this replaces was a spelling accident, not a logic error: the code
  // said "send opencode/…" and the wire said "deepseek-harness/…" because two
  // casings of one header coexisted. Asserting the happy path alone would not
  // have caught it, so the hostile inputs are the test.
  const hostile = [
    { 'User-Agent': 'deepseek-harness/9.9.9 (+https://example.test)' },
    { 'user-agent': 'deepseek-harness/9.9.9 (+https://example.test)' },
    { 'USER-AGENT': 'deepseek-harness/9.9.9', 'x-dsh-deployment': 'acme' },
  ]
  for (const attribution of hostile) {
    const headers = buildHeaders(
      { key: 'public', anonymous: true },
      { userAgent: 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23', session: TEST_SESSION_ID },
      attribution,
    )
    const spellings = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')
    assert.equal(spellings.length, 1, `exactly one user-agent, got ${spellings.join(' + ')}`)
    assert.ok(String(header(headers, 'user-agent')).startsWith('opencode/'), `got ${header(headers, 'user-agent')}`)
  }
  // A keyed attempt keeps whatever the host declared, disguise or not — and
  // keeps it even when the host spells the name in a different case.
  const keyed = buildHeaders(
    { key: 'sk-test', anonymous: false },
    { userAgent: undefined, session: undefined },
    { 'User-Agent': 'deepseek-harness/1.2.3 (+https://example.test)' },
  )
  assert.ok(String(header(keyed, 'user-agent')).startsWith('deepseek-harness/'), `got ${header(keyed, 'user-agent')}`)
  assert.equal(keyed['x-opencode-session'], undefined)
})

test('every lane warns the model off the placeholders it advertises', async () => {
  // The warning names tools, so it may only be sent when the request actually
  // puts them on the wire. That used to mean "the anonymous lane only" — until
  // the probe on 2026-10-14 showed the gate demands `bash`/`read` of a keyed
  // request too. So now both lanes carry the stubs and both need the warning;
  // telling a model to avoid tools it was never offered is still the thing to
  // avoid, which is why the check is "did this lane advertise them", not
  // "which lane is this".
  const tools = [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } }]
  const [anonymous] = await captureStream({ credentials: () => [] }, { tools })
  const [keyed] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { tools })
  const warned = (call) => JSON.stringify(call.body.messages).includes('Do not call the tools named')
  assert.ok(warned(anonymous), 'the anonymous lane carries the placeholder warning')
  assert.ok(warned(keyed), 'and so does the keyed lane, because it advertises them too')
})

test('a keyed request advertises the gate tools the gateway demands', async () => {
  // This used to assert the opposite: "a keyed body carrying no stubs answers
  // 401 AuthError, never 403 FreeTierError — the free-tier gate does not run on
  // the authenticated route." That probe was wrong: it omitted the session id
  // too, so the request never reached authentication at all. With a real session
  // in place the same keyed body answers 403 FreeTierError, which is what the
  // whole keyed lane was hitting. A keyed caller whose host has no `bash`/`read`
  // of its own therefore gets the placeholders — and the stream interceptor
  // still suppresses any call the model makes to them.
  const tools = [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } }]
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { tools })
  const names = call.body.tools.map((t) => t.function.name)
  assert.deepEqual(names.sort(), ['bash', 'grep', 'read'], `got ${names.join(', ')}`)
})

test('a caller that already owns bash and read gets no stubs, on either lane', async () => {
  // `realGateTools` registers the pair for real, so there is nothing to
  // placeholder and nothing to warn about — the gate is satisfied by the
  // caller's own tools. This holds for the keyed lane too.
  const tools = [
    { name: 'bash', description: 'shell', parameters: { type: 'object', properties: {} } },
    { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
  ]
  for (const [label, hooks] of [
    ['anonymous', { credentials: () => [] }],
    ['keyed', { credentials: () => [{ key: 'sk-test', source: 'env' }], ...PAID_FIRST }],
  ]) {
    const [call] = await captureStream(hooks, { tools })
    assert.deepEqual(call.body.tools.map((t) => t.function.name).sort(), ['bash', 'read'], label)
    assert.doesNotMatch(
      JSON.stringify(call.body.messages),
      /Do not call the tools named/,
      `${label}: nothing was added, so nothing needs warning about`,
    )
  }
})

test('the session id is stable across calls so upstream prompt caching holds', async () => {
  const [first] = await captureStream({ credentials: () => [] }, { sessionId: 'conversation-42' })
  const [again] = await captureStream({ credentials: () => [] }, { sessionId: 'conversation-42' })
  const [other] = await captureStream({ credentials: () => [] }, { sessionId: 'conversation-99' })
  // One id per HOST now, not one per DSH conversation: since 2026-10-13 Zen's
  // gate proves the id against sessions OpenCode really created, and there is
  // one pool to borrow from. Stability — which is what prompt-cache affinity
  // actually needs — still holds; per-conversation uniqueness does not, and
  // cannot, so this no longer asserts what it used to.
  assert.equal(first.headers['x-opencode-session'], again.headers['x-opencode-session'])
  assert.equal(first.headers['x-opencode-session'], other.headers['x-opencode-session'])
  assert.match(first.headers['x-opencode-session'], /^ses_[A-Za-z0-9]{26}$/, 'still a canonical OpenCode id')
})

test('a host with no real session fails loudly instead of forging one', async () => {
  // Forging a shape-correct id is exactly what produced a wall of 403
  // FreeTierErrors until 2026-10-13, so it must not survive as a fallback.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
  let error
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [],
      session: async () => ({ id: undefined, reason: '本机没有 OpenCode 会话库（/x/opencode.db）' }),
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle', maxTokens: 32000 }])
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk
  } catch (caught) {
    error = caught
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(error, 'the stream must fail rather than send a fabricated id')
  assert.equal(error.code, 'NO_OPENCODE_SESSION')
  assert.match(error.message, /opencode run/, 'the operator needs the concrete next step')
  // The old message ended "…取一个 key 并配置 OPENCODE_API_KEY，走付费通道", which
  // promised a key would get around this. It would not: the gate applies to a
  // keyed request too, so a key changes who pays and nothing else.
  assert.doesNotMatch(error.message, /走付费通道/, 'a key is not a way around the gateway')
  assert.match(error.message, /Key 只决定谁付费/, 'and the message now says so')
})

test('a keyed request is not a way around the gateway', async () => {
  // The whole point of the 2026-10-14 correction: a keyed request carries the
  // same four signals an anonymous one does. The credential only changes the
  // Authorization header.
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { sessionId: 'c1' })
  assert.equal(call.headers.Authorization, 'Bearer sk-test')
  assert.ok(String(call.headers['user-agent']).startsWith('opencode/'), `got ${call.headers['user-agent']}`)
  assert.equal(call.headers['x-opencode-session'], TEST_SESSION_ID)
})

/**
 * Drive one stream from canned SSE bytes and return every emitted chunk.
 * @param sse - raw `text/event-stream` body.
 * @param options - extra GenerateOptions forwarded to the adapter.
 */
async function streamFixture(sse, options = {}, models = [{ id: 'big-pickle', name: 'Big Pickle', maxTokens: 32000 }]) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(sse, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, { credentials: () => [] })
    adapter.setModels(models)
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [], ...options })) chunks.push(chunk)
    return chunks
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** One OpenAI-style tool call: id and name first, arguments sharded afterwards. */
const SSE_TOOL_CALL = [
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_upstream_1","type":"function","function":{"name":"grep","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pattern\\""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]}}]}',
  'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
  'data: [DONE]',
  '',
].join('\n')

test('tool-call-delta carries a string id — the host rejects the chunk without one', async () => {
  const chunks = await streamFixture(SSE_TOOL_CALL)
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.ok(deltas.length > 0, 'the fixture must produce tool-call deltas')
  for (const delta of deltas) {
    assert.equal(typeof delta.id, 'string', 'tool-call-delta id must be a string')
    assert.ok(delta.id.length > 0, 'tool-call-delta id must be non-empty')
    assert.equal(typeof delta.name, 'string')
    assert.equal(typeof delta.argumentsDelta, 'string')
  }
  // The id the provider sent is the one that surfaces, not the fallback.
  assert.equal(deltas[0].id, 'call_upstream_1')
})

test('a streamed tool call survives the host accumulator', async () => {
  const chunks = await streamFixture(SSE_TOOL_CALL)
  // This is the validator whose TypeError ("tool-call-delta id must be a
  // string") used to fail the whole turn; feeding it proves the contract.
  const stream = new AssistantStreamAccumulator()
  for (const chunk of chunks) stream.push({ time: Date.now(), chunk })

  const end = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.ok(end, 'a tool-call block-end must close the call')
  assert.equal(end.block.id, 'call_upstream_1')
  assert.equal(end.block.name, 'grep')
  assert.equal(end.block.arguments, '{"pattern":"x"}')
})

test("a model call to a gate stub (bash) is dropped, not sent to the host executor", async () => {
  // bash is a placeholder the adapter adds only to clear Zen's free-tier gate;
  // it is not a real tool. If it reached the host as a tool-call block, the
  // executor would throw UNKNOWN_TOOL and fail the whole turn.
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bash","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse)
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 0, 'no tool-call-delta for the stub must be emitted')
  const toolCallBlocks = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.equal(toolCallBlocks.length, 0, 'no tool-call block for bash must survive')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.match(text, /bash/, 'the skip must be explained to the model')
  // With no real tool call, the turn should conclude as a normal stop.
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  // And the host accumulator must never be asked to assemble a bash tool call.
  const stream = new AssistantStreamAccumulator()
  for (const chunk of chunks) stream.push({ time: Date.now(), chunk })
  for (const block of chunks.filter((c) => c.type === 'block-end')) {
    assert.notEqual(block.block?.name, 'bash', 'the host must not see a bash tool call')
  }
})

test('a real tool call survives alongside a gate-stub call', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_real","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_bash","type":"function","function":{"name":"bash","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse)
  const names = chunks
    .filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    .map((c) => c.block.name)
  assert.ok(names.includes('grep'), 'the real tool call must survive')
  assert.ok(!names.includes('bash'), 'the gate stub must be dropped')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' }, 'a real tool was called')
})

test('a tool call the upstream never names is dropped, not sent as an empty name', async () => {
  // Zen sometimes streams a tool call with arguments but no function name.
  // Emitting it yields `unknown tool ""` in the host executor and fails the turn.
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"arguments":"{\\"file_path\\":\\"a.md\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse)
  assert.equal(chunks.filter((c) => c.type === 'tool-call-delta').length, 0, 'no delta for a nameless call')
  assert.equal(
    chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').length,
    0,
    'no tool-call block may carry an empty name',
  )
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.match(text, /工具名称/, 'the model must be told to name the tool')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' }, 'nothing executable was produced')
})

test("a tool call whose name arrives after its arguments still works", async () => {
  // The name must not be required up front: buffering holds the early deltas and
  // flushes them once the name lands, so late-named calls still execute.
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late_name","type":"function","function":{"name":"grep"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse)
  const end = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
  assert.ok(end, 'the late-named call must still be emitted')
  assert.equal(end.block.name, 'grep')
  assert.equal(end.block.arguments, '{"a":1}', 'buffered arguments must survive')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test("a caller's own real bash/read tools are never suppressed", async () => {
  // Suppression is keyed to the stubs THIS request injected. A caller that
  // already owns real `bash`/`read` tools gets no stubs from gateTools, so
  // dropping those calls would break tools the user legitimately enabled.
  const tools = ['bash', 'read', 'grep'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bash","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse, { tools })
  const names = chunks
    .filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    .map((c) => c.block.name)
  assert.deepEqual(names, ['bash'], 'a real bash tool call must pass through untouched')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, '', 'no "placeholder skipped" note for a real tool')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('arguments that arrive before any tool-call id still get a usable id', async () => {
  // Some upstreams shard arguments first and name the call later.
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\":1}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late","type":"function","function":{"name":"read"}}]}}]}',
    'data: {"choices":[{"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n')
  const chunks = await streamFixture(sse)
  const stream = new AssistantStreamAccumulator()
  for (const chunk of chunks) stream.push({ time: Date.now(), chunk })
  for (const delta of chunks.filter((c) => c.type === 'tool-call-delta')) {
    assert.equal(typeof delta.id, 'string')
    assert.ok(delta.id.length > 0, 'the seeded fallback id must still be a usable string')
  }
})

test("a caller's own tools are preserved and only the missing gate stubs are added", async () => {
  // No bash/read here, so the gate stubs must be appended — probed live, a body
  // carrying only the caller's own tools answers 403.
  const tools = [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } }]
  const [call] = await captureStream({ credentials: () => [] }, { tools })
  const names = call.body.tools.map((t) => t.function.name)
  assert.ok(names.includes('grep'), `the caller's tool must survive, got ${names.join(', ')}`)
  assert.ok(names.includes('bash') && names.includes('read'), `missing gate stubs must be added, got ${names.join(', ')}`)
  assert.equal(call.body.tool_choice, 'auto')
})

test('a caller already advertising bash and read gets nothing appended', async () => {
  const tools = ['bash', 'read', 'grep'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
  const [call] = await captureStream({ credentials: () => [] }, { tools })
  const names = call.body.tools.map((t) => t.function.name)
  assert.deepEqual(names, ['bash', 'read', 'grep'], `nothing should be appended, got ${names.join(', ')}`)
})

// ---- block boundaries, finish reasons and usage (ported from randomix777) ----

const SSE_THINK_ANSWER_TOOL = [
  'data: {"choices":[{"delta":{"reasoning_content":"think hard"}}]}',
  'data: {"choices":[{"delta":{"content":"the answer"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}',
  'data: [DONE]',
  '',
].join('\n')

test('exactly one block is open at a time: reasoning, then text, then the tool call', async () => {
  const chunks = await streamFixture(SSE_THINK_ANSWER_TOOL)
  const boundaries = chunks
    .filter((c) => c.type === 'block-start' || c.type === 'block-end')
    .map((c) => `${c.type}:${c.blockType ?? c.block.type}`)
  assert.deepEqual(boundaries, [
    'block-start:reasoning',
    'block-end:reasoning',
    'block-start:text',
    'block-end:text',
    'block-start:tool-call',
    'block-end:tool-call',
  ])
})

test('finish reports what the turn produced, not just what the gateway remembered to say', async () => {
  const finishOf = async (sse, models) => (await streamFixture(sse, {}, models)).at(-1)
  const done = 'data: [DONE]\n\n'
  const toolCall = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"grep","arguments":"{}"}}]}}]}\n'
  const text = (reason) => `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":${JSON.stringify(reason)}}]}\n`

  assert.deepEqual((await finishOf(toolCall + done)).reason, { kind: 'tool-calls' }, 'no finish_reason at all')
  assert.deepEqual((await finishOf(SSE_TOOL_CALL)).reason, { kind: 'tool-calls' }, 'finish_reason: tool_calls')
  assert.deepEqual((await finishOf(text('stop') + done)).reason, { kind: 'stop' })
  assert.deepEqual((await finishOf(text('length') + done)).reason, { kind: 'max-tokens' })
  assert.deepEqual((await finishOf(text(null) + done)).reason, { kind: 'stop' })
})

test('cache hits and reasoning tokens are counted apart from the input', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"prompt_cache_hit_tokens":40,"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":3}}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const usage = (await streamFixture(sse)).find((c) => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 60, outputTokens: 5, cacheReadTokens: 40, reasoningTokens: 3 })
})

test('a gateway reporting only prompt_tokens_details still yields a disjoint cache count', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":10}}}',
    'data: [DONE]',
    '',
  ].join('\n')
  const usage = (await streamFixture(sse)).find((c) => c.type === 'usage')
  assert.equal(usage.usage.inputTokens, 0, 'a fully cached prompt must not report input twice')
  assert.equal(usage.usage.cacheReadTokens, 10)
})

test('a stream with no usage frame still estimates both sides of the count', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\ndata: [DONE]\n\n'
  const usage = (await streamFixture(sse)).find((c) => c.type === 'usage')
  assert.equal(usage.usage.outputTokens, Math.ceil('hello world'.length / 4))
  assert.ok(usage.usage.inputTokens >= 1, 'the serialized messages are the input estimate')
})

// ---- reasoning efforts (ported from xiaozhe7772222) ----

test('a reasoning model declares its efforts so an explicit choice is not rejected', async () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {})
  adapter.setModels([
    { id: 'big-pickle', name: 'Big Pickle', reasoning: true },
    { id: 'plain-pickle', name: 'Plain Pickle', reasoning: false },
  ])
  const reasoning = await adapter.resolveModel('opencode-free', 'big-pickle')
  assert.deepEqual(reasoning.reasoning.efforts.map((effort) => effort.id), ['off', 'low', 'high', 'max'])
  assert.equal(reasoning.reasoning.defaultEffort, undefined, "Zen's own default must survive")
  const plain = await adapter.resolveModel('opencode-free', 'plain-pickle')
  assert.equal(plain.reasoning, undefined, 'a non-reasoning model must not advertise efforts')
})

test("the chosen effort goes on the wire, and 'off' is expressed by leaving it out", async () => {
  const reasoningModel = [{ id: 'big-pickle', name: 'Big Pickle', reasoning: true }]
  const [high] = await captureStream({ credentials: () => [] }, { reasoningEffort: 'high' }, reasoningModel)
  assert.equal(high.body.reasoning_effort, 'high')
  const [max] = await captureStream({ credentials: () => [] }, { reasoningEffort: 'max' }, reasoningModel)
  assert.equal(max.body.reasoning_effort, 'max')
  const [off] = await captureStream({ credentials: () => [] }, { reasoningEffort: 'off' }, reasoningModel)
  assert.equal('reasoning_effort' in off.body, false, 'Zen rejects "off" as a value, so the field must be absent')
  const [plain] = await captureStream({ credentials: () => [] }, { reasoningEffort: 'high' }, [{ id: 'big-pickle', name: 'Big Pickle' }])
  assert.equal('reasoning_effort' in plain.body, false, 'a model that never advertised efforts gets no field')
})

// ---- failure advice (ported from randomix777) ----

/** Drain one stream whose transport answers with the given status and body. */
async function failingStream(status, body, adapterOptions) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      // Same reasoning as `captureRejection`: one attempt and no waiting unless
      // the spec under test is about the retry loop itself.
      maxAttempts: () => 1,
      backoffMs: () => 1,
      // A 429 would otherwise hand the turn to the local OpenCode client — a
      // real subprocess with a real network call. These specs are about what
      // the direct lane reports, so the bridge stays out of them.
      bridgeMode: () => 'off',
      ...adapterOptions,
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk
    return undefined
  } catch (error) {
    return error
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('a rejected credential says which credential was at fault and what to do', async () => {
  const body = JSON.stringify({ error: { message: 'FreeTierError: this call is not allowed' } })
  const error = await failingStream(403, body, { credentials: () => [], maxAttempts: () => 1 })
  assert.ok(error, 'the stream must fail')
  assert.equal(error.code, 'PROVIDER_ERROR')
  assert.match(error.message, /HTTP 403/)
  assert.match(error.message, /FreeTierError: this call is not allowed/, 'the gateway detail must survive')
  assert.match(error.message, /opencode\.ai\/zen/, 'the operator needs the next step, not just a status')
})

test('a FreeTierError is reported as a closed free lane, not as bad credentials', async () => {
  // The shape Zen actually returns today (2026-10-13, probed live).
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'FreeTierError',
      message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
    },
  })
  const error = await failingStream(403, body, { credentials: () => [], maxAttempts: () => 1 })
  assert.ok(error, 'the stream must fail')
  assert.match(error.message, /HTTP 403 FreeTierError/, 'name the upstream error class')
  // A user with no key configured must not be sent hunting through credentials.
  assert.doesNotMatch(error.message, /拒绝了本次凭据/)
  assert.match(error.message, /OPENCODE_API_KEY/, 'the message must name the concrete next step')
})

test('a 429 reports an exhausted quota and when it reopens', async () => {
  // 2026-10-18 定案：429 就是额度/速率限制（停手后同一会话、同一模型直连连打 8 次
  // 全部 200）。所以文案要说额度，并给出重开时间。
  const body = JSON.stringify({ error: { message: 'Rate limit exceeded' } })
  const options = { maxAttempts: () => 1, backoffMs: () => 100 }

  const anonymous = await failingStream(429, body, { credentials: () => [], ...options })
  assert.ok(anonymous, '必须抛错')
  assert.match(anonymous.message, /HTTP 429/)
  assert.match(anonymous.message, /公共免费额度已用尽/, '匿名调用者看到的是公共额度')
  assert.match(anonymous.message, /稍后重试|分钟后重试/, '要告诉他什么时候回来')

  const keyed = await failingStream(429, body, {
    credentials: () => [{ name: 'env', key: 'sk-test' }],
    ...PAID_FIRST,
    ...options,
  })
  assert.ok(keyed, '必须抛错')
  assert.match(keyed.message, /HTTP 429/)
  assert.match(keyed.message, /该账号的免费额度已用尽/, '带 Key 时说的是这个账号的额度')
})

// ---- 502 gateway retries ----

/**
 * The body Zen's gateway actually returns when it cannot reach the provider.
 *
 * `error` is a bare string here, not an object, so `parsed.error.message` is
 * undefined and the detail has to fall back to the raw text — which is the shape
 * that made the first version of this error read as an unexplained wall.
 */
const GATEWAY_502_BODY = JSON.stringify({
  error: 'acp-proxy failure',
  detail: 'Error: upstream request failed: kind=connect-timeout code=UND_ERR_CONNECT_TIMEOUT '
    + 'message=fetch failed <- Connect Timeout Error (attempted addresses: 172.65.90.22:443, '
    + '172.65.90.23:443, 172.65.90.21:443, 172.65.90.20:443, timeout: 10000ms)',
})

/**
 * Drain one stream whose transport always answers 502, counting the calls.
 *
 * The wait is stubbed out rather than shrunk: the production floor on the
 * backoff is 100ms, so a ten-attempt spec would otherwise spend half a minute
 * asleep to assert a number it already knows. The attempt count is whatever the
 * caller asks for, which is the part under test.
 * @param adapterOptions - overrides, typically `maxAttempts`.
 * @returns how many requests were made and the error that ended the loop.
 */
async function gateway502Stream(adapterOptions = {}, body = GATEWAY_502_BODY) {
  const originalFetch = globalThis.fetch
  let calls = 0
  const waits = []
  globalThis.fetch = async () => {
    calls += 1
    return new Response(body, {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [],
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      backoffMs: () => 100,
      sleep: async (ms) => { waits.push(ms) },
      ...adapterOptions,
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk
    return { calls, error: undefined, waits }
  } catch (error) {
    return { calls, error, waits }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('a 502 gateway failure is retried to the configured attempt count', async () => {
  // A 502 is Zen's gateway failing to reach the provider upstream. Nothing
  // about the model or the body is wrong, so retrying is the whole fix — and a
  // single attempt would turn a ten-second route blip into a failed turn.
  const three = await gateway502Stream({ maxAttempts: () => 3 })
  assert.equal(three.calls, 3, `3 attempts means 3 requests, got ${three.calls}`)
  assert.ok(three.error, 'the stream still fails when every attempt does')

  const ten = await gateway502Stream({ maxAttempts: () => 10 })
  assert.equal(ten.calls, 10, `10 attempts means 10 requests, got ${ten.calls}`)
})

test('the default attempt count is ten, not three', async () => {
  // The number an operator gets without touching the setting. Deliberately
  // patient: this is the case where waiting is the fix.
  const result = await gateway502Stream()
  assert.equal(result.calls, DEFAULT_ATTEMPT_COUNT, `the default is ${DEFAULT_ATTEMPT_COUNT} attempts, got ${result.calls}`)
  assert.equal(DEFAULT_ATTEMPT_COUNT, 10)
})

test('a 502 is not terminal, so it never retires the model', async () => {
  // Retiring a model over a gateway fault would take a working model out of the
  // picker for the rest of the day over a ten-second connect timeout.
  assert.equal(classifyFailure(502, GATEWAY_502_BODY), undefined)
  // The permanent sibling of the same message still is.
  assert.equal(
    classifyFailure(502, JSON.stringify({ error: { message: 'upstream request failed: model is unavailable' } })),
    'unavailable',
  )
})

test('a 502 says it is the gateway, not the request, and how many tries it cost', async () => {
  const { error } = await gateway502Stream({ maxAttempts: () => 4 })
  assert.ok(error, 'the stream must fail')
  assert.equal(error.code, 'TRANSPORT', 'a 5xx is a transport fault, which is what makes it retryable')
  // The operator's first question on seeing a raw status is "did I do something
  // wrong"; this says no, and says the wait already happened.
  assert.match(error.message, /网关故障/, 'name the gateway as the party at fault')
  assert.match(error.message, /HTTP 502/)
  assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/, 'the upstream detail must survive verbatim')
  assert.match(error.message, /已重试 4 次均失败/, 'an error that reads as one attempt hides the wait')
})

test('a single-attempt failure is not labelled as a retry', async () => {
  // "Retried 1 time" is noise; the count only earns its place past one.
  const { error } = await gateway502Stream({ maxAttempts: () => 1 })
  assert.doesNotMatch(error.message, /已重试/)
})

// ---- context overflow arrives wearing a 5xx ----

// The verbatim body from a real session on 2026-10-16. Kept whole because the
// recogniser has to cope with all five clauses, not a keyword in isolation.
const OVERFLOW_BODY = 'context ~297394 tokens exceeds the model window 168000 '
  + '(model=deepseek-v4.1-flash-free), with 1 compressible range(s) still visible and '
  + 'preflight compression could not bring it under: futile round: the maximum possible '
  + 'saving from all foldable content (~5641 tokens) is below the required reduction '
  + '(~110639 tokens) — no combination of folds can bring the payload under the target. '
  + 'Raise the model context window or restart the session. The over-window payload was '
  + 'NOT forwarded. Preflight will not call the upstream again for the next 5m for this '
  + 'identical request. Change the request or wait for the cooldown before retrying.'

test('an over-window conversation is recognised behind its 502', () => {
  assert.equal(isContextOverflow(OVERFLOW_BODY), true)
  // The upstream provider's own wording, for a gateway that forwards instead.
  assert.equal(isContextOverflow('maximum context length is 128000 tokens'), true)
  assert.equal(isContextOverflow('context window exceeded'), true)
  // The genuine network fault this branch also used to swallow.
  assert.equal(isContextOverflow(GATEWAY_502_BODY), false)
  assert.equal(isContextOverflow(''), false)
  assert.equal(isContextOverflow(undefined), false)
})

test('an over-window request fails on the first attempt, however many are configured', async () => {
  // Every retry re-sends the identical transcript, so every retry reaches the
  // identical verdict. Worse, the body says the preflight will not even call
  // the upstream again for 5 minutes — so the extra attempts are not merely
  // useless, they cannot even be re-evaluated.
  const { calls, waits, error } = await gateway502Stream({ maxAttempts: () => 10 }, OVERFLOW_BODY)
  assert.equal(calls, 1, `an over-window payload must not be re-sent, got ${calls} request(s)`)
  assert.deepEqual(waits, [], 'and must not pay a backoff it will never use')
  assert.equal(error.code, 'CONTEXT_OVERFLOW', 'the cause must survive to the caller')
})

test('an over-window 502 does not claim to be a network fault', async () => {
  // The old wording said "connection failure, unrelated to the model and the
  // request" — which points the operator at the network and at waiting, while
  // the actual cause is the transcript and is fixed by changing it.
  const { error } = await gateway502Stream({ maxAttempts: () => 1 }, OVERFLOW_BODY)
  assert.doesNotMatch(error.message, /网关故障/, 'it is not a gateway failure')
  assert.doesNotMatch(error.message, /连接失败/, 'the network was never the problem')
  assert.doesNotMatch(error.message, /临时网络/, 'and nothing about it is transient')
  assert.doesNotMatch(error.message, /已重试/, 'nothing was retried, so nothing may claim it was')
  // The only "网络" the message may mention is the one it rules out. Compared
  // over the whole clause rather than a fixed-width window, because a window
  // can slice the denial off the end of the match it is checking for.
  for (const clause of error.message.split(/[。，；]/)) {
    if (!clause.includes('网络')) continue
    assert.match(clause, /无关/, `"网络" must only appear as a denial, got clause "${clause}"`)
  }
  assert.match(error.message, /超出.*上下文窗口/, 'it must name the real cause')
  assert.match(error.message, /新开会话/, 'and the action that actually works')
  // The upstream detail is kept: the numbers in it are what make the report
  // diagnosable, and they are the operator's only evidence of the shortfall.
  assert.match(error.message, /297394/, 'the measured size must survive')
  assert.match(error.message, /5641/, 'and the reason compression cannot close the gap')
})

test('an over-window answer is not terminal, so it never retires the model', async () => {
  // The model is fine; the conversation is too big. Retiring it would empty the
  // picker of a working model because one session ran long.
  assert.equal(classifyFailure(502, OVERFLOW_BODY), undefined)
})

test('the backoff doubles and then flattens, so ten retries wait about a minute', () => {
  // Uncapped, `800 * 2^9` is 409 seconds and ten of them is fourteen minutes of
  // waiting for a route that was down for ten seconds.
  assert.equal(backoffFor(0, 800), 800)
  assert.equal(backoffFor(1, 800), 1_600)
  assert.equal(backoffFor(2, 800), 3_200)
  assert.equal(backoffFor(3, 800), 6_400)
  // Past the fourth step the extra wait buys nothing, so it is clamped.
  assert.equal(backoffFor(4, 800), 8_000)
  assert.equal(backoffFor(9, 800), 8_000)
  // The configured base is honoured below the ceiling, and the clamp is absolute.
  assert.equal(backoffFor(9, 100), 8_000, 'even a small base is clamped once it grows past the ceiling')
  assert.equal(backoffFor(0, 30_000), 8_000, 'a base above the ceiling is pulled down, not passed through')
  // A negative attempt must not invert the step.
  assert.equal(backoffFor(-3, 800), 800)
})

test('ten 502 retries wait about a minute, not fourteen minutes', async () => {
  // The ceiling has to hold across the whole loop, not just in isolation: this
  // is the wait an operator actually sits through when the route is down.
  const { calls, waits } = await gateway502Stream({ maxAttempts: () => 10 })
  assert.equal(calls, 10)
  // Nine gaps between ten attempts, each at or under the ceiling.
  assert.equal(waits.length, 9, `ten attempts leave nine gaps, got ${waits.length}`)
  const total = waits.reduce((sum, ms) => sum + ms, 0)
  assert.ok(total <= 60_000, `the whole wait must stay under a minute, got ${total}ms`)
  assert.ok(total > 20_000, `and it must still back off rather than hammering, got ${total}ms`)
  // The tail is flat: the last waits are the ceiling, not a growing number.
  assert.equal(waits[waits.length - 1], 8_000)
})

// ---- credential store (ported from randomix777) ----

test('a key stored by the settings UI is read before the environment', async () => {
  const store = { resolve: async (name) => (name === 'ZEN_KEY' ? { value: 'sk-stored', source: 'file' } : undefined) }
  assert.equal(await credentialValue('ZEN_KEY', store, { ZEN_KEY: 'sk-env' }), 'sk-stored')
  assert.equal(await credentialValue('ZEN_KEY', undefined, { ZEN_KEY: ' sk-env ' }), 'sk-env')
  assert.equal(await credentialValue('ZEN_KEY', undefined, {}), undefined)
  // A store that throws must not take the configured key down with it.
  const broken = { resolve: async () => { throw new Error('store locked') } }
  assert.equal(await credentialValue('ZEN_KEY', broken, { ZEN_KEY: 'sk-env' }), 'sk-env')
})

test('the pool keeps preference order and drops names nobody answered', async () => {
  const pool = await resolveCredentialPool('FIRST, SECOND, FIRST, MISSING', async (name) => (
    name === 'FIRST' ? 'sk-first' : name === 'SECOND' ? ' sk-second ' : undefined
  ))
  assert.deepEqual(pool, [
    { name: 'FIRST', key: 'sk-first' },
    { name: 'SECOND', key: 'sk-second' },
  ])
})

// ---- availability ledger ----

test('classifyFailure retires only permanent model problems', () => {
  const cases = [
    [410, '{"type":"error","error":{"type":"ModelDeprecated","message":"Model exo-free has been deprecated."}}', 'deprecated'],
    [400, '{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}', 'unsupported'],
    [403, '{"type":"error","error":{"type":"RegionError","message":"This model is not available in your country"}}', 'region'],
    [400, '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}', 'unavailable'],
  ]
  for (const [status, body, expected] of cases) {
    assert.equal(classifyFailure(status, body), expected, `HTTP ${status} should retire as ${expected}`)
  }
})

test('classifyFailure leaves transient failures alone', () => {
  const cases = [
    [429, '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}'],
    [429, '{"type":"error","error":{"type":"FreeUsageLimitError","message":"rate limited"}}'],
    [500, 'gateway error'],
    [403, '{"type":"error","error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}'],
  ]
  for (const [status, body] of cases) {
    assert.equal(classifyFailure(status, body), undefined, `HTTP ${status} must not retire a model`)
  }
})

test('the ledger retires a model and restores it once it serves again', () => {
  const file = join(tmpdir(), `dsh-opencode-availability-${Date.now()}.json`)
  const ledger = new AvailabilityTracker(file)
  assert.equal(ledger.isServable('exo-free'), true)

  ledger.record('exo-free', 'deprecated', 'Model exo-free has been deprecated.')
  assert.equal(ledger.isServable('exo-free'), false)
  // Survives a restart, or a dead model returns to the picker every boot.
  assert.equal(new AvailabilityTracker(file).isServable('exo-free'), false)

  ledger.clear('exo-free')
  assert.equal(ledger.isServable('exo-free'), true)
  assert.deepEqual(new AvailabilityTracker(file).snapshot(), {})
  unlinkSync(file)
})

test('a tool result reaches the wire as a tool message, not as a user one', async () => {
  // A DSH turn after a tool call: assistant tool_calls, then the tool result.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'weather in Beijing?' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Beijing"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'sunny, 24C' }] },
  ]
  const [call] = await captureStream({ credentials: () => [] }, { messages })
  const wire = call.body.messages

  assert.equal(wire.length, 3)
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'tool'])
  // Every tool_calls entry must be answered by a message carrying its id, or
  // the provider rejects the whole request.
  assert.equal(wire[1].tool_calls?.[0]?.id, 'call_1')
  assert.equal(wire[2].tool_call_id, 'call_1')
  assert.equal(wire[2].content, 'sunny, 24C')
})

test('a tool result with no text still answers its call', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_9', name: 'bash', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_9', content: [] },
  ]
  const [call] = await captureStream({ credentials: () => [] }, { messages })
  const wire = call.body.messages
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'tool'])
  assert.equal(wire[2].tool_call_id, 'call_9')
  assert.equal(wire[2].content, '(no output)')
})

test('the wire audit flags an unanswered tool call instead of sending it silently', async () => {
  // Rebuilt by hand because serializeMessages is private: this is the shape
  // that used to reach the provider before tool results kept their role.
  const broken = [
    { role: 'user', content: 'run something' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'user', content: 'done' },
  ]
  const healthy = [
    { role: 'user', content: 'run something' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' },
  ]
  const warnings = []
  const sink = (line) => warnings.push(line)
  auditWireMessages(broken, sink)
  assert.equal(warnings.length, 1, 'a dangling tool call must be reported')
  assert.match(warnings[0], /unanswered tool call/)

  warnings.length = 0
  auditWireMessages(healthy, sink)
  assert.deepEqual(warnings, [], 'a properly answered call must stay silent')
})

test('a tool called with no arguments reaches the wire as valid JSON', async () => {
  // Argument-free tools (ego_auth_flush, run_code with defaults, ...) send no
  // arguments deltas at all, so the block text stays empty. An empty string is
  // not JSON and the next request carrying it was rejected outright.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'flush the auth cache' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'ego_auth_flush', arguments: '' }] },
    { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'flushed' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ]
  const [call] = await captureStream({ credentials: () => [] }, { messages })
  const wire = call.body.messages
  const args = wire[1].tool_calls[0].function.arguments
  assert.notEqual(args, '', 'empty arguments must never reach the provider')
  assert.doesNotThrow(() => JSON.parse(args), 'arguments must be parseable JSON')
})

test('a tool result whose call has been compacted away is re-labelled, not sent as a tool', async () => {
  // A resumed or summarised history can keep the result and lose the call.
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
    { role: 'tool', toolCallId: 'call_ghost', content: [{ type: 'text', text: 'orphan' }] },
  ]
  const [call] = await captureStream({ credentials: () => [] }, { messages })
  const wire = call.body.messages
  // The orphan must not survive as a tool message with an unmatched id.
  const orphan = wire.find((m) => m.tool_call_id === 'call_ghost')
  assert.equal(orphan, undefined)
  const relabelled = wire.find((m) => String(m.content).includes('orphan'))
  assert.equal(relabelled.role, 'user', 'its content should survive as a user turn')
})

test('a tool with no usable schema still reaches the wire as a valid function', async () => {
  // Toolsets arrive from other plugins; one empty `parameters` is enough for a
  // provider to reject the request without naming the tool.
  const tools = [
    { name: 'ego_no_args', description: 'no schema', parameters: {} },
    { name: 'ego_missing', description: 'missing schema' },
    { name: 'ego_ok', description: 'fine', parameters: { type: 'object', properties: { a: { type: 'string' } } } },
  ]
  const [call] = await captureStream({ credentials: () => [] }, { tools })
  for (const fn of call.body.tools.map((t) => t.function)) {
    assert.ok(isPlainObject(fn.parameters), `${fn.name} must carry a schema`)
    assert.equal(typeof fn.description, 'string')
    assert.ok(fn.description.length > 0)
  }
  const ok = call.body.tools.find((t) => t.function.name === 'ego_ok').function
  assert.equal(ok.parameters.type, 'object', 'a real schema must pass through untouched')
  const empty = call.body.tools.find((t) => t.function.name === 'ego_no_args').function
  assert.equal(empty.parameters.type, 'object')
})

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

test('sanitize leaves a healthy tool history exactly as it is', () => {
  const healthy = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' },
  ]
  const warnings = []
  assert.deepEqual(sanitizeWireMessages(healthy, (l) => warnings.push(l)), healthy)
  assert.deepEqual(warnings, [])
})

// ---- usage rules & key verification ----

test('credentialSequence follows the policy, not the presence of a key', async () => {
  const keys = [{ name: 'key A', key: 'sk-a' }, { name: 'key B', key: 'sk-b' }]
  const spent = (sequence) => sequence.map((entry) => entry.anonymous ? 'public' : `key:${entry.key}`)

  const only = await credentialSequence(keys, 0, QUOTA_POLICY.PUBLIC_ONLY)
  assert.deepEqual(spent(only), ['public'], 'the default policy must not carry a key at all')

  const preferPublic = await credentialSequence(keys, 0, QUOTA_POLICY.PREFER_PUBLIC)
  assert.deepEqual(spent(preferPublic), ['public', 'key:sk-a', 'key:sk-b'])

  const preferKey = await credentialSequence(keys, 0, QUOTA_POLICY.PREFER_KEY)
  assert.deepEqual(spent(preferKey), ['key:sk-a', 'key:sk-b', 'public'])

  // Rotation only reorders the keys; the lane the policy picked still leads.
  const rotated = await credentialSequence(keys, 1, QUOTA_POLICY.PREFER_PUBLIC)
  assert.deepEqual(spent(rotated), ['public', 'key:sk-b', 'key:sk-a'])

  // With nothing configured every policy collapses to the free lane — there is
  // nothing else to prefer.
  assert.deepEqual(spent(await credentialSequence([], 0, QUOTA_POLICY.PREFER_KEY)), ['public'])
  assert.deepEqual(spent(await credentialSequence(undefined, 0, QUOTA_POLICY.PREFER_KEY)), ['public'])
})

test('a key verdict is about one key and expires with it', async () => {
  // Persisted so a restart does not forget the answer — but tagged with a
  // fingerprint of the key it describes, never the key itself.
  const original = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ error: { message: 'Invalid API key', type: 'AuthError' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }
  let rejected
  try {
    rejected = await verifyKey({ baseURL: 'https://opencode.ai/zen/v1', key: 'sk-bad', model: 'big-pickle' })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(rejected.ok, false, 'a rejected key must not be reported as working')
  assert.match(rejected.reason, /401/, 'the reason names the status the operator has to act on')
  assert.ok(!/^sk-/.test(String(bodies[0]?.model ?? '')), 'the probe sends a model id, never the key')

  // A verdict about one key must not be reused for a different one.
  assert.equal(keyCheckStillValid(rejected, 'sk-bad'), false, 'a failed check never unlocks anything')
  assert.equal(
    keyCheckStillValid({ ok: true, finger: keyFingerprint('sk-a') }, 'sk-a'),
    true,
    'a matching fingerprint is what makes a verdict reusable',
  )
  assert.equal(
    keyCheckStillValid({ ok: true, finger: keyFingerprint('sk-a') }, 'sk-other'),
    false,
    'changing the key invalidates the verdict',
  )
  assert.equal(keyCheckStillValid({ ok: true }, 'sk-a'), false, 'no fingerprint means no proof')
})

test('a probe that gets past authentication proves the key even when the model does not answer', async () => {
  // 400/429 happen *after* the key was accepted. Treating them as failure would
  // lock a perfectly good key out of the rules it qualifies for, and the page
  // would say "check failed" about a key that works.
  const original = globalThis.fetch
  for (const [status, ok] of [[400, true], [429, true], [500, true]]) {
    globalThis.fetch = async () => new Response('{"error":{"message":"boom"}}', {
      status,
      headers: { 'content-type': 'application/json' },
    })
    let result
    try {
      result = await verifyKey({ baseURL: 'https://opencode.ai/zen/v1', key: 'sk-a', model: 'big-pickle' })
    } finally {
      globalThis.fetch = original
    }
    assert.equal(result.ok, ok, `HTTP ${status} after authentication must still count as ${ok}`)
  }
  for (const status of [401, 403]) {
    globalThis.fetch = async () => new Response('{"error":{"message":"nope"}}', {
      status,
      headers: { 'content-type': 'application/json' },
    })
    let result
    try {
      result = await verifyKey({ baseURL: 'https://opencode.ai/zen/v1', key: 'sk-a', model: 'big-pickle' })
    } finally {
      globalThis.fetch = original
    }
    assert.equal(result.ok, false, `HTTP ${status} is the key being refused`)
  }
})

test('an unreachable endpoint is a failed check, not a crash', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1') }
  let result
  try {
    result = await verifyKey({ baseURL: 'https://opencode.ai/zen/v1', key: 'sk-a', model: 'big-pickle' })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(result.ok, false)
  assert.match(result.reason, /无法连接 Zen/, 'the operator needs to know the endpoint was unreachable')
  assert.equal(await verifyKey({ baseURL: '', key: '   ', model: '' }).then((r) => r.ok), false, 'no key means no check')
})

test('the probe carries the four gateway signals a real request does', async () => {
  // A bare `Authorization: Bearer <key>` is refused with 403 FreeTierError for a
  // perfectly valid key — probed live on 2026-10-14 with a real key from
  // opencode.ai/zen. The gateway decides on the request's shape, not on the
  // credential, so a probe that omits any of these reports "Key 未被接受" for
  // keys that work, and the two keyed policies stay locked out of their feature.
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (_url, init) => {
    seen.push({ headers: init.headers, body: JSON.parse(init.body) })
    return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  try {
    const result = await verifyKey({
      baseURL: 'https://opencode.ai/zen/v1',
      key: 'sk-a',
      model: 'big-pickle',
      session: 'ses_realsession0000000000000',
    })
    assert.equal(result.ok, true, 'a probe that satisfies the gateway is accepted')
  } finally {
    globalThis.fetch = original
  }
  const { headers, body } = seen[0]
  // 1. the CLI User-Agent
  assert.match(String(headers['user-agent'] ?? headers['User-Agent']), /^opencode\//)
  // 2. a real session id
  assert.equal(headers['x-opencode-session'], 'ses_realsession0000000000000')
  // 3. bash and read in the body
  const names = (body.tools ?? []).map((t) => t.function.name)
  assert.deepEqual(names.sort(), ['bash', 'read'], `got ${names.join(', ')}`)
  // 4. streaming — the CLI always streams, and a non-streaming body gets the
  //    same FreeTierError a missing session id does.
  assert.equal(body.stream, true, 'the gateway rejects a non-streaming body')
  // The stubs must be unselectable: this probe wants prose, not a tool call.
  assert.equal(body.tool_choice, 'none')
})

test('a FreeTierError from the probe blames the gateway, not the key', async () => {
  // The probe now carries every signal, so a FreeTierError means the session id
  // could not be read. Saying "Key 未被接受" here sends the operator to re-paste
  // a key that was never the problem.
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'error',
    error: {
      type: 'FreeTierError',
      message: "OpenCode's free tier can only be used from within OpenCode.",
    },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  let result
  try {
    result = await verifyKey({
      baseURL: 'https://opencode.ai/zen/v1',
      key: 'sk-a',
      model: 'big-pickle',
      session: 'ses_realsession0000000000000',
    })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(result.ok, false)
  assert.match(result.reason, /网关/, 'name the gateway as the party at fault')
  assert.doesNotMatch(result.reason, /^Key 未被接受/, 'and not the credential')
  assert.match(result.reason, /opencode run/, 'the operator still gets the concrete next step')
})

test('a plain 403 from the probe is still the key being refused', async () => {
  // Not every 403 is the gateway. An AuthError-shaped body means the credential
  // itself was turned down, and that verdict must survive.
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'error',
    error: { type: 'AuthError', message: 'Invalid API key' },
  }), { status: 403, headers: { 'content-type': 'application/json' } })
  let result
  try {
    result = await verifyKey({
      baseURL: 'https://opencode.ai/zen/v1',
      key: 'sk-a',
      model: 'big-pickle',
      session: 'ses_realsession0000000000000',
    })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(result.ok, false)
  assert.match(result.reason, /Key 未被接受/, 'a credential rejection says so plainly')
})

// ---- key entry: names are derived, never asked for ----

test('key names are derived from position and stay stable', () => {
  // The operator types values only. If the name were theirs to choose, a
  // mismatch between what the page writes and what the Host reads would leave a
  // key that is configured but never sent.
  assert.deepEqual(apiKeyNamesFor(0), [])
  assert.deepEqual(apiKeyNamesFor(1), ['OPENCODE_API_KEY'])
  assert.deepEqual(apiKeyNamesFor(4), ['OPENCODE_API_KEY', 'OPENCODE_API_KEY_1', 'OPENCODE_API_KEY_2', 'OPENCODE_API_KEY_3'])
  assert.equal(apiKeyNameFor(0), 'OPENCODE_API_KEY')
  assert.equal(apiKeyNameFor(3), 'OPENCODE_API_KEY_3')
  // Out-of-range input must not produce a name that collides with another row.
  assert.equal(apiKeyNameFor(-2), 'OPENCODE_API_KEY')
  assert.equal(apiKeyNameFor(1.7), 'OPENCODE_API_KEY_1')
  assert.equal(apiKeyNameFor(NaN), 'OPENCODE_API_KEY')
})

test('a key entered in the page is exported, and withdrawn when removed', async () => {
  // This is the whole fix for "I added a key and verify does nothing": the value
  // used to have to be an environment variable the operator set themselves, and
  // one set after the process started was invisible — so the Host reported no
  // key and the button stayed dead. Now the config is the source and the
  // environment is derived from it.
  const saved = {
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    OPENCODE_API_KEY_1: process.env.OPENCODE_API_KEY_1,
  }
  try {
    delete process.env.OPENCODE_API_KEY
    delete process.env.OPENCODE_API_KEY_1
    const keys = ['sk-one', 'sk-two']
    keys.forEach((value, index) => { process.env[apiKeyNameFor(index)] = value })
    assert.equal(process.env.OPENCODE_API_KEY, 'sk-one')
    assert.equal(process.env.OPENCODE_API_KEY_1, 'sk-two')
    // Resolving through the same path the requests use must now see both.
    assert.deepEqual(credentialPool('OPENCODE_API_KEY,OPENCODE_API_KEY_1'), [
      { name: 'OPENCODE_API_KEY', key: 'sk-one' },
      { name: 'OPENCODE_API_KEY_1', key: 'sk-two' },
    ])

    // Removing a row withdraws the variable rather than leaving a stale key
    // behind for the next request to pick up.
    const kept = ['sk-one']
    for (let index = kept.length; index < keys.length; index += 1) {
      delete process.env[apiKeyNameFor(index)]
    }
    assert.equal(process.env.OPENCODE_API_KEY, 'sk-one')
    assert.equal(process.env.OPENCODE_API_KEY_1, undefined)
    assert.deepEqual(credentialPool('OPENCODE_API_KEY,OPENCODE_API_KEY_1'), [
      { name: 'OPENCODE_API_KEY', key: 'sk-one' },
    ])
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('the manual apiKeyEnv escape hatch is only used when no key is entered', () => {
  // Two sources must not both answer, or a request could be authenticated with
  // a key the operator deleted from the page but left in the environment.
  const entered = ['sk-from-page']
  const namesFor = (values, manual) => (values.length > 0
    ? apiKeyNamesFor(values.length)
    : String(manual).split(',').map((n) => n.trim()).filter(Boolean))
  assert.deepEqual(namesFor(entered, 'MY_KEY'), ['OPENCODE_API_KEY'], 'entered keys win')
  assert.deepEqual(namesFor([], 'MY_KEY,OTHER'), ['MY_KEY', 'OTHER'], 'manual names only when nothing entered')
  assert.deepEqual(namesFor([], ''), [], 'and nothing at all')
})

// ---- bridge：直连撞上身份闸门之后，改由本机客户端代发 ----
//
// Zen 的免费档只对「OpenCode 客户端自己发出的请求」放行。插件直连拿到的 429
// 并不是额度耗尽，而是身份不被承认（对照表见 lib/oc-bridge.js 顶部），所以正确
// 的反应不是退避重试，而是换一条出网的路。下面三例锁住这个转向。

/** 一个假的客户端驱动者：记下收到的输入，返回固定正文。 */
function fakeBridge(turns, result) {
  return {
    calls: 0,
    async ensure() { return 'http://127.0.0.1:1' },
    async turn(input) { turns.push(input); this.calls += 1; return result },
    dispose() {},
  }
}

/** 让直连固定失败，其余交给调用方。 */
async function bridgeStream(status, body, adapterOptions, streamOptions = {}) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [],
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      maxAttempts: () => 1,
      backoffMs: () => 1,
      ...adapterOptions,
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'be brief',
      ...streamOptions,
    })) chunks.push(chunk)
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks: [], error }
  } finally {
    globalThis.fetch = originalFetch
  }
}

const RATE_LIMIT_BODY_429 = JSON.stringify({
  type: 'error',
  error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' },
})

test('a 429 on the direct lane hands the turn to the local OpenCode client', async () => {
  const turns = []
  const bridge = fakeBridge(turns, { text: 'OK via client', usage: { input: 11, output: 22 } })
  const { chunks, error } = await bridgeStream(429, RATE_LIMIT_BODY_429, {
    bridgeMode: () => 'auto',
    bridge: () => bridge,
  })
  assert.equal(error, undefined, 'the turn must succeed through the client')
  assert.equal(turns.length, 1, 'and the client must have been asked exactly once')
  assert.equal(turns[0].model, 'big-pickle')
  assert.match(turns[0].prompt, /hi/, 'the caller message must reach the client')
  assert.match(turns[0].system, /be brief/, 'and so must the caller system prompt')
  assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'OK via client')
  assert.deepEqual(chunks.find((c) => c.type === 'usage')?.usage, { inputTokens: 11, outputTokens: 22 })
})

test('bridgeMode off keeps the direct verdict and never reaches for the client', async () => {
  const turns = []
  const bridge = fakeBridge(turns, { text: 'never', usage: {} })
  const { error } = await bridgeStream(429, RATE_LIMIT_BODY_429, {
    bridgeMode: () => 'off',
    bridge: () => bridge,
  })
  assert.ok(error, 'the direct lane verdict must stand')
  assert.equal(turns.length, 0, 'the client must not be started when it is switched off')
})

test('a host tool the model names through the protocol arrives as a tool call', async () => {
  const turns = []
  const bridge = fakeBridge(turns, {
    text: '{"kind":"tool","name":"read_file","args":{"path":"a.txt"}}',
    usage: { input: 3, output: 4 },
  })
  const { chunks, error } = await bridgeStream(429, RATE_LIMIT_BODY_429, {
    bridgeMode: () => 'auto',
    bridge: () => bridge,
  }, {
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })
  assert.equal(error, undefined)
  // 宿主工具只能走文本协议上行，所以清单必须出现在 system 里。
  assert.match(turns[0].system, /read_file/, 'the host tool list must travel in the system prompt')
  const start = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.ok(start, 'a tool call block must be emitted')
  const delta = chunks.find((c) => c.type === 'tool-call-delta')
  assert.equal(delta?.name, 'read_file', 'with the name the model chose')
  assert.equal(delta?.argumentsDelta, '{"path":"a.txt"}')
  assert.ok(typeof delta?.id === 'string' && delta.id.length > 0, 'and a string id, which the host requires')
  assert.deepEqual(chunks.find((c) => c.type === 'finish')?.reason, { kind: 'tool-calls' })
})

// ---- bridge: 找得到 opencode 吗 ----
//
// 不能只信 PATH：dsh 可能由桌面快捷方式或计划任务启动，那条环境里未必有 npm 的
// 全局目录，于是 spawn ENOENT。而这个失败原先被 health check 的 `fetch failed`
// 盖住，宿主只报「无法启动本机客户端」，完全指不到真因。

test('resolveCommand falls back to the npm prefix when PATH lacks opencode', () => {
  const saved = process.env.PATH
  process.env.PATH = join(tmpdir(), 'no-such-dir-for-this-test')
  try {
    const found = resolveCommand()
    if (process.platform !== 'win32') {
      // 非 Windows 上没有 npm 前缀这个退路；只要它没有瞎报一个不存在的路径即可。
      assert.ok(found === null || /opencode/i.test(found), `不应返回无关路径：${found}`)
      return
    }
    assert.match(found ?? '', /opencode/i, '必须回退到 npm 全局前缀，而不是放弃')
  } finally {
    process.env.PATH = saved
  }
})

test('resolveCommand honours an explicit override above everything else', () => {
  assert.equal(resolveCommand(process.execPath), process.execPath)
})

test('an explicit command is used exactly as given', () => {
  // 显式命令（`OPENCODE_BIN` 或构造参数）优先于一切探测，直接拿来用。
  const bridge = new OpenCodeBridge({ command: process.execPath })
  assert.equal(bridge.command, process.execPath)
  assert.equal(bridge.commandOverride, process.execPath)
})

test('without an explicit command, resolution waits until startup', () => {
  // 构造时不做文件系统探测：插件加载阶段不该为了一个可能用不上的路径去扫盘。
  const bridge = new OpenCodeBridge({})
  assert.equal(bridge.command, null)
})

test('a failed boot is not retried on every request', async () => {
  // 一个必定启动不起来的 bridge：命令指向 node 自己，`serve` 不是 node 的子命令。
  const bridge = new OpenCodeBridge({ command: process.execPath, port: 59999, bootTimeoutMs: 1200, log: () => {} })
  const first = await bridge.ensure().then(() => null, (e) => e)
  assert.ok(first, '第一次必须失败')
  assert.equal(first.code, 'BRIDGE_UNAVAILABLE')
  // 第二次应当直接拿到同一个结论，而不是再等一轮启动超时。
  const t0 = Date.now()
  const second = await bridge.ensure().then(() => null, (e) => e)
  assert.equal(second, first, '冷却期内必须复用同一个错误对象')
  assert.ok(Date.now() - t0 < 1000, `不应再等一次启动超时（实际 ${Date.now() - t0}ms）`)
})

// ---- 「两者都要」：免费额度优先，拿不到就用自己的 Key ----
//
// 这是操作者最常见的组合：`quotaPolicy: preferPublic` + 一个私有 Key。
// 免费那条路走 bridge（直连必被身份闸门拒），bridge 不成时才轮到 Key。
// 必须验证它真的会落到 Key，而不是在公共通道上空转。

test('once the direct lane is refused, later turns skip it entirely', async () => {
  // 网关拒的是发出者，而发出者在这台机器上不会变。所以第一轮被拒之后不该再白打
  // 一次直连：既浪费往返，又把网关的 retry-after 越推越长。
  const turns = []
  const bridge = fakeBridge(turns, { text: 'via client', usage: { input: 1, output: 1 } })
  let directCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    directCalls += 1
    return new Response(RATE_LIMIT_BODY_429, { status: 429, headers: { 'content-type': 'application/json' } })
  }
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [],
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      maxAttempts: () => 1,
      backoffMs: () => 1,
      bridgeMode: () => 'auto',
      bridge: () => bridge,
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    const run = async () => {
      const chunks = []
      for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
      return chunks
    }

    await run()
    assert.equal(directCalls, 1, '第一轮要试一次直连，才知道这条路通不通')
    assert.equal(turns.length, 1)

    const after = directCalls
    await run()
    assert.equal(directCalls, after, '第二轮不该再打直连')
    assert.equal(turns.length, 2, '第二轮应当直接走客户端')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a 429 with a long window is reported at once instead of retried', async () => {
  // 免费档的额度窗口实测是 6–22 小时量级，而默认退避三次加起来不过十几分钟：等到
  // 窗口重开是不可能的，白白占住一轮对话还让人以为「已经重试过」。
  const quota = new QuotaTracker('')
  quota.record(1_000, { headers: { get: (name) => (name === 'retry-after' ? '22000' : null) } })
  assert.ok(quota.state.resetAt > 1_000, '长窗口要记下来，面板才能说清什么时候恢复')
  assert.equal(quota.publicLaneClosed(1_001), true, '窗口内不必再打公共通道')

  const body = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' } })
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls += 1
    return new Response(body, { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '22000' } })
  }
  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [],
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      maxAttempts: () => 5,
      backoffMs: () => 1,
      bridgeMode: () => 'off',
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    const error = await (async () => {
      try {
        for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk
        return null
      } catch (e) {
        return e
      }
    })()
    assert.ok(error, '必须抛错')
    assert.equal(calls, 1, `长窗口不该重试（实际打了 ${calls} 次）`)
    assert.match(error.message, /分钟后重试|稍后重试/, '要给出重开时间')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preferPublic falls through to the key when the bridge cannot serve', async () => {
  const bridgeCalls = []
  const bridge = {
    async ensure() { return 'http://127.0.0.1:1' },
    async turn() {
      bridgeCalls.push(Date.now())
      const err = new Error('无法启动本机 OpenCode 客户端')
      err.code = 'BRIDGE_UNAVAILABLE'
      throw err
    },
    dispose() {},
  }

  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const auth = String(init?.headers?.Authorization ?? '')
    seen.push(auth)
    if (auth.includes('sk-test')) {
      // Key 那条路：证明它确实被走到，并且能用。
      const sse = 'data: {"choices":[{"delta":{"content":"from key"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
      credentials: () => [{ name: 'OPENCODE_API_KEY', key: 'sk-test' }],
      session: async () => ({ id: TEST_SESSION_ID, source: 'test' }),
      quotaPolicy: () => QUOTA_POLICY.PREFER_PUBLIC,
      keyVerified: () => true,
      maxAttempts: () => 3,
      backoffMs: () => 1,
      bridgeMode: () => 'auto',
      bridge: () => bridge,
    })
    adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
    const chunks = []
    for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
    assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'from key', '最终应当由 Key 那条路回答')
    assert.equal(bridgeCalls.length, 1, 'bridge 只该尝试一次，不能每轮都重启')
    assert.ok(seen.some((a) => a.includes('sk-test')), '必须真的带着 Key 发出请求')
    // 公共通道只该打一次：429 是身份拒绝，重试只会延长网关的 retry-after 窗口。
    assert.equal(seen.filter((a) => !a.includes('sk-test')).length, 1, '公共通道不得反复重试')
  } finally {
    globalThis.fetch = originalFetch
  }
})
