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
  BRIDGE_PORT_SPAN,
  DEFAULT_BRIDGE_PORT,
  ENTRY_ID,
  KEY_GATED_POLICIES,
  LOG_PREFIX,
  PROVIDERS_NS,
  QUOTA_POLICIES,
  ZEN_ROUTE_ID,
  apiKeyNameFor,
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
  quotaRefused: '公共免费额度通道已被拒绝（{time} 前），期间改用私有额度',
  quotaClosed: '公共免费额度暂不可用，本次会直接用私有额度',
  keyConfigured: '已配置 {count} 个 Key · 当前规则：{policy}',
  noKeyOnly: '未配置 Key：只能用公共免费额度',
  laneRule: '额度规则：每次调用先走公共免费额度；只有出现「公共免费额度已用尽」或「拒绝了匿名免费档调用」时才回退到已配置的 Key。窗口过后自动回到公共额度。',
  keyed: '使用自有 Key（非公共额度）',
  bridgePort: '目录桥端口',
  dataSource: '数据源',
  autoSync: '自动同步',
  autoSyncHint: '宿主按下面的间隔重新发现模型；关闭后冻结，直到手动同步。',
  interval: '发现间隔（分钟）',
  includeDeprecated: '显示已下架的免费模型',
  includeDeprecatedHint: '默认不显示任何已下架的模型：models.dev 标记弃用的，以及 Zen 已下架的。勾选后两者都会列出，但 Zen 已下架的仍标记为不可用，勾了也无法调用。',
  retry: '失败重试',
  retryAttempts: '最多尝试几次',
  retryBackoff: '初始退避（毫秒）',
  retryHint: '遇到 429 限流或 5xx（含 Zen 网关 502 上游连接超时）时自动退避重试。默认 10 次；退避逐次翻倍、单次最长 8 秒，十次合计约 1 分钟。全部失败后错误信息会写明已重试几次。',
  quotaPolicy: '使用规则',
  policyPublicOnly: '仅使用公共额度',
  policyPublicOnlyHint: '默认规则。任何情况下都不动用 Key，即使配置了也不用。',
  policyPreferPublic: '优先使用公共额度',
  policyPreferPublicHint: '先用公共额度；只有「公共免费额度已用尽」或「拒绝了匿名免费档调用」时才回退到 Key。',
  policyPreferKey: '优先使用私有额度',
  policyPreferKeyHint: '先用 Key；Key 无效、被拒或额度用尽时才回退到公共额度。',
  policyLocked: '需先通过 Key 校验才能选用',
  verifyKey: '校验 Key',
  verifying: '校验中…',
  keyVerified: 'Key 校验通过（{time}）',
  keyRejected: 'Key 校验未通过：{reason}',
  keyUnchecked: '尚未校验 Key',
  keyPending: '已填写 Key，正在同步到宿主…',
  apiKeys: '私有额度 Key',
  apiKeysHint: '逐条粘贴 Key 即可，不需要配置环境变量。保存后插件会自动按行号写入进程环境变量（见每行左侧名字），重启后依然有效。',
  keyAdd: '添加 Key',
  keyRemove: '删除这条 Key',
  zenKey: '在 opencode.ai/zen 领取 Key',
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
  quotaRefused: 'Public free lane was refused ({time} ago); using your key meanwhile',
  quotaClosed: 'Public free quota unavailable right now; requests go straight to your key',
  keyConfigured: '{count} key(s) configured · current rule: {policy}',
  noKeyOnly: 'No key configured: only the public free quota is available',
  laneRule: 'Quota rule: every call tries the public free quota first, and falls back to a configured key only on "public quota exhausted" or "anonymous free tier refused". It returns to the public quota once the window passes.',
  keyed: 'Using your own key (not the public quota)',
  bridgePort: 'Catalog bridge port',
  dataSource: 'Data source',
  autoSync: 'Auto sync',
  autoSyncHint: 'The Host re-discovers models on the interval below; off freezes the list until you sync by hand.',
  interval: 'Discovery interval (minutes)',
  includeDeprecated: 'Show withdrawn free models',
  includeDeprecatedHint: 'Off by default: neither the models models.dev has retired nor the ones Zen has taken down are listed. Turning it on lists both, but one Zen withdrew stays marked unavailable and cannot be called.',
  retry: 'Failure retries',
  retryAttempts: 'Attempts',
  retryBackoff: 'Initial backoff (ms)',
  retryHint: 'Retried with backoff on 429 throttling and any 5xx (including Zen gateway 502 upstream connect timeouts). Default 10; the step doubles each time and is capped at 8s, so ten attempts wait about a minute in total. The final error states how many were spent.',
  quotaPolicy: 'Usage rule',
  policyPublicOnly: 'Public quota only',
  policyPublicOnlyHint: 'The default. Never spends a key, even when one is configured.',
  policyPreferPublic: 'Prefer the public quota',
  policyPreferPublicHint: 'Public quota first; falls back to a key only on "public quota exhausted" or "anonymous free tier refused".',
  policyPreferKey: 'Prefer your own quota',
  policyPreferKeyHint: 'Key first; falls back to the public quota when the key is rejected, invalid, or out of quota.',
  policyLocked: 'Requires a verified key',
  verifyKey: 'Verify key',
  verifying: 'Verifying…',
  keyVerified: 'Key verified ({time})',
  keyRejected: 'Key check failed: {reason}',
  keyUnchecked: 'Key not verified yet',
  keyPending: 'Key entered; syncing to the Host…',
  apiKeys: 'Private-quota keys',
  apiKeysHint: 'Paste each key on its own row — no environment variables to configure. The plugin exports them under the names shown at the left of each row, and they survive a restart.',
  keyAdd: 'Add key',
  keyRemove: 'Remove this key',
  zenKey: 'Get a key at opencode.ai/zen',
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
 * Ask the Host to prove a configured key works.
 *
 * Costs one upstream request, so it is never implicit: the operator presses a
 * button. `force` re-checks even when a previous verdict is still valid.
 * @param firstPort - configured bridge port.
 * @param span - how many ports to walk.
 * @param force - re-check instead of reusing the cached verdict.
 * @returns the Host's verdict.
 */
