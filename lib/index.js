// dsh-connect-opencode-free · Host half (Node side).
//
// The plugin registers one免 key `opencode-free` route and keeps its model set
// in step with two upstream sources (see ./discovery.js). Three things live
// here that the browser cannot do for itself:
//
//   • discovery — Zen's model endpoint sends no CORS header, so only the Host
//     can read it. The page reaches the result through a loopback bridge.
//   • the cache — a restart or a momentary outage must not empty the picker.
//   • quota accounting — Zen's 429 says nothing about when it reopens.
//
// Every configuration field is volatile, so a change made on the settings page
// lands here through `loader/volatile-update` without a restart.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  LOG_PREFIX,
  PROVIDER,
  QUOTA_POLICY,
  buildModelSet,
  CONFIG_DEFAULTS,
  clampInt,
  describeCatalog,
} from './core.js'
import { Config } from './config.js'
import {
  BRIDGE_MARKER,
  BRIDGE_PORT_SPAN,
  DEFAULT_BRIDGE_PORT,
  fetchJson,
  fetchZenModelIds,
  mergeCatalog,
  serveableModels,
} from './discovery.js'
import { QuotaTracker, credentialValue, resolveCredentialPool } from './quota.js'
import { AvailabilityTracker } from './availability.js'
import { keyCheckStillValid, verifyKey } from './keycheck.js'
import { registerGateTools } from './gate-tools.js'
import { installOpenCodeFreeProvider } from './provider.js'

export { Config }
export const name = 'dsh-connect-opencode-free'

// IMPORTANT: DSH's loader attaches services named here onto ctx before calling
// apply(ctx). Without this, ctx.llm is undefined and the opencode-free adapter
// never registers (no models in the picker). Same mechanism as dsh-opencode-zen.
export const inject = ['llm']

function log(debug, ...args) {
  if (debug) console.log(LOG_PREFIX, ...args)
}
function warn(...args) {
  console.warn(LOG_PREFIX, ...args)
}


/**
 * Where this plugin's cache lives.
 *
 * The bundle patch resolves `cacheDir` with the Host's own `dshHomePath`, which
 * is the only answer that survives a profile linking the bundle into a source
 * checkout — Node resolves such a link to its real path, so counting parents
 * from the install path lands outside the Harness home entirely. `DSH_HOME` is
 * the fallback for a composition that did not inject the expression.
 * @param cfg - the plugin's resolved Config.
 * @param fileName - cache file name inside that directory.
 */
function cacheFileFor(cfg, fileName) {
  // `cacheDir` is deliberately not volatile, so it arrives as a plain value
  // rather than a Volatile reference.
  const injected = String(cfg.cacheDir ?? '').trim()
  if (injected !== '') return join(injected, fileName)
  const home = String(process.env.DSH_HOME ?? '').trim()
  if (home !== '') return join(home, 'cache', fileName)
  return join(homedir(), '.dsh', 'cache', fileName)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8')
  } catch { /* a cache that cannot be written must never fail a request */ }
}

