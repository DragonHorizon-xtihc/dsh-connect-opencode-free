// Render smoke test for the settings page.
//
// A blank settings page is the single most expensive failure this plugin can
// have: nothing in the logs points at it, the Host is healthy, and the operator
// just sees an empty box. The usual cause is a render-time throw — a `const`
// used before its declaration, a missing translation key, an undefined helper —
// and none of those are visible to `node --check`.
//
// This loads the built bundle the way the client module loader does, then calls
// the registered component with stub services and walks the element tree. Every
// translation key the page asks for is checked against the locale table, and a
// missing one is reported rather than rendered as the raw key.
//
// Run: node scripts/smoke-page.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Keys the page is allowed to ask for; sourced from the built bundle's tables. */
const bundle = readFileSync(join(PACKAGE_ROOT, 'lib/client.cjs'), 'utf8')

/**
 * Every key the page's locale tables define.
 *
 * Extracted from the built bundle rather than re-declared, so a key that exists
 * in the source but was dropped by the build — or added in the page but never
 * translated — is caught here instead of surfacing as raw text in the UI.
 * @returns a Set of key names.
 */
function localeKeys() {
  const keys = new Set()
  const table = /const (?:zh|en) = \{([\s\S]*?)\n    \}/g
  for (const [, body] of bundle.matchAll(table)) {
    for (const [, key] of body.matchAll(/^\s{6}(\w+):/gm)) keys.add(key)
  }
  return keys
}
const KNOWN_KEYS = localeKeys()
if (KNOWN_KEYS.size < 40) throw new Error(`only ${KNOWN_KEYS.size} locale keys found; the extraction is wrong`)

let loaded = null
const slotRegistrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(entry) { loaded = entry },
  },
}

// The bundle resolves `react` through its own require, so the stub has to be
// installed as a module the factory can reach. Wrapping the file in a CJS
// module with a custom require is the least invasive way to do that.
const factoryModule = { exports: {} }
const moduleRequire = (name) => {
  if (name !== 'react') throw new Error(`unexpected require: ${name}`)
  return reactStub
}

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(init) {
    const value = typeof init === 'function' ? init() : init
    return [value, () => {}]
  },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useEffect() {},
}

new Function('require', 'module', 'window', bundle)(moduleRequire, factoryModule, globalThis.window)
if (loaded === null) throw new Error('the bundle did not register itself with the module loader')
// The loader receives `{ id, factory }`; the plugin entry is what the factory
// exports, so the factory has to run before anything can be driven.
const plugin = loaded.factory(moduleRequire, factoryModule)
if (typeof plugin?.apply !== 'function') throw new Error('the bundle exports no apply()')

// ---- drive the registered entry ----
const missingKeys = []
const seenKeys = new Set()
const t = (key, params) => {
  seenKeys.add(String(key))
  if (!KNOWN_KEYS.has(String(key))) missingKeys.push(String(key))
  return params === undefined ? String(key) : `${String(key)}(${JSON.stringify(params)})`
}

const ENTRY_NS = 'dsh-connect-opencode-free'

/** The snapshot one render reads. Mutated between renders to cover both states. */
const configValue = {
  enabled: true,
  bridgePort: 18766,
  apiKeys: [],
  quotaPolicy: 'publicOnly',
  disabledModels: [],
  manualModels: [],
}
const scope = {
  subscribe() { return () => {} },
  getSnapshot() {
    return { status: 'ready', value: configValue, writable: true, revision: 1 }
  },
  // `set()` is what the key rows call; a no-op keeps the render side-effect free
  // while still exercising the call path.
  form() { return { set: async () => true } },
}

/**
 * The `configForms` service the Host serves.
 *
 * `describe()` is what `bindEntryForm` follows, so it has to answer with a view
 * listing this plugin's namespace before `get()` is ever called — otherwise the
 * page binds to nothing and renders an empty shell that passes every assertion.
 */
const forms = {
  describe() {
    return {
      getSnapshot: () => ({ view: { namespaces: [{ ns: ENTRY_NS }, { ns: 'llm-pi-ai' }] } }),
      subscribe() { return () => {} },
    }
  },
  get(ns) {
    if (ns !== ENTRY_NS) throw new Error(`bound to the wrong namespace: ${ns}`)
    return scope
  },
}

