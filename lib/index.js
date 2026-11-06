// dsh-connect-opencode-free · Host half (Node side).
//
// The plugin registers one免 key `opencode-free` route and keeps its model set
// in step with two upstream sources (see ./discovery.js). Three things live
// here that the browser cannot do for itself:
//
//   • discovery — Zen's model endpoint sends no CORS header, so only the Host
//     can read it. The page reaches the result through a loopback bridge.
//   • the cache — a restart or a momentary outage must not empty the picker.
//   • quota accounting — the client's 429 says nothing about when it reopens.
//
// 对话请求本身不出这个进程：lib/provider.js 只把请求交给本机真实的
// `opencode serve` 进程代发（bridge-only）。
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
  buildModelSet,
  CONFIG_DEFAULTS,
  clampInt,
  describeCatalog,
  routesChanged,
} from './core.js'
import { Config } from './config.js'
import {
  BRIDGE_MARKER,
  BRIDGE_PORT_SPAN,
  CATALOG_FALLBACK_URL,
  DEFAULT_BRIDGE_PORT,
  fetchJson,
  fetchZenModelIds,
  mergeCatalog,
  serveableModels,
} from './discovery.js'
import { QuotaTracker } from './quota.js'
import { AvailabilityTracker } from './availability.js'
import { installOpenCodeFreeProvider } from './provider.js'
import { makeOcAccount } from './oc-account.js'

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

  // OpenCode 账户 OAuth 设备流（第一方，直连，不依赖本机 CLI）。
  // token 只写进本插件自己的缓存目录，绝不碰 OpenCode 的 auth.json / opencode.db。
  const accountStorage = { basePath: (name) => cacheFileFor(cfg, name), readJson, writeJson }
  const ocAccount = makeOcAccount(accountStorage)

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

  // The route set this plugin currently holds, so `applyEnabled` can tell a real
  // change from a no-op. `undefined` means "never synced": the first call must
  // go through even when the desired set is empty, because the registration may
  // have been created after startup with routes already in place.
  let appliedRoutes = undefined

  /**
   * Publish the enabled state, touching the route registry only when it moves.
   *
   * Every settings write lands here through `loader/volatile-update`, and a
   * checkbox is a settings write. `replace()` is not a cheap idempotent setter:
   * it deletes and re-adds the routes and emits `llm/adapters-updated`, which
   * the model picker, the settings model list, the subagent list and the
   * account page all listen for — every one of them rebuilding its catalog.
   * Toggling one model's checkbox therefore reloaded four model catalogs across
   * the app, which is what made the checkbox feel like it had a several-hundred-
   * millisecond delay before the tick appeared.
   *
   * With the guard, only the enabled switch itself pays that: a click on it
   * changes the route set, so it still emits, and pausing still withdraws the
   * route so a stale picker list cannot survive.
   * @returns whether the plugin is enabled.
   */
  const applyEnabled = () => {
    const enabled = cfg.enabled.get() !== false
    control.enabled = () => enabled
    const wanted = enabled ? [PROVIDER] : []
    if (routesChanged(appliedRoutes, wanted) && providerHandle && typeof providerHandle.replace === 'function') {
      try {
        // Pausing must remove the route and emit llm/adapters-updated, or the
        // picker keeps showing a cached list. replace([]) keeps the
        // registration and only withdraws the routes.
        providerHandle.replace(wanted)
        appliedRoutes = wanted
      } catch (error) {
        // Leave `appliedRoutes` alone: the registry still holds the previous
        // set, so the next write must try again rather than assume success.
        warn('route sync failed:', error && error.message)
      }
    }
    return enabled
  }

  /** The retirement filter, read live: the page's switch is volatile. */
  const deprecationFilter = () => ({ includeDeprecated: cfg.includeDeprecated.get() === true })

  // 私有 Key 的配置、凭据池与校验逻辑已全部移除：路由只有 bridge 一条。
  // 账户登录开关（`ocAccountEnabled`）保留：关闭 = 登录入口禁用，已经存下的 token
  // 也不再算「已通过校验」（否则关掉开关后 UI 仍显示已登录生效）。token 本身不删
  // ——重新打开还能用，登出是显式动作。
  const ocAccountEnabled = () => cfg.ocAccountEnabled.get() !== false

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
    const primary = cfg.catalogURL.get()
    try {
      modelsDev = await fetchJson(primary, timeoutMs)
    } catch (error) {
      catalogError = error && error.message ? error.message : String(error)
      // The OpenCode host is authoritative but still a single point of failure;
      // models.dev carries the same provider block and is the documented
      // fallback. Only skipped when the operator already pointed at it.
      if (String(primary) !== CATALOG_FALLBACK_URL) {
        try {
          modelsDev = await fetchJson(CATALOG_FALLBACK_URL, timeoutMs)
          catalogError = ''
        } catch (fallbackError) {
          catalogError += ` · 备用目录: ${fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError)}`
        }
      }
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
      // 只走 bridge：本机真实 `opencode serve` 进程代发。429 时 recordWait 把
      // 「什么时候恢复」记下来给设置页显示；其余直连时代的 hook 全部删除。
      quota,
      backoffMs: () => clampInt(cfg.retryBackoffMs.get(), 100, 30_000, 800),
      // 桥的私有目录（XDG_CONFIG_HOME + serve 的 cwd）。放在插件缓存下，不碰
      // 用户自己的 OpenCode 配置。
      bridgeDir: () => cacheFileFor(cfg, 'bridge'),
    })
  } catch (error) {
    warn('provider registration failed:', error && error.message)
  }
  // `installOpenCodeFreeProvider` registers the route unconditionally, so that
  // is the state the registry is already in. Recording it keeps the first
  // `applyEnabled()` from broadcasting a no-op replace; a plugin that failed to
  // register keeps `undefined` and retries on the next write.
  if (providerHandle !== null) appliedRoutes = [PROVIDER]

  // ---- localhost catalog bridge ----
  // Zen's model endpoint answers without `Access-Control-Allow-Origin`, so the
  // page cannot fetch it. The Host already fetched it, so it serves the result
  // over loopback. The port is configurable and walks forward when busy, and
  // every response carries a marker so the page never mistakes another local
  // service for this one.
  const startBridge = () => {
    const first = clampInt(cfg.bridgePort.get(), 1024, 65_535, DEFAULT_BRIDGE_PORT)
    const sendJson = (r, obj) => {
      r.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      r.end(JSON.stringify(obj))
    }
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
      // ---- OpenCode 账户 OAuth 设备流 ----
      // 设置页发起登录、轮询、查状态、登出，供「登录可多拿免费额度」使用。
      // 注意：账户 token 不参与对话请求——请求由本机 OpenCode 客户端自己发。
      // 所有响应走 200 + JSON，错误也放 body。
      //
      // `ocAccountEnabled === false` 时**发起与轮询一律拒绝**：开关关着就该是
      // 「登录入口不可用」，而不是「入口还亮着、点下去也能拿到 token」。UI 会
      // 同时把按钮置灰，这里是第二道闸——bridge 是本地 HTTP，任何页面脚本都能
      // 直接打过来，不能只靠渲染层自觉。查询状态仍放行，否则页面无法显示
      // 「已登录但已停用」这种真实状态；登出也放行，用户任何时候都该能清掉 token。
      if (url.pathname === '/oc-login') {
        if (!ocAccountEnabled()) {
          sendJson(res, { error: 'oc_account_disabled', error_description: '账户登录已关闭（启用登录开关后再试）' })
          return
        }
        Promise.resolve(ocAccount.startDeviceAuthorization())
          .then((info) => sendJson(res, info))
          .catch((error) => sendJson(res, { error: error?.message ?? String(error) }))
        return
      }
      if (url.pathname === '/oc-login-poll') {
        if (!ocAccountEnabled()) {
          sendJson(res, { status: 'error', error: 'oc_account_disabled' })
          return
        }
        Promise.resolve(ocAccount.pollDeviceToken())
          .then((info) => sendJson(res, info))
          .catch((error) => sendJson(res, { error: error?.message ?? String(error) }))
        return
      }
      if (url.pathname === '/oc-account-status') {
        sendJson(res, { ...ocAccount.getAccountStatus(), enabled: ocAccountEnabled() })
        return
      }
      if (url.pathname === '/oc-logout') {
        ocAccount.clearAccount()
        sendJson(res, { ok: true })
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
      appliedRoutes = undefined
    }
    if (bridgeServer !== null) {
      try { bridgeServer.close() } catch { /* ignore */ }
      bridgeServer = null
    }
  })
}
