// dsh-connect-opencode-free · browser half (Settings page).
//
// One Settings page over the supported settings surface, replacing the old
// floating drawer. The page owns what the drawer used to own, plus what the
// Host now knows that the drawer never could:
//
//   · 同步      — re-read the catalog from the Host
//   · 模型启停  — toggle each model in or out of the picker
//   · 手动补模型 — ids the catalog does not carry
//   · 一键写入  — write the llm-pi-ai provider profile
//   · 额度状态  — whether the free tier is currently throttled, and until when
//
// The catalog itself is fetched from the Host over a loopback bridge, because
// Zen's model endpoint answers without `Access-Control-Allow-Origin` and the
// browser therefore cannot read it. Every read and write of configuration goes
// through `configForms`; the legacy `settingsScope` service was removed from
// the Host, and injecting it leaves the entry pending forever and fails
// `dsh web` boot with "1 entry did not activate".

import {
  BRIDGE_MARKER,
  DEFAULT_BRIDGE_PORT,
  ENTRY_ID,
  LOG_PREFIX,
  PROVIDERS_NS,
  ZEN_ROUTE_ID,
  buildProviderEntry,
  buildModelSet,
  clampInt,
  formatTokens,
  resolveEntryNamespace,
  toYamlSnippet,
} from '../lib/core.js'

const react = require('react')
const { useCallback, useEffect, useMemo, useState } = react
const h = react.createElement

/** Locale namespace owned by this page. */
const NS = 'settings.opencodeFree'

/** How often the page re-reads the Host's discovered catalog. */
const CATALOG_POLL_MS = 20_000

const zh = {
  title: 'OpenCode 免费模型',
  intro: '从 OpenCode Zen 与 models.dev 实时发现免费模型，逐个启停，或一键写入 llm-pi-ai provider。免 key，认证为 Bearer public。',
  enabled: '启用插件',
  enabledHint: '关闭后所有免费模型从模型选择器撤下，已选中的消息会被拒绝。',
  search: '搜索模型',
  syncNow: '立即同步',
  syncing: '同步中…',
  lastSync: '上次同步',
  never: '尚未同步',
  startAll: '全部启用',
  stopAll: '全部停用',
  writeProviders: '一键写入 provider',
  writing: '写入中…',
  removeProviders: '移除 provider',
  providersDone: '已把 {count} 个模型写入 llm-pi-ai.providers / {pid}',
  providersRemoved: '已移除 provider {pid}',
  providersNone: '没有可写入的模型',
  failed: '写入失败',
  refused: '宿主拒绝了写入，可把下面的配置手工粘贴到 cordis.patch.yml 的 llm-pi-ai 下：',
  notWritable: '当前连接不接受写入（远程 Web 会话只把偏好保存在浏览器内存中）。',
  noCatalog: '还没有拿到模型目录。请点「立即同步」，并确认宿主能访问 opencode.ai 与 models.dev。',
  bridgeDown: '连不上宿主目录桥（127.0.0.1），模型列表无法刷新。设置仍可修改。',
  manual: '手动添加模型',
  manualId: '模型 id',
  manualName: '显示名（可选）',
  manualContext: '上下文长度',
  manualAdd: '添加',
  manualRemove: '删除',
  manualHint: '用于目录未收录的 id；添加后立即进入模型选择器。',
  serve: '启用该模型',
  context: '上下文',
  output: '输出',
  tags: '能力',
  reasoning: '推理',
  tools: '工具',
  vision: '图像',
  fromZen: 'Zen 直报',
  fromManual: '手动',
  quotaOk: '公共免费额度正常',
  quotaThrottled: '公共免费额度已被限流，预计 {time} 后恢复',
  quotaHits: '累计被限流 {count} 次',
  keyed: '使用自有 Key（非公共额度）',
  bridgePort: '目录桥端口',
  dataSource: '数据源',
  autoSync: '自动同步',
  autoSyncHint: '宿主按下面的间隔重新发现模型；关闭后冻结，直到手动同步。',
  interval: '发现间隔（分钟）',
  includeDeprecated: '显示已弃用的免费模型',
  apiKeyEnv: '密钥环境变量',
  apiKeyHint: '逗号分隔并轮换使用；每个名字先查凭据库，再查环境变量；留空则用公共免费额度。',
  zenBaseURL: 'Zen 接口地址',
  catalogURL: '模型目录地址',
}