const effects = []
const localeService = {
  // `register()` records the namespace's tables; `bind()` builds the translator
  // the page calls with. Both are property reads on the context (`ctx.locale`),
  // not `ctx.get('locale')` — returning a bare object from `get()` is what made
  // the first run of this script fail with "Cannot read properties of undefined
  // (reading 'bind')".
  register() {},
  bind: () => t,
}
const slotsService = {
  // `inject(name, factory)` mounts the section; `register(entry, component)`
  // is what the factory calls to hand over both the section metadata and the
  // component that renders it. Both are property reads on the context.
  inject(name, factory) { return factory() },
  register(entry, component) {
    slotRegistrations.push({ ...entry, component })
    return () => {}
  },
}
const ctx = {
  get(name) {
    if (name === 'configForms') return forms
    return undefined
  },
  locale: localeService,
  slots: slotsService,
  // Effects run and are disposed here, mirroring what cordis does on scope exit —
  // `scope.dispose()` is on the path the page registers, so it gets exercised.
  effect(fn) {
    const dispose = fn()
    effects.push(dispose)
    return () => { if (typeof dispose === 'function') dispose() }
  },
  on() {},
}

const entry = plugin
if (typeof entry.apply !== 'function') throw new Error('the registered entry has no apply()')
entry.apply(ctx, {})

// The page registers itself into a slot; recover the component from the stub.
if (slotRegistrations.length === 0) throw new Error('the page never registered into the slot')
const registration = slotRegistrations[slotRegistrations.length - 1]
const injected = registration.inject()
if (typeof injected.scope !== 'object' || typeof injected.t !== 'function') {
  throw new Error('the slot registration did not inject a bound form and translator')
}
const component = registration.component
if (typeof component !== 'function') throw new Error('the slot registration carries no component')

/**
 * Render the page against one config value and count what came out.
 *
 * The walk is depth-first over the element tree the component returns; a
 * render-time throw propagates out of here rather than being swallowed, which is
 * the whole point — that throw is what a blank settings page looks like from the
 * inside.
 * @param label - what state is being rendered, for the failure message.
 * @param overrides - config fields to change for this render.
 * @returns the number of elements rendered.
 */
function renderOnce(label, overrides = {}) {
  Object.assign(configValue, overrides)
  const tree = component({ t: injected.t, scope: injected.scope, forms: injected.forms })
  let nodes = 0
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    nodes += 1
    const children = node.children ?? []
    children.forEach(walk)
  }
  walk(tree)
  return nodes
}

// Every branch the page can take has to render at least once: the key rows are
// the newest surface and the one that went blank, so they are rendered empty,
// filled, and under both key-gated policies. A TDZ or a missing key only shows
// up on the branch that reads it.
const renders = [
  ['no keys, public only', { apiKeys: [], quotaPolicy: 'publicOnly' }],
  ['one key typed', { apiKeys: ['sk-or-test'], quotaPolicy: 'publicOnly' }],
  ['key with a blank row', { apiKeys: ['sk-or-test', '', '  '], quotaPolicy: 'preferPublic' }],
  ['prefer key', { apiKeys: ['sk-or-a', 'sk-or-b'], quotaPolicy: 'preferKey' }],
  ['manual model present', { manualModels: [{ id: 'x-model', name: 'X', contextWindow: 200000 }], disabledModels: ['y-model'] }],
  ['deprecated switch on', { includeDeprecated: true, apiKeys: ['sk-or-test'] }],
]

let totalNodes = 0
for (const [label, overrides] of renders) {
  try {
    const nodes = renderOnce(label, overrides)
    totalNodes += nodes
  } catch (error) {
    console.error(`RENDER FAILED [${label}]:`, error && error.stack ? error.stack : error)
    process.exit(1)
  }
}

// The scope exit path: every effect the page registered is disposed here, which
// is where `scope.dispose()` runs.
for (const dispose of effects) { if (typeof dispose === 'function') dispose() }

console.log(`rendered OK: ${renders.length} states, ${totalNodes} elements, ${seenKeys.size} translation keys requested`)
if (missingKeys.length > 0) {
  console.error(`MISSING TRANSLATION KEYS (${missingKeys.length}):`)
  for (const key of [...new Set(missingKeys)]) console.error(`  ${key}`)
  process.exit(1)
}
console.log('all requested keys exist in the locale tables')
