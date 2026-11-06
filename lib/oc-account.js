// dsh-connect-opencode-free · OpenCode 账户 OAuth 设备流（Host only）。
//
// 只保留设置页要用的「登录 / 轮询 / 状态 / 登出」。⚠️ 账户 token **不参与对话
// 请求**：2026-11-06 起出网只走本机真实 `opencode serve` 进程（bridge），
// 请求头与凭据由那个客户端自己负责。曾经用这个 token 直连 inference 网关的
//「账户直连 lane」已随旧的凭据轮换逻辑一起删除，不要再把 token 接回请求路径。
//
// 端点（已用真实请求验证存在并返回正确结构）：
//   POST https://opencode.ai/console/auth/device/code
//     body: { client_id: "opencode-cli" }
//     → { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
//   POST https://opencode.ai/console/auth/device/token
//     device grant: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id }
//     → { access_token, refresh_token, expires_in, ... }
//
// 设计：本模块不依赖任何外部 OAuth SDK，也不碰 OpenCode CLI 的私有文件
// （auth.json / opencode.db 都属于另一个程序）。它自己跑设备流，把 token
// 存进本插件自己的缓存目录（由 index.js 通过 storage 注入）。

const CONSOLE_BASE = 'https://opencode.ai/console'
const DEVICE_CODE_URL = `${CONSOLE_BASE}/auth/device/code`
const DEVICE_TOKEN_URL = `${CONSOLE_BASE}/auth/device/token`
const CLIENT_ID = 'opencode-cli'
const USER_AGENT = 'opencode/stable/2.0.31/opencode'

const TOKEN_FILE = 'opencode-account-token.json'
const PENDING_FILE = 'opencode-account-pending.json'

// 单次轮询最长等待（前端以此决定多久放弃）。
const POLL_HARD_TIMEOUT_MS = 10 * 60 * 1000

/**
 * @param storage - 由宿主注入的缓存接口：
 *   { readJson(path), writeJson(path, value), basePath(name) }
 *   basePath 返回本插件缓存目录下的绝对路径（沿用 index.js 的 cacheFileFor）。
 * @returns 设备流 + token 管理的一组方法。
 */
export function makeOcAccount(storage) {
  const tokenPath = () => storage.basePath(TOKEN_FILE)
  const pendingPath = () => storage.basePath(PENDING_FILE)

  const readToken = () => storage.readJson(tokenPath()) ?? null
  const writeToken = (value) => storage.writeJson(tokenPath(), value)
  const readPending = () => storage.readJson(pendingPath()) ?? null
  const writePending = (value) => (value ? storage.writeJson(pendingPath(), value) : storage.writeJson(pendingPath(), null))

  /**
   * 起一次设备授权，返回给用户去浏览器完成登录。
   * @returns `{ user_code, verification_uri, verification_uri_complete, interval, expires_in }`
   *   或 `{ error, error_description }`（端点不可达时）。
   */
  async function startDeviceAuthorization() {
    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    })
    const raw = await res.text().catch(() => '')
    if (!res.ok) {
      return { error: `device_code_http_${res.status}`, error_description: raw.slice(0, 200) }
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return { error: 'bad_device_code_response', error_description: raw.slice(0, 200) }
    }
    if (!data || typeof data.device_code !== 'string') {
      return { error: 'no_device_code', error_description: raw.slice(0, 200) }
    }
    // 记住待轮询状态。verification 链接是相对路径，补成绝对地址方便前端直接打开。
    const verification_uri_complete = data.verification_uri_complete
      ? (data.verification_uri_complete.startsWith('http')
        ? data.verification_uri_complete
        : `https://opencode.ai${data.verification_uri_complete}`)
      : `https://opencode.ai${data.verification_uri ?? '/console/device'}`
    const pending = {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri_complete,
      interval: Number(data.interval) || 5,
      expires_at: Date.now() + (Number(data.expires_in) || 600) * 1000,
    }
    writePending(pending)
    return {
      user_code: pending.user_code,
      verification_uri: pending.verification_uri_complete,
      verification_uri_complete: pending.verification_uri_complete,
      interval: pending.interval,
      expires_in: Number(data.expires_in) || 600,
    }
  }

  /**
   * 轮询一次 token 端点（设备 grant）。供前端定时调用。
   * @returns
   *   { status: 'pending' } — 用户还没完成登录
   *   { status: 'done', account: {...} } — 拿到 token，已落盘
   *   { status: 'expired' } — device_code 过期，需重新 start
   *   { status: 'error', error } — 其他错误
   */
  async function pollDeviceToken() {
    const pending = readPending()
    if (!pending || !pending.device_code) return { status: 'expired' }
    if (Date.now() > pending.expires_at) {
      writePending(null)
      return { status: 'expired' }
    }
    const res = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: pending.device_code,
        client_id: CLIENT_ID,
      }),
    })
    const raw = await res.text().catch(() => '')
    let data
    try { data = JSON.parse(raw) } catch { data = null }
    const err = data && typeof data.error === 'string' ? data.error : ''
    if (res.ok && data && typeof data.access_token === 'string') {
      const token = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? null,
        expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        obtained_at: Date.now(),
      }
      writeToken(token)
      writePending(null)
      return { status: 'done', account: { expires_at: token.expires_at } }
    }
    if (err === 'authorization_pending') return { status: 'pending' }
    if (err === 'slow_down') return { status: 'pending' } // 继续轮询，间隔照常
    if (err === 'expired_token' || err === 'access_denied') {
      writePending(null)
      return { status: 'expired' }
    }
    return { status: 'error', error: err || `http_${res.status}`, error_description: raw.slice(0, 200) }
  }

  /** 是否已有（不算过期的）账户 token。 */
  function hasAccountToken() {
    const current = readToken()
    if (!current || !current.access_token) return false
    const expiresAt = Number(current.expires_at) || 0
    return expiresAt > Date.now()
  }

  /** 登出：清空 token 与待轮询状态。 */
  function clearAccount() {
    writeToken(null)
    writePending(null)
  }

  /**
   * 给设置页用的状态快照。
   * @returns { loggedIn, expiresAt, hasRefresh, pending }
   */
  function getAccountStatus() {
    const current = readToken()
    const pending = readPending()
    return {
      loggedIn: hasAccountToken(),
      expiresAt: current ? Number(current.expires_at) || 0 : 0,
      hasRefresh: !!(current && current.refresh_token),
      pending: !!pending,
    }
  }

  return {
    startDeviceAuthorization,
    pollDeviceToken,
    hasAccountToken,
    clearAccount,
    getAccountStatus,
    POLL_HARD_TIMEOUT_MS,
  }
}
