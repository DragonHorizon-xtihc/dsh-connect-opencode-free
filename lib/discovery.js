// dsh-connect-opencode-free · catalog discovery (Host only).
//
// Two sources, merged, because neither is sufficient alone:
//
//   • https://opencode.ai/zen/v1/models — which model ids Zen serves *right
//     now*. Free models come and go, so a list written down at build time is
//     wrong within days. Zen's own endpoint is the only thing that knows.
//   • https://models.dev/api.json — the *opencode* provider block, which says
//     which of those cost nothing and how large each one is (context window,
//     output cap, reasoning/tool support, deprecation).
//
// The catalog is the models.dev free set, with Zen's list deciding which
// entries are actually being served. A free model Zen has dropped is reported
// as unavailable rather than silently deleted, so an operator can see that it
// used to be there — and a brand-new Zen-only free model still shows up before
// models.dev has indexed it.

import { BRIDGE_MARKER, BRIDGE_PORT_SPAN, DEFAULT_BRIDGE_PORT, clampInt } from './core.js'

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
export const CATALOG_URL = 'https://models.dev/api.json'
export const PROVIDER_KEY = 'opencode'

// The bridge constants live in core.js because the browser half reads the marker
// and the default port too, and only core.js is inlined into lib/client.cjs.
export { BRIDGE_MARKER, BRIDGE_PORT_SPAN, DEFAULT_BRIDGE_PORT }

/**
 * Fetch and decode one JSON document.
 * @param url - absolute http(s) URL.
 * @param timeoutMs - abort budget for the whole request.
 * @returns the decoded body.
 * @throws Error naming the failure, so the caller can log it verbatim.
 */
export async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(clampInt(timeoutMs, 1000, 120000, 15000)),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return await response.json()
}

/**
 * The model ids Zen currently serves.
 * @param baseURL - the Zen root, e.g. `https://opencode.ai/zen/v1`.
 * @param timeoutMs - abort budget.
 * @returns a Set of ids.
 */
export async function fetchZenModelIds(baseURL, timeoutMs) {
  const payload = await fetchJson(`${String(baseURL).replace(/\/+$/, '')}/models`, timeoutMs)
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return new Set(rows.map((row) => row?.id).filter((id) => typeof id === 'string' && id !== ''))
}

function isFree(entry) {
  const cost = entry?.cost
  if (cost === undefined || cost === null) return false
  return Number(cost.input ?? 1) === 0 && Number(cost.output ?? 1) === 0
}

function limitNumber(limit, key, fallback) {
  const value = Number(limit?.[key])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Merge the two sources into the catalog the picker and the provider entry read.
 *
 * A model qualifies when models.dev prices it at zero. Zen's list only decides
 * availability, never membership — that keeps a model discoverable the moment
 * it is free even if models.dev lags, and keeps a retired model visible until
 * the operator or the deprecation filter removes it.
 * @param modelsDev - the decoded `api.json` document.
 * @param zenIds - ids Zen currently serves, or undefined when Zen is unreachable.
 * @param options - `defaultContextWindow` for entries the catalog does not size;
 * `assumeAvailable` treats every entry as live when Zen could not be read, which
 * is what keeps one unreachable endpoint from emptying the picker.
 * @returns canonical model records, free-and-live first, then by id.
 */
export function mergeCatalog(modelsDev, zenIds, options = {}) {
  const fallbackContext = clampInt(options.defaultContextWindow, 1_000, 10_000_000, 200_000)
  const zenKnown = zenIds !== undefined && zenIds !== null
  const served = zenIds instanceof Set ? zenIds : new Set(zenIds ?? [])
  const assumeAvailable = options.assumeAvailable === true || !zenKnown
  const isServed = (id) => assumeAvailable || served.has(id)
  const block = modelsDev?.[PROVIDER_KEY]
  const table = block && typeof block === 'object' ? block.models : undefined
  const records = new Map()

  if (table && typeof table === 'object') {
    for (const entry of Object.values(table)) {
      if (!entry || typeof entry !== 'object' || !isFree(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      if (id === '') continue
      const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : id
      records.set(id, {
        id,
        name,
        description: typeof entry.description === 'string' ? entry.description.slice(0, 400) : '',
        contextWindow: limitNumber(entry.limit, 'context', fallbackContext),
        maxTokens: limitNumber(entry.limit, 'output', fallbackContext),
        reasoning: entry.reasoning === true,
        toolCall: entry.tool_call !== false,
        attachment: entry.attachment === true,
        deprecated: entry.status === 'deprecated',
        available: isServed(id),
        source: 'catalog',
      })
    }
  }

  // A model Zen serves as free but models.dev has not priced yet. Taking it on
  // the id alone is the point: waiting for the catalog to catch up would hide
  // a model the operator can use today.
  for (const id of served) {
    if (records.has(id) || !id.endsWith('-free')) continue
    records.set(id, {
      id,
      name: id,
      description: 'OpenCode Zen 免费档（models.dev 尚未收录）',
      contextWindow: fallbackContext,
      maxTokens: fallbackContext,
      reasoning: true,
      toolCall: true,
      attachment: false,
      deprecated: false,
      available: true,
      source: 'zen',
    })
  }

  return [...records.values()].sort((a, b) => {
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1
    return a.id.localeCompare(b.id)
  })
}

/**
 * The subset the adapter serves: free, not withdrawn, and still on Zen.
 * @param catalog - records from {@link mergeCatalog}.
 * @param options - `includeDeprecated` keeps the retired entries Zen still
 * serves, so an operator who wants them can have them. This is the only place
 * the Host applies that switch; the settings page applies its own copy through
 * {@link describeCatalog}.
 */
export function serveableModels(catalog, options = {}) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter((entry) => entry && entry.available !== false)
    .filter((entry) => options.includeDeprecated === true || entry.deprecated !== true)
}
