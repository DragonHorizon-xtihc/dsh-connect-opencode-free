import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { test } from 'node:test'

import {
  ZEN_ROUTE_ID,
  buildModelSet,
  buildProviderEntry,
  describeCatalog,
  formatTokens,
  resolveEntryNamespace,
  routesChanged,
  toYamlSnippet,
} from '../lib/core.js'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import {
  BRIDGE_RETRIES,
  OpenCodeFreeAdapter,
  backoffFor,
  sanitizeWireMessages,
  trimMessages,
} from '../lib/provider.js'
import { mergeCatalog, serveableModels } from '../lib/discovery.js'
import { estimateResetMs } from '../lib/quota.js'
import { AvailabilityTracker, classifyFailure } from '../lib/availability.js'
import {
  OpenCodeBridge,
  parseProtocol,
  resolveCommand,
  toolProtocolOf,
  transcriptOf,
} from '../lib/oc-bridge.js'

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

test('a model Zen took down is not listed until the switch is on either', () => {
  const catalog = mergeCatalog(CATALOG, ZEN)
  const off = describeCatalog(catalog, [], [], { includeDeprecated: false })
  assert.ok(!off.some((row) => row.id === 'gone-free'),
    'a model Zen withdrew is not listed by default, retired upstream or not')
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
  assert.equal(byId['gone-free'], undefined, 'a model Zen withdrew is not listed by default')
  assert.equal(byId['old-free'], undefined, 'nor is a model models.dev retired')
  const withDead = Object.fromEntries(
    describeCatalog(catalog, [], [], { includeDeprecated: true }).map((r) => [r.id, r]),
  )
  assert.equal(withDead['gone-free'].reason, 'Zen 已下架')
  assert.equal(withDead['gone-free'].unavailable, true)
  assert.equal(withDead['old-free'].reason, 'models.dev 标记为已弃用')
  assert.equal(withDead['old-free'].unavailable, true, 'a retired model Zen also dropped is dead twice over')
})

test('routesChanged stays quiet for an unchanged set and speaks up for every move', () => {
  const route = ['opencode-zen']
  assert.equal(routesChanged(undefined, route), true)
  assert.equal(routesChanged(undefined, []), true)
  assert.equal(routesChanged(route, route), false)
  assert.equal(routesChanged([], []), false)
  assert.equal(routesChanged(route, route.slice()), false, 'a fresh array of the same routes is the same set')
  assert.equal(routesChanged(route, []), true)
  assert.equal(routesChanged([], route), true)
  assert.equal(routesChanged(['a', 'b'], ['b', 'a']), true)
  assert.equal(routesChanged(['a'], ['a', 'b']), true)
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

// ---- quota + retry primitives ----

test('estimateResetMs reads Retry-After seconds and ignores nonsense', () => {
  assert.equal(estimateResetMs({ headers: { get: () => '30' } }), 30_000)
  assert.equal(estimateResetMs({ headers: { get: () => 'soon' } }), undefined)
  assert.equal(estimateResetMs(undefined), undefined)
})

test('the backoff doubles and then flattens', () => {
  assert.equal(backoffFor(0, 800), 800)
  assert.equal(backoffFor(1, 800), 1_600)
  assert.equal(backoffFor(2, 800), 3_200)
  assert.equal(backoffFor(3, 800), 6_400)
  assert.equal(backoffFor(4, 800), 8_000)
  assert.equal(backoffFor(9, 800), 8_000)
  assert.equal(backoffFor(9, 100), 8_000, 'even a small base is clamped once it grows past the ceiling')
  assert.equal(backoffFor(0, 30_000), 8_000, 'a base above the ceiling is pulled down')
  assert.equal(backoffFor(-3, 800), 800)
})

// ---- adapter contract ----

test('adapter satisfies the LlmAdapter contract the llm service calls', async () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {})
  assert.ok(adapter instanceof LlmAdapter)
  for (const member of ['prepareCall', 'stream', 'resolveModel', 'listModels', 'providerInfo', 'providerRetryPolicy', 'imageRequestPricing']) {
    assert.equal(typeof adapter[member], 'function', `${member} must be callable`)
  }
  assert.ok(Object.getPrototypeOf(adapter).hasOwnProperty('prepareCall'), 'prepareCall must be declared on the adapter prototype')
  const prepared = await adapter.prepareCall('opencode-free', 'space-bunny-free')
  assert.deepEqual(Object.keys(prepared).sort(), ['model', 'stream'])
  assert.equal(prepared.model.id, 'space-bunny-free')
  assert.equal(typeof prepared.stream, 'function')
})