export function apply(ctx, config) {
  const cfg = config
  const debug = () => cfg.debug.get() === true

  const cachePath = () => {
    const configured = String(cfg.cachePath.get() ?? '').trim()
    return configured !== '' ? configured : cacheFileFor(cfg, 'opencode-zen-catalog.json')
  }
  const quota = new QuotaTracker(cacheFileFor(cfg, 'opencode-zen-quota.json'))
  const availability = new AvailabilityTracker(cacheFileFor(cfg, 'opencode-zen-availability.json'))

  /** The last catalog that actually resolved, from memory or the on-disk cache. */
  let catalog = readJson(cachePath())?.catalog ?? []
  let lastSyncAt = 0
  let syncError = ''

  let providerHandle = null
  let control = { enabled: () => true }
  let pollTimer = null
  let disposed = false
  let inFlight = null
  let bridgeServer = null
  let bridgePort = 0

  const applyEnabled = () => {
    const enabled = cfg.enabled.get() !== false
    control.enabled = () => enabled
    if (providerHandle && typeof providerHandle.replace === 'function') {
      try {
        // Pausing must remove the route and emit llm/adapters-updated, or the
        // picker keeps showing a cached list. replace([]) keeps the
        // registration and only withdraws the routes.
        providerHandle.replace(enabled ? [PROVIDER] : [])
      } catch (error) {
        warn('route sync failed:', error && error.message)
      }
    }
    return enabled
  }

  /** The retirement filter, read live: the page's switch is volatile. */
  const deprecationFilter = () => ({ includeDeprecated: cfg.includeDeprecated.get() === true })

  const credentialLookup = (name) => credentialValue(
    name,
    typeof ctx.get === 'function' ? ctx.get('credentials') : undefined,
  )

  /**
   * Whether a configured credential resolves right now.
   *
   * The settings page's badge reads it through the bridge, and a key that lives
   * only in the credential store would read as anonymous to an environment-only
   * answer — so it is refreshed through the same lookup the requests use.
   */
  // How many keys are configured — not whether one is in use. Which lane a
  // request spends is a separate decision (`quotaPolicy`), so "has a key" and
  // "is paying for this request" are different facts and the page shows them
  // separately.
  let keyCount = 0
  let keyPool = []
  const refreshKeyed = async () => {
    try {
      const pool = await resolveCredentialPool(cfg.apiKeyEnv.get(), credentialLookup)
      keyPool = pool
      keyCount = pool.length
      // A verdict about a key that is no longer configured is a verdict about
      // nothing; drop it so the gate closes the moment the key changes.
      if (!keyCheckStillValid(keyCheck, pool[0]?.key)) keyCheck = undefined
    } catch {
      /* the badge keeps its previous answer instead of failing a bridge read */
    }
  }

  // ---- key verification ----
  // Two of the three quota policies spend the operator's own quota, and they
  // are only offered once a key has been accepted upstream. The answer is
  // persisted with a fingerprint of the key it describes, never the key itself.
  const keyCheckPath = () => cacheFileFor(cfg, 'opencode-zen-keycheck.json')
  let keyCheck = readJson(keyCheckPath())
  const keyVerified = () => keyCheckStillValid(keyCheck, keyPool[0]?.key)

  const runKeyCheck = async () => {
    if (keyPool.length === 0) {
      keyCheck = { ok: false, status: 0, reason: '没有配置 Key，无法校验', finger: '', checkedAt: Date.now() }
      return keyCheck
    }
    const probeModel = liveModels()[0]?.id ?? servedModels()[0]?.id
    const result = await verifyKey({
      baseURL: cfg.zenBaseURL.get(),
      key: keyPool[0].key,
      model: probeModel,
      timeoutMs: clampInt(cfg.catalogTimeoutMs.get(), 1000, 120_000, 20_000),
    })
    keyCheck = { ...result, checkedAt: Date.now(), source: keyPool[0].name }
    writeJson(keyCheckPath(), keyCheck)
    log(debug(), `key check for ${keyPool[0].name}: ${result.ok ? 'accepted' : 'rejected'} — ${result.reason}`)
    return keyCheck
  }

  const servedModels = () => serveableModels(catalog, deprecationFilter())

  /**
   * Catalog models minus the ones already proven dead upstream.
   *
   * Both catalog sources keep listing models that cannot serve, and picking one
   * just produces a 400 the user cannot act on. The ledger is read live so a
   * model retired one request ago leaves the picker on the next publish.
   */
  const liveModels = () => servedModels().filter((m) => availability.isServable(m.id))

  /** Fold the catalog plus the operator's choices into the adapter. */
  const publishModels = () => {
    const set = buildModelSet(liveModels(), cfg.manualModels.get(), cfg.disabledModels.get(), {
      defaultContextWindow: cfg.defaultContextWindow.get(),
      defaultMaxTokens: CONFIG_DEFAULTS.defaultMaxTokens,
    })
    providerHandle?.adapter?.setModels(set)
    const retired = Object.keys(availability.snapshot())
    log(debug(), `model set: ${set.length} active (${set.map((m) => m.id).join(', ') || 'none'})`)
    if (retired.length > 0) {
      log(debug(), `retired upstream: ${retired.join(', ')}`)
    }
    return set
  }

  /**
   * Read both sources and adopt the result.
   *
   * A partial answer is kept rather than discarded: if only models.dev
   * answered, the previous Zen availability is retained, because a stale
   * "available" flag is far less harmful than dropping every model.
   */
  const sync = async () => {
    const timeoutMs = clampInt(cfg.catalogTimeoutMs.get(), 1000, 120_000, 20_000)
    let zenIds
    let zenError = ''
    try {
      zenIds = await fetchZenModelIds(cfg.zenBaseURL.get(), timeoutMs)
    } catch (error) {
      zenError = error && error.message ? error.message : String(error)
    }
    let modelsDev
    let catalogError = ''
    try {
      modelsDev = await fetchJson(cfg.catalogURL.get(), timeoutMs)
    } catch (error) {
      catalogError = error && error.message ? error.message : String(error)
    }

    if (zenError !== '' && catalogError !== '') {
      syncError = `Zen: ${zenError} · 目录: ${catalogError}`
      warn('catalog sync failed, keeping the last known catalog:', syncError)
      return
    }

    if (zenIds === undefined) {
      // Only the catalog answered. Carry the previous availability forward, and
      // on a cold start — where there is no previous answer to carry — assume
      // the free models are live rather than serving an empty picker because
      // one endpoint was briefly unreachable. The reason is surfaced to the
      // settings page so the assumption is never silent.
      const previous = new Set(catalog.filter((m) => m.available !== false).map((m) => m.id))
      const coldStart = previous.size === 0
      const merged = mergeCatalog(modelsDev, previous, {
        defaultContextWindow: cfg.defaultContextWindow.get(),
        assumeAvailable: coldStart,
      })
      adopt(merged, `Zen 不可达（${zenError}），可用性按${coldStart ? '免费目录推定' : '上次结果沿用'}`)
      return
    }
    if (modelsDev === undefined) {
      warn(`catalog unavailable (${catalogError}); keeping the last known catalog`)
      syncError = `目录: ${catalogError}`
      return
    }
    adopt(
      mergeCatalog(modelsDev, zenIds, { defaultContextWindow: cfg.defaultContextWindow.get() }),
      '',
    )
  }

  const adopt = (next, note) => {
    const before = catalog.length
    catalog = next
    lastSyncAt = Date.now()
    syncError = note
    writeJson(cachePath(), { savedAt: lastSyncAt, catalog })
    const live = serveableModels(catalog, deprecationFilter())
    log(debug(), `catalog: ${catalog.length} entries, ${live.length} serving (was ${before})${note === '' ? '' : ` · ${note}`}`)
  }

  /** Re-read both sources, then publish. Concurrent callers share one request. */
  const refresh = async () => {
    if (disposed) return
    if (inFlight !== null) return await inFlight
    inFlight = (async () => {
      await sync()
      publishModels()
      applyEnabled()
      log(debug(), `quota: ${JSON.stringify(quota.snapshot(Date.now()))}`)
    })().finally(() => { inFlight = null })
    return await inFlight
  }

  try {
    providerHandle = installOpenCodeFreeProvider(ctx, (msg) => console.log(LOG_PREFIX, msg), control, {
      quota,
      availability,
      credentials: () => resolveCredentialPool(cfg.apiKeyEnv.get(), credentialLookup),
      // Read live, and filtered: a policy that spends a key is honoured only
      // while that key is known to work. The page cannot be trusted to have
      // gated it, because it may be showing a stale verdict.
      quotaPolicy: () => cfg.quotaPolicy.get(),
      keyVerified,
      maxAttempts: () => clampInt(cfg.maxRequestAttempts.get(), 1, 6, 3),
      backoffMs: () => clampInt(cfg.retryBackoffMs.get(), 100, 30_000, 800),
      zenBaseURL: () => cfg.zenBaseURL.get(),
    })
  } catch (error) {
    warn('provider registration failed:', error && error.message)
  }

  // ---- real bash/read for the gateway gate ----
  // Zen only accepts a body advertising `bash` and `read`. Making them real is
  // what stops the model from reaching for tools that cannot answer, so it is
  // attempted before anything serves a request. It is best-effort: every failure
  // mode leaves the previous placeholder behaviour in place.
  // `register` hands back a disposer, so this tracks it instead of a flag and
  // the operator's switch takes effect without a restart.
  let gateDispose = null
  const syncGateTools = async () => {
    const wanted = cfg.realGateTools.get() !== false
    if (wanted && gateDispose === null) {
      try {
        const result = await registerGateTools(ctx, (line) => warn(line))
        if (result?.registered) {
          gateDispose = result.dispose
          log(debug(), 'gate tools registered: bash and read are real tools')
        }
      } catch (error) {
        warn('gate tool registration failed:', error && error.message)
      }
      return
    }
    if (!wanted && gateDispose !== null) {
      try { gateDispose() } catch { /* withdrawal must not break the toggle */ }
      gateDispose = null
      log(debug(), 'gate tools withdrawn: bash and read are placeholders again')
    }
  }
  void syncGateTools()

  // ---- localhost catalog bridge ----
  // Zen's model endpoint answers without `Access-Control-Allow-Origin`, so the
  // page cannot fetch it. The Host already fetched it, so it serves the result
  // over loopback. The port is configurable and walks forward when busy, and
  // every response carries a marker so the page never mistakes another local
  // service for this one.
  const startBridge = () => {
    const first = clampInt(cfg.bridgePort.get(), 1024, 65_535, DEFAULT_BRIDGE_PORT)
    const server = createServer((req, res) => {
      const origin = req.headers.origin
      res.setHeader('Access-Control-Allow-Origin', typeof origin === 'string' ? origin : '*')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      // Cross-origin script may only read the safelisted response headers, so
      // the marker has to be exposed explicitly or the page can never confirm
      // it is talking to this bridge rather than to whatever else is listening.
      res.setHeader('Access-Control-Expose-Headers', BRIDGE_MARKER)
      res.setHeader(BRIDGE_MARKER, '1')
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${bridgePort || first}`)
      // Proving a key works costs one upstream request, so the page asks for it
      // explicitly and may force a re-check; a cached verdict is otherwise
      // reused for as long as it describes the key currently configured.
      if (url.pathname === '/verify-key') {
        const force = url.searchParams.get('force') === '1'
        Promise.resolve(force || !keyVerified() ? runKeyCheck() : keyCheck)
          .then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ...result, checkedAt: result?.checkedAt ?? 0 }))
          })
          .catch((error) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, status: 0, reason: error?.message ?? String(error), finger: '' }))
          })
        return
      }
      if (url.pathname !== '/catalog') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      const models = buildModelSet(
        serveableModels(catalog, deprecationFilter()),
        cfg.manualModels.get(),
        cfg.disabledModels.get(),
        { defaultContextWindow: cfg.defaultContextWindow.get() },
      )
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        catalog: describeCatalog(catalog, cfg.manualModels.get(), cfg.disabledModels.get(), deprecationFilter()),
        active: models.length,
        syncedAt: lastSyncAt,
        error: syncError,
        quota: quota.snapshot(Date.now()),
        // No key configured, so the free lane is all there is. Kept separate
        // from `keyCount` because a configured key is a fallback, not a
        // statement about which lane is currently paying.
        anonymous: keyCount === 0,
        keyCount,
        // Whether the key-gated policies are unlocked. Sent separately from
        // `keyCount` because the page disables two of the three rules until
        // this is true — a key that exists is not a key that works.
        keyVerified: keyVerified(),
        keyCheck: keyCheck === undefined ? null : {
          ok: keyCheck.ok === true,
          status: keyCheck.status ?? 0,
          reason: typeof keyCheck.reason === 'string' ? keyCheck.reason : '',
          source: typeof keyCheck.source === 'string' ? keyCheck.source : '',
          checkedAt: Number(keyCheck.checkedAt ?? 0),
        },
        retired: availability.snapshot(),
      }))
    })
    let attempt = 0
    const listen = () => {
      const port = first + attempt
      attempt += 1
      server.once('error', (error) => {
        if (attempt < BRIDGE_PORT_SPAN) { listen(); return }
        warn(`catalog bridge unavailable on ports ${first}-${first + BRIDGE_PORT_SPAN - 1}: ${error && error.message}`)
      })
      server.listen(port, '127.0.0.1', () => {
        bridgePort = port
        log(debug(), `catalog bridge on http://127.0.0.1:${port}/catalog`)
      })
    }
    listen()
    bridgeServer = server
  }
  startBridge()

  // Settings are volatile: enabling, adding a model, or un-disabling one all
  // land here, so none of them needs a reload. A new `syncToken` is the page
  // asking for a fresh read of both upstream sources.
  let lastSyncToken = cfg.syncToken.get()
  ctx.on('loader/volatile-update', () => {
    publishModels()
    applyEnabled()
    refreshKeyed()
    void syncGateTools()
    reschedule()
    const token = cfg.syncToken.get()
    if (token !== lastSyncToken) {
      lastSyncToken = token
      void refresh()
    }
  })

  /** Keep the poll aligned with the configured cadence and the autoSync switch. */
  const reschedule = () => {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (disposed || cfg.autoSync.get() === false) return
    pollTimer = setInterval(() => { void refresh() }, clampInt(cfg.pollIntervalMs.get(), 60_000, 86_400_000, 3_600_000))
  }

  publishModels()
  applyEnabled()
  void refresh()
  reschedule()
  // A key-gated policy is a promise the Host has to keep: either the key checks
  // out, or the policy is quietly `publicOnly` — and the operator is told which
  // happened instead of wondering why their key is never used.
  void (async () => {
    await refreshKeyed()
    const wanted = cfg.quotaPolicy.get()
    if (wanted === QUOTA_POLICY.PUBLIC_ONLY) return
    if (!keyVerified()) await runKeyCheck()
    if (!keyVerified()) {
      warn(`使用规则 ${wanted} 需要 Key 先通过校验（${keyCheck?.reason ?? '未校验'}）；在通过之前按 publicOnly 处理，不会动用私有额度`)
    }
  })()
  console.log(LOG_PREFIX, `host ready (zen=${cfg.zenBaseURL.get()}, cached catalog: ${catalog.length})`)

  ctx.effect(() => () => {
    disposed = true
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (typeof providerHandle === 'function') {
      try {
        providerHandle()
      } catch { /* cleanup must never throw across unload */ }
      providerHandle = null
    }
    if (bridgeServer !== null) {
      try { bridgeServer.close() } catch { /* ignore */ }
      bridgeServer = null
    }
  })
}