const en = {
  title: 'OpenCode free models',
  intro: 'Free models discovered live from OpenCode Zen and models.dev. Enable them one by one, or write the llm-pi-ai provider in one click. No key; authentication is a fixed Bearer public.',
  enabled: 'Enable plugin',
  enabledHint: 'Off removes every free model from the picker and rejects messages already using one.',
  search: 'Search models',
  syncNow: 'Sync now',
  syncing: 'Syncing…',
  lastSync: 'Last sync',
  never: 'never',
  startAll: 'Enable all',
  stopAll: 'Disable all',
  writeProviders: 'Write provider',
  writing: 'Writing…',
  removeProviders: 'Remove provider',
  providersDone: 'Wrote {count} models into llm-pi-ai.providers / {pid}',
  providersRemoved: 'Removed provider {pid}',
  providersNone: 'No model to write',
  failed: 'Write failed',
  refused: 'The Host refused the write. Paste this under llm-pi-ai in cordis.patch.yml:',
  notWritable: 'This connection does not accept writes (a remote Web session keeps preferences in browser memory).',
  noCatalog: 'No catalog yet. Press "Sync now" and make sure the Host can reach opencode.ai and models.dev.',
  bridgeDown: 'Cannot reach the Host catalog bridge on 127.0.0.1, so the list cannot refresh. Settings still save.',
  manual: 'Add a model by hand',
  manualId: 'Model id',
  manualName: 'Display name (optional)',
  manualContext: 'Context window',
  manualAdd: 'Add',
  manualRemove: 'Remove',
  manualHint: 'For ids the catalog does not carry; it joins the picker as soon as it is added.',
  serve: 'Serve this model',
  context: 'Context',
  output: 'Output',
  tags: 'Caps',
  reasoning: 'reasoning',
  tools: 'tools',
  vision: 'vision',
  fromZen: 'from Zen',
  fromManual: 'manual',
  quotaOk: 'Public free quota is healthy',
  quotaThrottled: 'Public free quota throttled; expected to recover at {time}',
  quotaHits: 'Throttled {count} times in total',
  keyed: 'Using your own key (not the public quota)',
  bridgePort: 'Catalog bridge port',
  dataSource: 'Data source',
  autoSync: 'Auto sync',
  autoSyncHint: 'The Host re-discovers models on the interval below; off freezes the list until you sync by hand.',
  interval: 'Discovery interval (minutes)',
  includeDeprecated: 'Show deprecated free models',
  apiKeyEnv: 'Key environment variable',
  apiKeyHint: 'Comma-separated and used round-robin; each name is read from the credential store first, then the environment; empty falls back to the public free quota.',
  zenBaseURL: 'Zen endpoint',
  catalogURL: 'Model catalog endpoint',
}