test('a reasoning model declares its efforts, a plain one does not', async () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {})
  adapter.setModels([
    { id: 'thinker', name: 'Thinker', reasoning: true },
    { id: 'plain', name: 'Plain' },
  ])
  const thinker = await adapter.resolveModel('opencode-free', 'thinker')
  assert.deepEqual(thinker.reasoning.efforts.map((e) => e.id), ['off', 'low', 'high', 'max'])
  const plain = await adapter.resolveModel('opencode-free', 'plain')
  assert.equal(plain.reasoning, undefined)
  assert.equal(plain.defaultMaxTokens, 128000)
})

test('pausing withdraws every model and refuses requests', async () => {
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => false }, {})
  adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
  assert.deepEqual(await adapter.listModels(), [])
  await assert.rejects(
    () => (async () => { for await (const chunk of adapter.stream({ model: 'big-pickle', messages: [] })) void chunk })(),
    (error) => error.code === 'PAUSED',
  )
})

// ---- bridge-only routing ----
//
// 2026-11-06 定案：出网只有一条路——本机真实 `opencode serve` 进程。直连
// （Bearer public / 伪造 session / Bun TLS / 复刻请求头）同刻实测一律 429，
// 已从 provider.js 整条删除。下面的用例锁住「只用 bridge」以及重试规则：
// 非 429 报错最多再试 3 次；429 / 上下文超窗不重试；成功即停。

/** A fake client driver. `results` is one result, or an array consumed per turn. */
function fakeBridge(turns, results) {
  let count = 0
  return {
    get calls() { return count },
    async ensure() { return 'http://127.0.0.1:1' },
    async turn(input) {
      turns.push(input)
      const i = count++
      const next = Array.isArray(results) ? results[Math.min(i, results.length - 1)] : results
      if (next instanceof Error) throw next
      return next
    },
    dispose() {},
  }
}

/** Drive one adapter.stream() and collect its chunks / error / backoff waits. */
async function runStream(hooks, options = {}) {
  const waits = []
  const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
    backoffMs: () => 1,
    sleep: async (ms) => { waits.push(ms) },
    ...hooks,
  })
  adapter.setModels([{ id: 'big-pickle', name: 'Big Pickle' }])
  const chunks = []
  let error
  try {
    for await (const chunk of adapter.stream({
      model: 'big-pickle',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'be brief',
      ...options,
    })) chunks.push(chunk)
  } catch (caught) {
    error = caught
  }
  return { chunks, error, waits }
}

function bridgeError(code, status, retryAfterMs) {
  const e = new Error(`bridge failed: ${code ?? status}`)
  if (code) e.code = code
  if (status) e.status = status
  if (retryAfterMs) e.retryAfterMs = retryAfterMs
  return e
}

test('a successful turn asks the client once and never touches global fetch', async () => {
  // If any direct path survived, it would call fetch. Make that call fatal so
  // the test fails loudly instead of quietly passing on a stale code path.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('direct HTTP must never be used') }
  try {
    const turns = []
    const bridge = fakeBridge(turns, { text: 'PONG', usage: { input: 11, output: 3 } })
    const { chunks, error, waits } = await runStream({ bridge: () => bridge })
    assert.equal(error, undefined)
    assert.equal(turns.length, 1, 'one turn, one client call')
    assert.equal(bridge.calls, 1)
    assert.equal(turns[0].model, 'big-pickle')
    assert.match(turns[0].prompt, /hi/, 'the caller message reaches the client')
    assert.match(turns[0].prompt, /be brief/, 'and so does the caller system prompt')
    assert.equal(turns[0].system, 'be brief', 'with no host tools there is no protocol section')
    assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'PONG')
    assert.deepEqual(chunks.find((c) => c.type === 'usage')?.usage, { inputTokens: 11, outputTokens: 3 })
    assert.deepEqual(chunks.find((c) => c.type === 'finish')?.reason, { kind: 'stop' })
    assert.deepEqual(waits, [], 'a success never backs off')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a non-429 client error is retried BRIDGE_RETRIES times, then reported', async () => {
  const turns = []
  const failure = bridgeError('BRIDGE_UNAVAILABLE')
  const bridge = fakeBridge(turns, failure)
  const { error, waits } = await runStream({ bridge: () => bridge })
  assert.ok(error, 'the loop must eventually fail')
  assert.equal(error, failure)
  assert.equal(turns.length, BRIDGE_RETRIES + 1, `1 initial + ${BRIDGE_RETRIES} retries`)
  assert.equal(waits.length, BRIDGE_RETRIES, 'one backoff between each pair of attempts')
  assert.ok(waits[1] > waits[0], 'backoff must grow')
  assert.match(error.message, /已重试 4 次均失败/, 'the operator sees how many attempts were spent')
})