async function requestKeyCheck(firstPort, span, force) {
  for (let offset = 0; offset < span; offset++) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${firstPort + offset}/verify-key${force ? '?force=1' : ''}`,
        { credentials: 'omit', cache: 'no-store' },
      )
      if (!response.ok) continue
      if (response.headers.get(BRIDGE_MARKER) !== '1') continue
      return await response.json()
    } catch {
      // Not our port; keep walking.
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
  // The key verdict is local to the page: the Host is the authority, but pressing
  // "verify" must give immediate feedback, so the answer is echoed here until
  // the next catalog read overwrites it with the same fact.
  const [keyCheck, setKeyCheck] = useState(null)
  const [verifying, setVerifying] = useState(false)
  // The keys being edited. Held locally so typing does not write the profile on
  // every keystroke; the whole list is committed on each change instead, which
  // is also what makes the Host re-export it immediately.
  const [keyDraft, setKeyDraft] = useState(null)

  // Checkbox ticks shown ahead of the Host, keyed by field. A write is a
  // round trip through the Host and back, and a tick that only appears when it
  // lands reads as an unresponsive control — so the press is echoed at once and
  // the entry is dropped the moment the snapshot agrees (or disagrees: a
  // refused write then snaps back, which is the honest outcome).
  const [optimistic, setOptimistic] = useState({})
  const tickOf = (field, committed) => {
    const pending = optimistic[field]
    return pending === undefined ? committed === true : pending === true
  }


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
   * Write one boolean field and echo the press immediately.
   *
   * The echo is cleared when the snapshot catches up, and replaced with the
   * committed value when the write failed, so the control always converges on
   * what is actually stored.
   * @param field - config field inside this plugin's namespace.
   * @param next - the value being turned on.
   */
  const toggleBoolean = useCallback(async (field, next) => {
    setOptimistic((prev) => ({ ...prev, [field]: next }))
    const accepted = await set(field, next)
    setOptimistic((prev) => {
      if (!(field in prev)) return prev
      const rest = { ...prev }
      delete rest[field]
      if (accepted !== true) rest[field] = next === true
      return rest
    })
  }, [set])

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
      setRemote(await readBridgeCatalog(bridgePort, BRIDGE_PORT_SPAN, AbortSignal.timeout(20000)))
      setBridgeError('')
    } catch (error) {
      if (bump === true) {
        setBridgeError(error && error.name === 'AbortError' ? '(timeout)' : String(error && error.message))
      }
    } finally {
      if (bump === true) setSyncing(false)
    }
  }, [bridgePort, set])

  /**
   * Prove a configured key works, so the key-gated rules may be chosen.
   *
   * The Host is the authority and keeps the verdict across restarts; this only
   * mirrors it so the operator sees the result of the press they just made. A
   * failure is shown as a message rather than silently leaving the old one,
   * because the whole point is knowing which way it went.
   */
  const verifyKey = useCallback(async () => {
    setVerifying(true)
    try {
      const result = await requestKeyCheck(bridgePort, BRIDGE_PORT_SPAN, true)
      setKeyCheck(result)
      void load(false)
      return result
    } catch (error) {
      setKeyCheck({ ok: false, status: 0, reason: error?.message ?? String(error) })
      return null
    } finally {
      setVerifying(false)
    }
  }, [bridgePort, load])

  /**
   * The keys as edited, falling back to what the Host holds.
   *
   * `keyDraft` is null until the operator touches a row, so the page shows the
   * persisted list rather than an empty one on first paint.
   */
  const keyValues = keyDraft !== null
    ? keyDraft
    : (Array.isArray(value.apiKeys) ? value.apiKeys.map((v) => String(v ?? '')) : [])

  /**
   * Commit the whole key list.
   *
   * One write per edit, not per keystroke, so the profile is not rewritten
   * constantly — and the Host re-exports the variables on the write it does
   * get, which is what makes a newly typed key immediately verifiable.
   * @param next - the new list.
   */
  const commitKeys = useCallback(async (next) => {
    setKeyDraft(next)
    return set('apiKeys', next)
  }, [set])
  const replaceKey = (index, next) => commitKeys(keyValues.map((v, i) => (i === index ? next : v)))
  const removeKey = (index) => commitKeys(keyValues.filter((_, i) => i !== index))
  const addKey = () => commitKeys([...keyValues, ''])

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

  // Which model rows are mid-write. The list has one checkbox per model, so
  // this is the control the operator clicks dozens of times in a row; echoing
  // the press locally keeps each click independent instead of queueing behind
  // the Host round trip that redraws the whole list.
  const [pendingModels, setPendingModels] = useState({})

  const toggle = useCallback(async (id) => {
    const off = disabledModels.includes(id)
    const next = off
      ? disabledModels.filter((each) => each !== id)
      : [...disabledModels, id]
    setPendingModels((prev) => ({ ...prev, [id]: !off }))
    const accepted = await set('disabledModels', next)
    setPendingModels((prev) => {
      if (!(id in prev)) return prev
      const rest = { ...prev }
      delete rest[id]
      if (accepted !== true) rest[id] = !off
      return rest
    })
  }, [disabledModels, set])

  // Echoed wholesale: the click lands on every row at once, so there is no
  // per-row pending state to wait on and the whole list waits for the Host.
  const setAll = useCallback(async (serve) => {
    const catalogIds = (Array.isArray(remote?.catalog) ? remote.catalog : []).map((row) => row.id)
    const keep = disabledModels.filter((id) => !catalogIds.includes(id))
    const pending = {}
    for (const id of catalogIds) pending[id] = serve
    setPendingModels(pending)
    const accepted = await set('disabledModels', serve ? keep : [...new Set([...keep, ...catalogIds])])
    if (accepted === true) setPendingModels({})
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
  // How many keys the Host resolved — not whether one is in use. Which lane a
  // request spends is the operator's `quotaPolicy`, so "has a key" and "is
  // paying for this request" are separate facts and the page shows them apart.
  const keyCount = Number(remote?.keyCount ?? 0)
  // Whether the Host has a key it has proven works. This, not the mere presence
  // of a key, is what unlocks the two keyed rules.
  const keyVerified = remote?.keyVerified === true
  const policyValue = QUOTA_POLICIES.includes(value.quotaPolicy) ? value.quotaPolicy : 'publicOnly'
  // Keys with something in them, counted locally. The Host's `keyCount` can lag
  // by a settings round trip; this is what the operator just typed, and it is
  // what the verify button is gated on. Declared before its first use — a
  // `const` referenced earlier in the same scope throws on render, which is how
  // this page went blank for a whole release.
  const filledKeyCount = keyValues.filter((v) => v.trim() !== '').length
  // The verdict to show: this page's own answer if the operator just pressed
  // the button, otherwise whatever the Host last persisted.
  const verdict = keyCheck !== null ? keyCheck : remote?.keyCheck
  const keyCheckLine = filledKeyCount === 0
    ? t('noKeyOnly')
    : (verdict === null || verdict === undefined
      ? t('keyUnchecked')
      : (verdict.ok === true
        ? t('keyVerified', { time: Number(verdict.checkedAt ?? 0) > 0 ? new Date(verdict.checkedAt).toLocaleTimeString() : '—' })
        : t('keyRejected', { reason: String(verdict.reason ?? '') })))
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
        checked: tickOf('enabled', value.enabled !== false),
        disabled: !writable,
        onChange: (event) => { void toggleBoolean('enabled', event.target.checked) },
      }),
      h('span', { style: { fontSize: 13 } }, t('enabled'))),
    h('p', { style: NOTE }, t('enabledHint')),

    // ---- quota ----
    // Two facts, not one. Whether the free lane is usable right now, and
    // whether a key is waiting behind it — because the lane leads and the key
    // follows, "key configured" no longer means "key in use".
    quota === undefined ? null : h('p', {
      style: {
        ...NOTE,
        opacity: 1,
        margin: '8px 0',
        color: quota.throttled || quota.refused ? '#ff9f6b' : '#34c77b',
      },
    }, quota.refused
      ? `${t('quotaRefused', { time: new Date(quota.refusedAt ?? Date.now()).toLocaleTimeString() })}`
      : (quota.throttled
        ? `${t('quotaThrottled', { time: new Date(quota.resetAt).toLocaleTimeString() })} · ${t('quotaHits', { count: quota.hits })}`
        : `${t('quotaOk')}${quota.hits > 0 ? ` · ${t('quotaHits', { count: quota.hits })}` : ''}`)),
    quota?.closed === true && keyVerified && policyValue !== 'publicOnly'
      ? h('p', { style: { ...NOTE, color: '#ff9f6b' } }, t('quotaClosed'))
      : null,
    // Only the count here. Whether those keys are usable, and whether the
    // current rule would ever spend them, are shown next to the rule itself —
    // one fact per line, so nothing has to be inferred.
    filledKeyCount > 0
      ? h('p', { style: NOTE }, t('keyConfigured', {
        count: filledKeyCount,
        policy: t(`policy${policyValue[0].toUpperCase()}${policyValue.slice(1)}`),
      }))
      : null,

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
          checked: pendingModels[row.id] ?? (!row.disabled && !row.unavailable),
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
        checked: tickOf('autoSync', value.autoSync !== false),
        disabled: !writable,
        onChange: (event) => { void toggleBoolean('autoSync', event.target.checked) },
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
        checked: tickOf('includeDeprecated', value.includeDeprecated === true),
        disabled: !writable,
        onChange: (event) => {
          const show = event.target.checked
          // The Host decides which rows it serves, so the page has to re-read
          // them — after the write lands, not before. The tick itself is
          // echoed at once so the click does not wait on that round trip.
          void toggleBoolean('includeDeprecated', show).then(() => { void load(false) })
        },
      }),
      h('span', { style: { fontSize: 13 } }, t('includeDeprecated'))),
    h('p', { style: NOTE }, t('includeDeprecatedHint')),

    h('label', { style: LABEL }, t('retry')),
    h('div', { style: { ...ROW, marginTop: 4, alignItems: 'center' } },
      h('span', { style: { fontSize: 12.5, opacity: 0.8 } }, t('retryAttempts')),
      h('input', {
        style: { ...INPUT, width: 90 },
        type: 'number',
        min: 1,
        max: 20,
        value: String(clampAttempts(value.maxRequestAttempts)),
        disabled: !writable,
        onChange: (event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 1) set('maxRequestAttempts', Math.min(20, Math.floor(next)))
        },
      }),
      h('span', { style: { fontSize: 12.5, opacity: 0.8, marginLeft: 16 } }, t('retryBackoff')),
      h('input', {
        style: { ...INPUT, width: 110 },
        type: 'number',
        min: 100,
        max: 30_000,
        step: 100,
        value: String(clampBackoff(value.retryBackoffMs)),
        disabled: !writable,
        onChange: (event) => {
          const next = Number(event.target.value)
          if (Number.isFinite(next) && next >= 100) set('retryBackoffMs', Math.min(30_000, Math.floor(next)))
        },
      }),
    ),
    h('p', { style: NOTE }, t('retryHint')),

    h('label', { style: LABEL }, t('apiKeys')),
    h('p', { style: { ...NOTE, margin: '0 0 6px' } },
      h('a', {
        href: 'https://opencode.ai/zen',
        target: '_blank',
        rel: 'noreferrer noopener',
        style: { color: 'inherit', textDecoration: 'underline' },
      }, t('zenKey'))),

    // ---- key editor ----
    // One row per key, value only. The environment variable name is derived
    // from the row's position and shown read-only, because "set an environment
    // variable" is a step most operators should never have to take — and one
    // they cannot complete without restarting the process, which is what made
    // a freshly added key read as "no key" and left Verify dead.
    ...keyValues.map((keyValue, index) => h('div', { key: `key-${index}`, style: { ...ROW, marginTop: 4 } },
      h('span', { style: { fontSize: 10.5, opacity: 0.6, width: 150, flexShrink: 0 } }, apiKeyNameFor(index)),
      h('input', {
        style: { ...INPUT, flex: 1 },
        type: 'text',
        autoComplete: 'off',
        spellCheck: false,
        placeholder: 'sk-…',
        value: keyValue,
        disabled: !writable,
        onChange: (event) => { void replaceKey(index, event.target.value) },
      }),
      h('button', {
        type: 'button',
        style: { ...BUTTON, padding: '4px 8px' },
        disabled: !writable,
        title: t('keyRemove'),
        onClick: () => { void removeKey(index) },
      }, '×'))),
    h('div', { style: { ...ROW, marginTop: 6 } },
      h('button', {
        type: 'button',
        style: BUTTON,
        disabled: !writable,
        onClick: () => { void addKey() },
      }, t('keyAdd'))),
    h('p', { style: NOTE }, t('apiKeysHint')),

    // ---- usage rule ----
    // Three options, not a boolean: "I have a key" and "use my key" are
    // different decisions, and the default has to be the one that keeps this
    // plugin free. The two keyed rules stay disabled until the Host says the key
    // was accepted — otherwise a typo would silently bill a lane that then fails
    // for every request, and it would read as an outage rather than a typo.
    h('label', { style: { ...LABEL, marginTop: 16 } }, t('quotaPolicy')),
    ...QUOTA_POLICIES.map((policy) => {
      const gated = KEY_GATED_POLICIES.includes(policy) && keyVerified !== true
      return h('label', {
        key: policy,
        style: { ...ROW, opacity: gated ? 0.5 : 1, cursor: gated ? 'not-allowed' : 'pointer' },
      },
        h('input', {
          type: 'radio',
          name: 'opencode-free-quota-policy',
          value: policy,
          checked: policyValue === policy,
          disabled: !writable || gated,
          onChange: () => { void set('quotaPolicy', policy) },
        }),
        h('span', { style: { fontSize: 13 } }, t(`policy${policy[0].toUpperCase()}${policy.slice(1)}`)),
        gated ? h('span', { style: { fontSize: 10.5, opacity: 0.7 } }, `· ${t('policyLocked')}`) : null)
    }),
    h('p', { style: NOTE }, t(`policy${String(policyValue)[0].toUpperCase()}${String(policyValue).slice(1)}Hint`)),

    // ---- key verification ----
    // Enabled by what the operator typed, not by what the Host has parsed yet:
    // gating it on `keyCount` made the button dead for exactly the people who
    // had just added a key, which reads as "nothing happens when I click".
    h('div', { style: { ...ROW, marginTop: 8 } },
      h('button', {
        type: 'button',
        style: BUTTON,
        disabled: !writable || verifying || filledKeyCount === 0,
        onClick: () => { void verifyKey() },
      }, verifying ? t('verifying') : t('verifyKey')),
      h('span', { style: { fontSize: 11.5, opacity: 0.85 } }, keyCheckLine)),
    // The Host only learns about a key on the next settings change, so there is
    // a window where the page has one and the Host does not. Saying so is the
    // difference between "waiting" and "broken".
    filledKeyCount > 0 && keyCount === 0
      ? h('p', { style: { ...NOTE, color: '#ff9f6b' } }, t('keyPending'))
      : null,
    h('p', { style: NOTE }, t('laneRule')),

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
 * The retry count to show in the input.
 *
 * The schema default is the operator's real behaviour when they have never
 * touched the field, so an absent value has to read as that default rather than
 * as an empty box they might "fix" into a lower number.
 * @param value - the stored `maxRequestAttempts`, possibly undefined.
 * @returns a number safe to put in the input.
 */
function clampAttempts(value) {
  return clampInt(value, 1, 20, 10)
}

/**
 * The initial backoff to show in the input.
 *
 * Same reasoning as {@link clampAttempts}: a profile written before this field
 * existed reads as the default, not as zero.
 * @param value - the stored `retryBackoffMs`, possibly undefined.
 * @returns a number safe to put in the input.
 */
function clampBackoff(value) {
  return clampInt(value, 100, 30_000, 800)
}

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