const ROW = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }
const LABEL = { display: 'block', margin: '14px 0 4px', fontSize: 12, opacity: 0.8 }
const INPUT = { width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #555a', background: 'transparent', color: 'inherit', fontSize: 12 }
const BUTTON = { padding: '5px 12px', borderRadius: 6, border: '1px solid #555a', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }
const NOTE = { fontSize: 11, opacity: 0.65, margin: '4px 0 0' }
const TAG = { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid #555a', opacity: 0.75, whiteSpace: 'nowrap' }

/**
 * A settings form that follows the namespace the Host actually serves.
 *
 * The Host names a namespace after the Loader entry id, which the profile patch
 * chooses — so the page re-binds whenever the served set changes instead of
 * pinning one id at mount and silently reading nothing.
 * @param forms - the `configForms` service.
 * @returns the bound form plus a disposer.
 */
function bindEntryForm(forms) {
  const listeners = new Set()
  let offBound
  let boundId
  let bound
  let snapshot = { status: 'loading', value: undefined, writable: false, revision: undefined }

  const publish = () => {
    if (bound !== undefined) snapshot = bound.getSnapshot()
    for (const listener of [...listeners]) listener()
  }
  const bind = () => {
    let served
    try {
      served = forms.describe().getSnapshot().view?.namespaces.map((row) => row.ns)
    } catch {
      served = undefined
    }
    const next = resolveEntryNamespace(served)
    if (next === undefined || next === boundId) return
    offBound?.()
    offBound = undefined
    boundId = next
    bound = forms.get(next)
    offBound = bound.subscribe(publish)
    publish()
  }

  try { forms.describe().subscribe(bind) } catch { /* mirror not ready yet */ }
  bind()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    form: () => bound,
    dispose() {
      offBound?.()
      offBound = undefined
      bound = undefined
      boundId = undefined
      listeners.clear()
    },
  }
}

/** Locate the `llm-pi-ai` namespace, which the profile patch mounts as a plain id. */
function findProvidersNamespace(forms) {
  try {
    const served = forms.describe().getSnapshot().view?.namespaces.map((row) => row.ns) ?? []
    return served.find((ns) => ns === PROVIDERS_NS) ?? served.find((ns) => /llm-pi-ai/.test(ns))
  } catch {
    return undefined
  }
}

/**
 * Read the catalog from the Host's loopback bridge.
 *
 * The port is tried across a small range because the Host walks forward when
 * its preferred port is busy, and every response must carry the marker header
 * so an unrelated local service is never mistaken for the bridge.
 * @param firstPort - the configured first port.
 * @param span - how many consecutive ports to try.
 * @param signal - abort budget for the whole scan.
 */
async function readBridgeCatalog(firstPort, span, signal) {
  for (let offset = 0; offset < span; offset++) {
    try {
      const response = await fetch(`http://127.0.0.1:${firstPort + offset}/catalog`, {
        signal, credentials: 'omit', cache: 'no-store',
      })
      if (!response.ok) continue
      if (response.headers.get(BRIDGE_MARKER) !== '1') continue
      return await response.json()
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      // A refused connection means that port is simply not ours; keep walking.
    }
  }
  throw new Error('no catalog bridge answered')
}

/**
 * The Settings page.
 *
 * @param props - `close` from the settings shell, plus the `t` translator and
 * the bound form this registration injects.
 * @returns the page element.
 */
function OpenCodeFreeSettings(props) {
  const { t, scope, forms } = props
  const [remote, setRemote] = useState(null)
  const [bridgeError, setBridgeError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [writing, setWriting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState({ id: '', name: '', contextWindow: '200000' })

  const [, forceRender] = useState(0)
  useEffect(() => scope.subscribe(() => { forceRender((n) => n + 1) }), [scope])

  const snapshot = scope.getSnapshot()
  const value = snapshot.value ?? {}
  const writable = snapshot.writable === true
  const disabledModels = Array.isArray(value.disabledModels) ? value.disabledModels : []
  const manualModels = Array.isArray(value.manualModels) ? value.manualModels : []
  const bridgePort = Number.isInteger(value.bridgePort) ? value.bridgePort : DEFAULT_BRIDGE_PORT

  /**
   * Queue one field write.
   *
   * The returned promise settles once the Host accepted the write, so a caller
   * that reads the catalog back afterwards cannot race the value it just set —
   * the bridge would otherwise answer with the previous filter.
   * @param field - config field inside this plugin's namespace.
   * @param next - the value to store.
   * @returns whether the Host accepted the write.
   */
  const set = useCallback((field, next) => {
    const form = scope.form()
    if (form === undefined) return Promise.resolve(false)
    return form.set(field, next)
  }, [scope])

  /**
   * Pull the Host's catalog; `syncToken` is what makes the Host re-read its
   * sources before answering.
   *
   * A failure keeps the previous answer rather than clearing the list, because
   * the bridge is a second service on the same machine and a single missed read
   * must not wipe a page the operator is looking at.
   */
  const load = useCallback(async (bump) => {
    if (bump === true) {
      setSyncing(true)
      set('syncToken', Date.now())
    }
    try {
      setRemote(await readBridgeCatalog(bridgePort, 10, AbortSignal.timeout(20000)))
      setBridgeError('')
    } catch (error) {
      if (bump === true) {
        setBridgeError(error && error.name === 'AbortError' ? '(timeout)' : String(error && error.message))
      }
    } finally {
      if (bump === true) setSyncing(false)
    }
  }, [bridgePort, set])

  // Read on mount, then keep reading: the Host rediscovers on its own schedule
  // and the page must show that without the operator pressing anything. A
  // timer also means a read that fails while the page is still mounting — the
  // bridge may not be listening yet — is simply retried.
  useEffect(() => {
    void load(false)
    const timer = setInterval(() => { void load(false) }, CATALOG_POLL_MS)
    return () => { clearInterval(timer) }
  }, [load])

  const rows = useMemo(() => {
    const listed = Array.isArray(remote?.catalog) ? remote.catalog : []
    const manual = manualModels
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        name: (typeof entry.name === 'string' && entry.name.trim()) || entry.id,
        description: '手动添加的 OpenCode Zen 模型',
        source: 'manual',
        contextWindow: entry.contextWindow,
        maxTokens: 0,
        reasoning: true,
        toolCall: true,
        attachment: false,
        disabled: disabledModels.includes(entry.id),
        unavailable: false,
        reason: '',
      }))
    return [...listed, ...manual]
  }, [remote, manualModels, disabledModels])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter((row) => `${row.id} ${row.name}`.toLowerCase().includes(needle))
  }, [rows, query])

  const toggle = useCallback((id) => {
    const off = disabledModels.includes(id)
    set('disabledModels', off ? disabledModels.filter((each) => each !== id) : [...disabledModels, id])
  }, [disabledModels, set])

  const setAll = useCallback((serve) => {
    const catalogIds = (Array.isArray(remote?.catalog) ? remote.catalog : []).map((row) => row.id)
    const keep = disabledModels.filter((id) => !catalogIds.includes(id))
    set('disabledModels', serve ? keep : [...new Set([...keep, ...catalogIds])])
  }, [remote, disabledModels, set])

  const addManual = useCallback(() => {
    const id = draft.id.trim()
    if (id === '') return
    if (manualModels.some((entry) => entry.id === id)) return
    const contextWindow = Number(draft.contextWindow)
    set('manualModels', [...manualModels, {
      id,
      name: draft.name.trim(),
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0
        ? Math.floor(contextWindow)
        : 200_000,
    }])
    setDraft({ id: '', name: '', contextWindow: draft.contextWindow })
  }, [draft, manualModels, set])

  const removeManual = useCallback((id) => {
    set('manualModels', manualModels.filter((entry) => entry.id !== id))
  }, [manualModels, set])

  /** Write one llm-pi-ai profile carrying every model the operator left on. */
  const writeProviders = useCallback(async () => {
    const ns = findProvidersNamespace(forms)
    const models = buildModelSet(
      Array.isArray(remote?.catalog) ? remote.catalog : [],
      manualModels,
      disabledModels,
      { defaultContextWindow: value.defaultContextWindow },
    )
    if (ns === undefined || models.length === 0) {
      setNotice({ tone: 'error', text: t('providersNone') })
      return
    }
    setWriting(true)
    try {
      const { pid, entry } = buildProviderEntry(models, ZEN_ROUTE_ID)
      const accepted = await forms.get(ns).mutate([
        { op: 'set', path: ['providers', pid], value: entry },
      ])
      setNotice(accepted
        ? { tone: 'ok', text: t('providersDone', { count: models.length, pid }) }
        : { tone: 'error', text: t('failed') })
    } catch (error) {
      setNotice({ tone: 'error', text: `${t('failed')}: ${String(error && error.message).slice(0, 200)}` })
    } finally {
      setWriting(false)
    }
  }, [forms, remote, manualModels, disabledModels, value.defaultContextWindow, t])

  const removeProviders = useCallback(async () => {
    const ns = findProvidersNamespace(forms)
    if (ns === undefined) return
    setWriting(true)
    try {
      const accepted = await forms.get(ns).mutate([
        { op: 'unset', path: ['providers', ZEN_ROUTE_ID] },
      ])
      setNotice(accepted
        ? { tone: 'ok', text: t('providersRemoved', { pid: ZEN_ROUTE_ID }) }
        : { tone: 'error', text: t('failed') })
    } catch (error) {
      setNotice({ tone: 'error', text: `${t('failed')}: ${String(error && error.message).slice(0, 200)}` })
    } finally {
      setWriting(false)
    }
  }, [forms, t])

  const quota = remote?.quota
  const syncedAt = Number(remote?.syncedAt ?? 0)
  const written = useMemo(
    () => (rows.length === 0 ? null : buildProviderEntry(buildModelSet(remote?.catalog ?? [], manualModels, disabledModels, {}))),
    [rows, remote, manualModels, disabledModels],
  )

  return h('div', { style: { padding: '10px 2px' } },
    h('p', { style: { fontSize: 12, opacity: 0.75, margin: '0 0 6px' } }, t('intro')),
    !writable ? h('p', { style: NOTE }, t('notWritable')) : null,

    h('label', { style: { ...ROW, marginTop: 6 } },
      h('input', {
        type: 'checkbox',
        checked: value.enabled !== false,
        disabled: !writable,
        onChange: (event) => { set('enabled', event.target.checked) },
      }),
      h('span', { style: { fontSize: 13 } }, t('enabled'))),
    h('p', { style: NOTE }, t('enabledHint')),

    // ---- quota ----
    quota === undefined ? null : h('p', {
      style: {
        ...NOTE,
        opacity: 1,
        margin: '8px 0',
        color: quota.throttled ? '#ff9f6b' : '#34c77b',
      },
    }, remote?.anonymous === true
      ? (quota.throttled
        ? `${t('quotaThrottled', { time: new Date(quota.resetAt).toLocaleTimeString() })} · ${t('quotaHits', { count: quota.hits })}`
        : `${t('quotaOk')}${quota.hits > 0 ? ` · ${t('quotaHits', { count: quota.hits })}` : ''}`)
      : t('keyed')),

    // ---- catalog ----
    h('div', { style: { ...ROW, marginTop: 12 } },
      h('button', { type: 'button', style: BUTTON, disabled: syncing, onClick: () => { void load(true) } },
        syncing ? t('syncing') : t('syncNow')),
      h('button', { type: 'button', style: BUTTON, disabled: writing || rows.length === 0, onClick: () => { void writeProviders() } },
        writing ? t('writing') : t('writeProviders')),
      h('button', { type: 'button', style: BUTTON, disabled: writing || rows.length === 0, onClick: () => { void removeProviders() } },
        t('removeProviders')),
      h('button', { type: 'button', style: BUTTON, disabled: !writable || rows.length === 0, onClick: () => { setAll(true) } },
        t('startAll')),
      h('button', { type: 'button', style: BUTTON, disabled: !writable || rows.length === 0, onClick: () => { setAll(false) } },
        t('stopAll'))),

    h('p', { style: NOTE }, `${t('lastSync')}: ${syncedAt > 0 ? new Date(syncedAt).toLocaleTimeString() : t('never')} · ${rows.length}`),

    h('input', {
      style: { ...INPUT, marginTop: 8 },
      type: 'search',
      placeholder: t('search'),
      value: query,
      onChange: (event) => { setQuery(event.target.value) },
    }),

    notice === null ? null : h('p', {
      style: { ...NOTE, opacity: 1, color: notice.tone === 'ok' ? '#34c77b' : '#ff6b6b' },
    }, notice.text),

    bridgeError !== '' ? h('p', { style: { ...NOTE, color: '#ff9f6b' } }, `${t('bridgeDown')} (${bridgeError})`) : null,
    remote === null && bridgeError === '' ? h('p', { style: NOTE }, t('noCatalog')) : null,
    typeof remote?.error === 'string' && remote.error !== ''
      ? h('p', { style: { ...NOTE, color: '#ff9f6b' } }, remote.error)
      : null,

    shown.length === 0 && remote !== null
      ? h('p', { style: { ...NOTE, marginTop: 8 } }, t('noCatalog'))
      : h('div', { style: { marginTop: 6 } }, shown.map((row) => h('div', { key: row.id, style: ROW },
        h('input', {
          type: 'checkbox',
          title: t('serve'),
          checked: !row.disabled && !row.unavailable,
          disabled: !writable || row.unavailable,
          onChange: () => { toggle(row.id) },
        }),
        h('span', { style: { fontSize: 12.5, flex: 1, minWidth: 0 } },
          h('span', { style: { display: 'block' } }, row.name),
          h('span', { style: { fontSize: 10.5, opacity: 0.6 } },
            row.id,
            row.source === 'zen' ? ` · ${t('fromZen')}` : (row.source === 'manual' ? ` · ${t('fromManual')}` : ''),
            row.reason !== '' ? ` · ${row.reason}` : '')),
        formatTokens(row.contextWindow) !== ''
          ? h('span', { style: TAG }, `${t('context')} ${formatTokens(row.contextWindow)}`) : null,
        formatTokens(row.maxTokens) !== '' && row.maxTokens > 0
          ? h('span', { style: TAG }, `${t('output')} ${formatTokens(row.maxTokens)}`) : null,
        row.reasoning ? h('span', { style: TAG }, t('reasoning')) : null,
        row.toolCall ? h('span', { style: TAG }, t('tools')) : null,
        row.attachment ? h('span', { style: TAG }, t('vision')) : null,
        row.source === 'manual'
          ? h('button', { type: 'button', style: BUTTON, disabled: !writable, onClick: () => { removeManual(row.id) } },
            t('manualRemove'))
          : null))),

    // ---- manual models ----
    h('label', { style: LABEL }, t('manual')),
    h('div', { style: ROW },
      h('input', {
        style: { ...INPUT, flex: 2 },
        placeholder: t('manualId'),
        value: draft.id,
        disabled: !writable,
        onChange: (event) => { setDraft({ ...draft, id: event.target.value }) },
      }),
      h('input', {
        style: { ...INPUT, flex: 2 },
        placeholder: t('manualName'),
        value: draft.name,
        disabled: !writable,
        onChange: (event) => { setDraft({ ...draft, name: event.target.value }) },
      }),
      h('input', {
        style: { ...INPUT, flex: 1 },
        type: 'number',
        placeholder: t('manualContext'),
        value: draft.contextWindow,
        disabled: !writable,
        onChange: (event) => { setDraft({ ...draft, contextWindow: event.target.value }) },
      }),
      h('button', { type: 'button', style: BUTTON, disabled: !writable, onClick: addManual }, t('manualAdd'))),
    h('p', { style: NOTE }, t('manualHint')),

    // ---- discovery settings ----
    h('label', { style: LABEL }, t('dataSource')),
    h('input', {
      style: INPUT,
      value: typeof value.zenBaseURL === 'string' ? value.zenBaseURL : '',
      disabled: !writable,
      onChange: (event) => { set('zenBaseURL', event.target.value) },
    }),
    h('input', {
      style: { ...INPUT, marginTop: 6 },
      value: typeof value.catalogURL === 'string' ? value.catalogURL : '',
      disabled: !writable,
      onChange: (event) => { set('catalogURL', event.target.value) },
    }),

    h('label', { style: { ...ROW, marginTop: 12 } },
      h('input', {
        type: 'checkbox',
        checked: value.autoSync !== false,
        disabled: !writable,
        onChange: (event) => { set('autoSync', event.target.checked) },
      }),
      h('span', { style: { fontSize: 13 } }, t('autoSync'))),
    h('p', { style: NOTE }, t('autoSyncHint')),

    h('label', { style: LABEL }, t('interval')),
    h('input', {
      style: { ...INPUT, width: 160 },
      type: 'number',
      min: 1,
      value: String(Math.round((Number(value.pollIntervalMs) || 3_600_000) / 60_000)),
      disabled: !writable,
      onChange: (event) => {
        const minutes = Number(event.target.value)
        if (Number.isFinite(minutes) && minutes > 0) set('pollIntervalMs', Math.max(60_000, Math.floor(minutes * 60_000)))
      },
    }),

    h('label', { style: { ...ROW, marginTop: 12 } },
      h('input', {
        type: 'checkbox',
        checked: value.includeDeprecated === true,
        disabled: !writable,
        onChange: (event) => {
          const show = event.target.checked
          // The Host decides which rows it serves, so the page has to re-read
          // them — after the write lands, not before.
          void set('includeDeprecated', show).then(() => { void load(false) })
        },
      }),
      h('span', { style: { fontSize: 13 } }, t('includeDeprecated'))),

    h('label', { style: LABEL }, t('apiKeyEnv')),
    h('input', {
      style: INPUT,
      value: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : '',
      disabled: !writable,
      onChange: (event) => { set('apiKeyEnv', event.target.value) },
    }),
    h('p', { style: NOTE }, t('apiKeyHint')),

    h('label', { style: LABEL }, t('bridgePort')),
    h('input', {
      style: { ...INPUT, width: 160 },
      type: 'number',
      min: 1024,
      max: 65_535,
      value: String(bridgePort),
      disabled: !writable,
      onChange: (event) => {
        const port = clampInt(event.target.value, 1024, 65_535, DEFAULT_BRIDGE_PORT)
        set('bridgePort', port)
      },
    }),

    // ---- escape hatch ----
    written === null ? null : h('details', { style: { marginTop: 12 } },
      h('summary', { style: { fontSize: 12, opacity: 0.7, cursor: 'pointer' } }, t('refused')),
      h('pre', {
        style: {
          fontSize: 11, overflow: 'auto', opacity: 0.85,
          background: 'rgba(127,127,127,0.12)', padding: 8, borderRadius: 6,
        },
      }, toYamlSnippet(written))),
  )
}