test('a later success stops the retry loop immediately', async () => {
  const turns = []
  const bridge = fakeBridge(turns, [
    bridgeError('TRANSPORT'),
    bridgeError('TRANSPORT'),
    { text: 'recovered', usage: {} },
  ])
  const { chunks, error, waits } = await runStream({ bridge: () => bridge })
  assert.equal(error, undefined)
  assert.equal(turns.length, 3)
  assert.equal(waits.length, 2)
  assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'recovered')
})

test('a 429 is never retried, in either shape the client reports it', async () => {
  for (const failure of [bridgeError('RATE_LIMITED', 429, 60_000), bridgeError(undefined, 429)]) {
    const turns = []
    const bridge = fakeBridge(turns, failure)
    const { error, waits } = await runStream({ bridge: () => bridge })
    assert.equal(error, failure)
    assert.equal(turns.length, 1, 'retrying a closed quota only pushes the cooldown further out')
    assert.deepEqual(waits, [])
  }
})

test('a context overflow is never retried', async () => {
  const turns = []
  const failure = bridgeError('CONTEXT_OVERFLOW')
  const { error } = await runStream({ bridge: () => fakeBridge(turns, failure) })
  assert.equal(error, failure)
  assert.equal(turns.length, 1, 'the same transcript would overflow again')
})

test('a RATE_LIMITED verdict records the reopen time for the settings page', async () => {
  const recorded = []
  const turns = []
  const { error } = await runStream({
    bridge: () => fakeBridge(turns, bridgeError('RATE_LIMITED', 429, 90_000)),
    quota: { recordWait: (now, ms) => recorded.push([now, ms]) },
  })
  assert.equal(error.code, 'RATE_LIMITED')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0][1], 90_000)
  assert.ok(Number.isFinite(recorded[0][0]))
})

test('an aborted turn never starts the client', async () => {
  const turns = []
  const controller = new AbortController()
  controller.abort()
  const { error } = await runStream(
    { bridge: () => fakeBridge(turns, { text: 'never', usage: {} }) },
    { signal: controller.signal },
  )
  assert.equal(error.code, 'ABORTED')
  assert.equal(turns.length, 0)
})

test('a host tool named through the JSON protocol arrives as a tool call', async () => {
  const turns = []
  const bridge = fakeBridge(turns, {
    text: '{"kind":"tool","name":"read_file","args":{"path":"a.txt"}}',
    usage: { input: 3, output: 4 },
  })
  const { chunks, error } = await runStream({ bridge: () => bridge }, {
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  })
  assert.equal(error, undefined)
  assert.match(turns[0].system, /read_file/, 'the host tool list travels in the system prompt')
  assert.ok(chunks.some((c) => c.type === 'block-start' && c.blockType === 'tool-call'))
  const delta = chunks.find((c) => c.type === 'tool-call-delta')
  assert.equal(delta?.name, 'read_file')
  assert.equal(delta?.argumentsDelta, '{"path":"a.txt"}')
  assert.ok(typeof delta?.id === 'string' && delta.id.length > 0, 'the host requires a string id')
  assert.deepEqual(chunks.find((c) => c.type === 'finish')?.reason, { kind: 'tool-calls' })
})

test('protocol text that is not valid JSON is surfaced verbatim, not dropped', async () => {
  const turns = []
  const { chunks, error } = await runStream({
    bridge: () => fakeBridge(turns, { text: 'plain answer', usage: {} }),
  }, { tools: [{ name: 'read_file', description: 'Read', parameters: {} }] })
  assert.equal(error, undefined)
  assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'plain answer')
  assert.deepEqual(chunks.find((c) => c.type === 'finish')?.reason, { kind: 'stop' })
})

