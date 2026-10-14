// dsh-connect-opencode-free · pure core helpers (host + browser share).
//
// Side-effect free and import-free so `scripts/build.mjs` can inline this file
// into the browser bundle and a unit test can require it directly under
// node:test. Keep it free of browser globals and of the schemastery dependency:
// the runtime schema lives in ./config.js, which only the Host loads.

export const LOG_PREFIX = '[opencode-free]'
/** Profile entry id this bundle inserts; also the settings namespace its page reads. */
export const ENTRY_ID = 'dsh-connect-opencode-free'
/** The `llm-pi-ai` namespace the one-click provider write targets. */
export const PROVIDERS_NS = 'llm-pi-ai'
/** Route this plugin registers on the `llm` service. */
export const PROVIDER = 'opencode-free'
/** Route id the one-click write creates inside `llm-pi-ai.providers`. */
export const ZEN_ROUTE_ID = 'opencode-zen'

// ---- localhost catalog bridge (shared: the Host serves it, the page reads it) ----
// Zen's model endpoint answers without `Access-Control-Allow-Origin`, so the
// browser cannot read the catalog itself and the Host hands it over on loopback.
export const BRIDGE_MARKER = 'x-dsh-opencode-free'
export const DEFAULT_BRIDGE_PORT = 18766
/** How many consecutive ports the bridge walks forward before giving up. */
export const BRIDGE_PORT_SPAN = 10

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

export const CONFIG_DEFAULTS = Object.freeze({
  defaultContextWindow: 200000,
  defaultMaxTokens: 32000,
})

/**
 * Which quota a request may spend, in the operator's words.
 *
 * Three policies, not a boolean, because "I have a key" and "use my key" are
 * different decisions — and the default has to be the one that keeps this
 * plugin free. `publicOnly` is it: a key lying around in the environment must
 * never quietly become the thing every call is billed to.
 *
 * The other two are gated on a key that has actually been accepted by Zen, so
 * a mistyped credential cannot silently switch the plugin onto a lane that
 * then fails for every request.
 */
export const QUOTA_POLICY = Object.freeze({
  /** Never spend a key. A configured one stays unused. */
  PUBLIC_ONLY: 'publicOnly',
  /** Try the free lane first; fall back to a key only when it refuses. */
  PREFER_PUBLIC: 'preferPublic',
  /** Spend the key first; fall back to the free lane when the key cannot serve. */
  PREFER_KEY: 'preferKey',
})

/** Every policy, in the order the settings page offers them. */
export const QUOTA_POLICIES = Object.freeze([
  QUOTA_POLICY.PUBLIC_ONLY,
  QUOTA_POLICY.PREFER_PUBLIC,
  QUOTA_POLICY.PREFER_KEY,
])

/** Policies that only make sense once a key has been accepted upstream. */
export const KEY_GATED_POLICIES = Object.freeze([
  QUOTA_POLICY.PREFER_PUBLIC,
  QUOTA_POLICY.PREFER_KEY,
])

/**
 * The policy to apply, given what is configured and what is proven.
 *
 * Enforced on the Host rather than trusted from the page: a settings UI can be
 * out of date, and a policy that spends a key is only valid while that key is
 * known to work.
 * @param configured - the value from Config.
 * @param keyVerified - whether a configured key was accepted upstream.
 * @returns one of {@link QUOTA_POLICY}, never an ungated one without a key.
 */
export function effectiveQuotaPolicy(configured, keyVerified) {
  const value = String(configured ?? '')
  if (value === QUOTA_POLICY.PREFER_PUBLIC || value === QUOTA_POLICY.PREFER_KEY) {
    return keyVerified === true ? value : QUOTA_POLICY.PUBLIC_ONLY
  }
  return QUOTA_POLICY.PUBLIC_ONLY
}

/** Coerce to an integer inside [min,max]; anything else falls back. */
export function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Only http(s) absolute URLs count as safe targets for links or fetches.
 *  Returns the canonical serialized URL — what we validate is exactly what
 *  the caller will use (the WHATWG parser strips smuggled control chars). */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 2048) return ''
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  return parsed.toString()
}