/** Stable browser-plugin name. */
const name = 'dsh-connect-opencode-free-client'

/**
 * `configForms` is soft-probed rather than injected: cordis' dependency gate is
 * hard, so declaring a service this Host line does not provide keeps `apply`
 * from ever running. `slots` and `locale` are the two every line ships.
 */
const inject = ['slots', 'locale']

/**
 * Mount the settings page and the form binding behind it.
 * @param ctx - the browser plugin context.
 */
function apply(ctx) {
  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${ENTRY_ID}: settings copy`)
    const t = ctx.locale.bind(NS)
    const forms = ctx.get('configForms')
    if (forms === undefined || typeof forms.get !== 'function') {
      console.warn(LOG_PREFIX, 'configForms unavailable; the settings page needs the settings surface')
      return
    }
    const scope = bindEntryForm(forms)
    ctx.effect(() => () => { scope.dispose() }, `${ENTRY_ID}: form subscription`)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'opencode-free',
      order: 60,
      label: () => t('title'),
      locale: NS,
      // The provider write addresses a different namespace than this page's own
      // config, so the forms service travels with the page rather than being
      // looked up again at write time.
      inject: () => ({ t, scope, forms }),
    }, OpenCodeFreeSettings))
  } catch (error) {
    console.error(LOG_PREFIX, 'client page failed to load (host provider unaffected):', error)
  }
}

export { apply, inject, name }