test('a final protocol answer uses its text, not the raw JSON', async () => {
  const { chunks, error } = await runStream({
    bridge: () => fakeBridge([], { text: '{"kind":"final","text":"done"}', usage: {} }),
  }, { tools: [{ name: 'read_file', description: 'Read', parameters: {} }] })
  assert.equal(error, undefined)
  assert.equal(chunks.find((c) => c.type === 'text-delta')?.text, 'done')
})

// ---- transcript shaping (what actually reaches the client) ----

test('transcriptOf keeps system, the user turn and tool call/result pairing', () => {
  const text = transcriptOf([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"BJ"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ])
  assert.match(text, /^System: rules/)
  assert.match(text, /User: weather\?/)
  assert.match(text, /get_weather\(\{"city":"BJ"\}\)/)
  assert.match(text, /Tool result \(call_1\): sunny/)
})

test('parseProtocol tolerates prose wrapped around the JSON object', () => {
  assert.deepEqual(parseProtocol('Sure: {"kind":"final","text":"ok"} — done'), { kind: 'final', text: 'ok' })
  assert.equal(parseProtocol('no json here'), null)
})

test('toolProtocolOf lists only host tools and is absent when there are none', () => {
  assert.equal(toolProtocolOf([]), '')
  assert.equal(toolProtocolOf(undefined), '')
  assert.match(toolProtocolOf([{ name: 'read_file', description: 'Read' }]), /read_file/)
})

test('trimMessages keeps the system and first user turn while dropping the oldest history', () => {
  const wire = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'the original question' },
    ...Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `filler ${i} `.repeat(500) })),
    { role: 'user', content: 'latest question' },
  ]
  const kept = trimMessages(wire, 8 * 1024)
  assert.equal(kept[0].role, 'system')
  assert.equal(kept[1].content, 'the original question', 'the question itself must never be dropped')
  assert.equal(kept.at(-1).content, 'latest question', 'the newest turn is kept')
  assert.ok(kept.length < wire.length, 'older history is actually trimmed')
  assert.ok(kept.length >= 3)
})

test('trimMessages leaves a short history untouched', () => {
  const wire = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }]
  assert.deepEqual(trimMessages(wire), wire)
})

test('sanitizeWireMessages re-labels an orphan tool result', () => {
  const warnings = []
  const out = sanitizeWireMessages([
    { role: 'user', content: 'go' },
    { role: 'tool', tool_call_id: 'call_ghost', content: 'orphan' },
  ], (line) => warnings.push(line))
  assert.equal(out[1].role, 'user')
  assert.match(out[1].content, /orphan/, 'the information survives')
  assert.match(warnings[0], /orphan tool result/)
})

test('sanitizeWireMessages leaves a healthy tool history exactly as it is', () => {
  const healthy = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' },
  ]
  const warnings = []
  assert.deepEqual(sanitizeWireMessages(healthy, (l) => warnings.push(l)), healthy)
  assert.deepEqual(warnings, [])
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
  assert.equal(new AvailabilityTracker(file).isServable('exo-free'), false)
  ledger.clear('exo-free')
  assert.equal(ledger.isServable('exo-free'), true)
  assert.deepEqual(new AvailabilityTracker(file).snapshot(), {})
  unlinkSync(file)
})

// ---- finding the local OpenCode client ----

test('resolveCommand falls back to the npm prefix when PATH lacks opencode', () => {
  const saved = process.env.PATH
  process.env.PATH = join(tmpdir(), 'no-such-dir-for-this-test')
  try {
    const found = resolveCommand()
    if (process.platform !== 'win32') {
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
  const bridge = new OpenCodeBridge({ command: process.execPath })
  assert.equal(bridge.command, process.execPath)
  assert.equal(bridge.commandOverride, process.execPath)
})

test('without an explicit command, resolution waits until startup', () => {
  const bridge = new OpenCodeBridge({})
  assert.equal(bridge.command, null)
})

test('a failed boot is not retried on every request', async () => {
  const bridge = new OpenCodeBridge({ command: process.execPath, port: 59999, bootTimeoutMs: 1200, log: () => {} })
  const first = await bridge.ensure().then(() => null, (e) => e)
  assert.ok(first, '第一次必须失败')
  assert.equal(first.code, 'BRIDGE_UNAVAILABLE')
  const t0 = Date.now()
  const second = await bridge.ensure().then(() => null, (e) => e)
  assert.equal(second, first, '冷却期内必须复用同一个错误对象')
  assert.ok(Date.now() - t0 < 1000, `不应再等一次启动超时（实际 ${Date.now() - t0}ms）`)
})