/** Stable, lowercase id fragment derived from a model title. */
export function slugify(title, maxLen = 40) {
  const base = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '')
  return base || 'model'
}

/**
 * The model set the adapter serves.
 *
 * Discovery (./discovery.js) decides which free models exist; the operator's
 * two lists are applied last, so turning a model off here survives the next
 * sync instead of being undone by it.
 * @param catalog - records from the discovery merge, or the settings page's
 * rows. Both spell the withdrawal the same way for the purpose of this
 * function: a Host record carries `available: false`, a page row carries
 * `unavailable: true` (see {@link describeCatalog}), and either one means the
 * model must not be served.
 *
 * Retirement is deliberately NOT decided here. The operator's `includeDeprecated`
 * choice has already been applied upstream — `serveableModels` for the Host,
 * {@link describeCatalog} for the page — so applying it again would undo a
 * switch that was set to on.
 * @param manual - the `manualModels` config array.
 * @param disabled - the `disabledModels` config array.
 * @param options - `defaultContextWindow` / `defaultMaxTokens` for manual rows.
 * @returns adapter model records, catalog first.
 */
export function buildModelSet(catalog, manual, disabled, options = {}) {
  const off = new Set((Array.isArray(disabled) ? disabled : []).filter((id) => typeof id === 'string'))
  const fallbackContext = clampInt(options.defaultContextWindow, 1_000, 10_000_000, 200_000)
  const fallbackMax = clampInt(options.defaultMaxTokens, 1_000, 10_000_000, 32_000)
  const seen = new Map()

  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
    if (off.has(entry.id) || seen.has(entry.id)) continue
    if (entry.available === false || entry.unavailable === true) continue
    const contextWindow = clampInt(entry.contextWindow, 1_000, 10_000_000, fallbackContext)
    seen.set(entry.id, {
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || 'OpenCode Zen 免费档',
      contextWindow,
      maxTokens: clampInt(entry.maxTokens, 1_000, 10_000_000, fallbackMax),
      reasoning: entry.reasoning === true,
      toolCall: entry.toolCall !== false,
    })
  }

  // Manual entries sit on top and are never filtered by upstream status: they
  // exist precisely for a model the catalog does not carry yet.
  for (const entry of Array.isArray(manual) ? manual : []) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id || off.has(id) || seen.has(id)) continue
    seen.set(id, {
      id,
      name: (typeof entry.name === 'string' && entry.name.trim()) || id,
      description: '手动添加的 OpenCode Zen 模型',
      contextWindow: clampInt(entry.contextWindow, 1_000, 10_000_000, fallbackContext),
      maxTokens: fallbackMax,
      reasoning: true,
      toolCall: true,
    })
  }

  return [...seen.values()]
}

/**
 * Build the one `llm-pi-ai` provider profile carrying every free model.
 *
 * A single route rather than one route per model: the picker then shows them as
 * one group, which is how both reference projects present them, and adding a
 * model later is an edit to one `models` list instead of a new route the
 * operator has to discover.
 *
 * OpenCode Zen free models are PUBLIC — the completion API answers with no
 * Authorization header — so the entry declares NO `apiKeyEnv`; naming one would
 * make pi-ai demand a credential it can never resolve.
 * @param models - model records from {@link buildModelSet}.
 * @param routeId - the provider key to write under.
 * @returns `{ pid, entry }` ready to write at `providers.<pid>`.
 */
export function buildProviderEntry(models, routeId = ZEN_ROUTE_ID) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && typeof m.id === 'string' && m.id !== '')
  return {
    pid: routeId,
    entry: {
      displayName: 'OpenCode Zen',
      api: 'openai-completions',
      baseURL: ZEN_BASE_URL,
      defaultContextWindow: clampInt(maxOf(list, 'contextWindow'), 1_000, 10_000_000, 200_000),
      defaultMaxTokens: clampInt(maxOf(list, 'maxTokens'), 1_000, 10_000_000, 32_000),
      models: list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: clampInt(m.contextWindow, 1_000, 10_000_000, 200_000),
        maxTokens: clampInt(m.maxTokens, 1_000, 10_000_000, 32_000),
      })),
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: list.some((m) => m.reasoning === true),
        maxTokensField: 'max_tokens',
      },
    },
  }
}

