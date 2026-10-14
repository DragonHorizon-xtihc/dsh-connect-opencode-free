import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  QUOTA_POLICY,
  ZEN_ROUTE_ID,
  buildModelSet,
  buildProviderEntry,
  describeCatalog,
  effectiveQuotaPolicy,
  formatTokens,
  resolveEntryNamespace,
  toYamlSnippet,
} from '../lib/core.js'
import { AssistantStreamAccumulator, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { ZEN_BASE_URL } from '../lib/core.js'
import { OpenCodeFreeAdapter, auditWireMessages, buildHeaders, credentialSequence, sanitizeWireMessages } from '../lib/provider.js'
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
  assert.equal(byId['gone-free'].reason, 'Zen 已下架')
  assert.equal(byId['old-free'], undefined, 'a retired model is not listed until the switch is on')
  const withRetired = describeCatalog(catalog, [], [], { includeDeprecated: true })
  assert.equal(
    Object.fromEntries(withRetired.map((r) => [r.id, r]))['old-free'].reason,
    'models.dev 标记为已弃用',
  )
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
  const hooks = { session: async () => ({ id: TEST_SESSION_ID, source: 'test' }), ...adapterOptions }
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

test('a keyed request keeps the harness attribution instead of the CLI User-Agent', async () => {
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  })
  // The paid lane must not borrow the CLI identity; attribution stays intact.
  assert.ok(String(call.headers['user-agent']).startsWith('deepseek-harness/'), `got ${call.headers['user-agent']}`)
  assert.equal(call.headers['x-opencode-session'], undefined)
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
      ...(options.quota === undefined ? {} : { quota: options.quota }),
      ...(options.policy === undefined ? {} : { ...options.policy }),
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

test('only the anonymous lane warns the model off the placeholders', async () => {
  // The warning names tools, so it may only be sent on the lane that actually
  // puts them on the wire. On the paid lane none are advertised, and telling a
  // model to avoid tools it was never offered is noise it may obey.
  const tools = [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } }]
  const [anonymous] = await captureStream({ credentials: () => [] }, { tools })
  const [keyed] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { tools })
  const warned = (call) => JSON.stringify(call.body.messages).includes('Do not call the tools named')
  assert.ok(warned(anonymous), 'the anonymous lane carries the placeholder warning')
  assert.equal(warned(keyed), false, 'the paid lane must not warn about tools it never sent')
})

test('a keyed request advertises no placeholder tools', async () => {
  // Probed: a keyed body carrying no stubs answers 401 AuthError, never 403
  // FreeTierError — the free-tier gate does not run on the authenticated route.
  // Advertising placeholders there would give a paying caller a tool the model
  // can select but nobody can execute.
  const tools = [{ name: 'grep', description: 'search', parameters: { type: 'object', properties: {} } }]
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { tools })
  const names = call.body.tools.map((t) => t.function.name)
  assert.deepEqual(names, ['grep'], `a keyed attempt must not carry gate stubs, got ${names.join(', ')}`)
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
  assert.match(error.message, /OPENCODE_API_KEY/, 'and the keyed escape hatch')
})

test('a keyed request keeps the harness identity and no CLI disguise', async () => {
  const [call] = await captureStream({
    credentials: () => [{ key: 'sk-test', source: 'env' }],
    ...PAID_FIRST,
  }, { sessionId: 'c1' })
  assert.equal(call.headers.Authorization, 'Bearer sk-test')
  assert.equal(call.headers['User-Agent'], undefined, 'a paid lane must not borrow the CLI User-Agent')
  assert.equal(call.headers['x-opencode-session'], undefined, 'a paid lane needs no forged session')
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
    const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, adapterOptions)
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

test('a 429 tells the shared quota apart from a keyed account', async () => {
  const body = JSON.stringify({ error: { message: 'Rate limit exceeded' } })
  const options = { maxAttempts: () => 1, backoffMs: () => 100 }
  const anonymous = await failingStream(429, body, { credentials: () => [], ...options })
  assert.match(anonymous.message, /HTTP 429/)
  assert.match(anonymous.message, /公共免费额度/)
  assert.match(anonymous.message, /OPENCODE_API_KEY|密钥环境变量/, 'the fix for an anonymous caller is a key')
  const keyed = await failingStream(429, body, {
    credentials: () => [{ name: 'env', key: 'sk-test' }],
    ...PAID_FIRST,
    ...options,
  })
  assert.match(keyed.message, /HTTP 429/)
  assert.match(keyed.message, /该账号|稍后重试/, 'a keyed caller already has a key; the advice must differ')
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