/** Largest value of one numeric field across the set, used for the route defaults. */
function maxOf(list, field) {
  return list.reduce((max, m) => Math.max(max, Number(m?.[field]) || 0), 0)
}

function yamlQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** YAML for the provider profile, shown when the Host refuses the browser's write. */
export function toYamlSnippet({ pid, entry }) {
  const lines = [
    'llm-pi-ai:',
    '  providers:',
    `    ${pid}:`,
    `      displayName: ${yamlQuote(entry.displayName)}`,
    `      api: ${entry.api}`,
    `      baseURL: ${yamlQuote(entry.baseURL)}`,
    '      models:',
  ]
  for (const m of entry.models) lines.push(`        - id: ${yamlQuote(m.id)}`)
  return lines.join('\n')
}

/**
 * Pick the namespace this plugin's settings page should read.
 *
 * The Host names a settings namespace after the Loader entry id, and that id is
 * chosen by the profile patch rather than by the plugin, so a deployment which
 * renamed the row still resolves. `/opencode/` catches those renames without
 * matching an unrelated plugin.
 * @param served - the `ns` values the describe mirror currently reports.
 * @returns the namespace to bind, or undefined when this plugin serves none.
 */
export function resolveEntryNamespace(served) {
  const list = Array.isArray(served) ? served.filter((ns) => typeof ns === 'string') : []
  return list.find((ns) => ns === ENTRY_ID) ?? list.find((ns) => /opencode-free|connect-opencode/.test(ns))
}

/** Thousands-separated token count, for the settings page. */
export function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

/**
 * The rows the settings page renders: every discovered model, each tagged with
 * why it is not being served when that is the case.
 *
 * The page deliberately shows unavailable entries rather than hiding them — an
 * operator needs to see that a model they used yesterday is gone from Zen, not
 * find it silently missing. A model models.dev has retired is the one exception:
 * it is left out until `includeDeprecated` is set, which is what the switch on
 * the page promises.
 * @param catalog - canonical records from the discovery merge.
 * @param manual - the `manualModels` config array.
 * @param disabled - the `disabledModels` config array.
 * @param options - `includeDeprecated` lists retired entries too. A retired
 * entry Zen still serves is then offered as servable; one Zen also dropped
 * stays marked unavailable, so listing it never makes it callable.
 */
export function describeCatalog(catalog, manual, disabled, options = {}) {
  const off = new Set((Array.isArray(disabled) ? disabled : []).filter((id) => typeof id === 'string'))
  const includeDeprecated = options.includeDeprecated === true
  const listed = []
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry.id !== 'string' || entry.id === '') continue
    if (entry.deprecated === true && !includeDeprecated) continue
    // Deprecation first: it is the upstream author's own statement about the
    // model, and more actionable than noting Zen happens not to serve it. A
    // free model missing from Zen for any other reason was withdrawn.
    const reason = entry.deprecated === true
      ? 'models.dev 标记为已弃用'
      : (entry.available === false ? 'Zen 已下架' : '')
    listed.push({
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || '',
      source: entry.source === 'zen' ? 'zen' : 'catalog',
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      reasoning: entry.reasoning === true,
      toolCall: entry.toolCall !== false,
      attachment: entry.attachment === true,
      disabled: off.has(entry.id),
      // Servability, not the badge: a retired model Zen still serves has to
      // stay checkable, or the switch could list it but never enable it.
      unavailable: entry.available === false,
      reason,
    })
  }
  for (const entry of Array.isArray(manual) ? manual : []) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    listed.push({
      id,
      name: (typeof entry.name === 'string' && entry.name.trim()) || id,
      description: '手动添加的 OpenCode Zen 模型',
      source: 'manual',
      contextWindow: entry.contextWindow,
      maxTokens: 0,
      reasoning: true,
      toolCall: true,
      attachment: false,
      disabled: off.has(id),
      unavailable: false,
      reason: '',
    })
  }
  return listed
}
