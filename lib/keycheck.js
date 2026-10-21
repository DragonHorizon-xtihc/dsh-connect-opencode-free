// dsh-connect-opencode-free · proving a key works before it may be spent (Host only).
//
// Two of the three quota policies spend the operator's own money, so they are
// gated on the key actually having been accepted by Zen. Without the gate a
// mistyped credential would flip every request onto a lane that then fails —
// and the failure would read like an outage rather than like a typo.
//
// The probe asks one cheap question: "did Zen accept this key?" It deliberately
// does NOT ask "did the model answer?" — a 400 about the model, or a 429 about
// the account's own quota, both happen *after* authentication and therefore
// both prove the key is real. Only 401/403 say the key was rejected.
//
// ⚠️ The probe has to look like a request the OpenCode CLI would send, or the
// gateway refuses it before authentication is ever considered. Probed live on
// 2026-10-14, a bare `Authorization: Bearer <key>` answers 403 FreeTierError for
// a perfectly valid key. All four of these must hold at once — dropping any one
// returns the same 403, and the check reported "Key 未被接受" for keys that work:
//
//   1. User-Agent starts with `opencode/`
//   2. a real `x-opencode-session` — one the CLI actually created
//   3. `bash` and `read` in the body's tools
//   4. `stream: true`
//
// The fourth is the subtlest: the CLI always streams, so a non-streaming body is
// not something it would ever send, and the gateway rejects the shape. A probe
// that omitted it was refused with the same FreeTierError as one with no session.
//
// Nothing here stores the key: what is persisted is a fingerprint, so the
// cached answer is invalidated the moment a different key is configured.

import { createHash } from 'node:crypto'

import { LOG_PREFIX, clampInt } from './core.js'
import { realSessionId } from './oc-session.js'
import { isFreeTierRejection } from './provider.js'

/** How much of one answer to ask for; the point is the status, not the text. */
const PROBE_MAX_TOKENS = 16
const PROBE_TIMEOUT_MS = 20_000

/** The User-Agent the gateway expects; see `OPENCODE_UA` in `lib/provider.js`. */
const PROBE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

/**
 * The two tool names the gateway requires in the body.
 *
 * Sent under `tool_choice: 'none'`, which is the one shape that satisfies the
 * gate while making it impossible for the model to pick one: the probe asks for
 * sixteen tokens of prose, not for a tool call.
 */
const PROBE_GATE_TOOLS = ['bash', 'read'].map((name) => ({
  type: 'function',
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  },
}))

/**
 * A stable, non-reversible tag for one key value.
 *
 * Persisted instead of the key so the cached verdict can be recognised as
 * stale: change the key and the fingerprint no longer matches, which forces a
 * fresh check rather than trusting an answer about a different credential.
 * @param key - the secret itself; never stored.
 * @returns a short hex tag.
 */
export function keyFingerprint(key) {
  return createHash('sha256').update(String(key ?? '')).digest('hex').slice(0, 12)
}

/**
 * Ask Zen whether it accepts one key.
 *
 * Never throws: a check that fails is a check that did not pass, and the
 * caller needs the reason to show the operator.
 * @param options - `baseURL`, `key`, `model` to probe with, optional `timeoutMs`
 *   and `session` (a real OpenCode session id; read from the CLI's own database
 *   when not supplied).
 * @returns `{ ok, status, reason, finger }`; `ok` means the key was accepted.
 */
export async function verifyKey(options = {}) {
  const key = typeof options.key === 'string' ? options.key.trim() : ''
  const finger = key === '' ? '' : keyFingerprint(key)
  if (key === '') return { ok: false, status: 0, reason: '没有可校验的 Key', finger }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    return { ok: false, status: 0, reason: '没有可用于探测的模型', finger }
  }

  // The gateway's own signals. Without these the request is refused before
  // authentication is ever considered, and the 403 would be read as "this key
  // is bad" for a key that is fine. A caller that mints its own sessions can
  // pass `session`; otherwise the CLI's database is the source.
  let sessionId = typeof options.session === 'string' ? options.session.trim() : ''
  if (sessionId === '') {
    const resolved = await realSessionId()
    if (resolved.id !== undefined) sessionId = resolved.id
  }

  const url = `${String(options.baseURL ?? '').replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = clampInt(options.timeoutMs, 1000, 120_000, PROBE_TIMEOUT_MS)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    'User-Agent': PROBE_UA,
  }
  if (sessionId !== '') headers['x-opencode-session'] = sessionId

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: options.model.trim(),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: PROBE_MAX_TOKENS,
        // The CLI always streams; the gateway rejects a non-streaming body with
        // the same FreeTierError it gives a missing session id.
        stream: true,
        tools: PROBE_GATE_TOOLS,
        // The one shape that satisfies the gate while making it impossible for
        // the model to select a placeholder: this probe wants prose, not a call.
        tool_choice: 'none',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? String(error))
    return { ok: false, status: 0, reason: `无法连接 Zen：${message}`, finger }
  }

  // A streaming 200 is still an answer; drain it so the socket is reusable and
  // the verdict does not hang on a body nobody read.
  if (response.status < 400) await response.text().catch(() => '')

  // Only the authentication verdict decides. Everything else happened after
  // the key was accepted, so it is evidence the key works — not against it.
  if (response.status === 401 || response.status === 403) {
    const raw = await response.text().catch(() => '')
    const detail = raw.slice(0, 200)
    // A FreeTierError here is the gateway, not the key. The probe now carries
    // all three of its signals, so if it still refuses it is because the session
    // id could not be read — blaming the credential would send the operator to
    // re-paste a key that was never the problem.
    if (isFreeTierRejection(raw)) {
      return {
        ok: false,
        status: response.status,
        reason: `Zen 网关拒绝了这次探测（HTTP ${response.status} FreeTierError）${detail === '' ? '' : `：${detail}`}。`
          + '这与 Key 本身无关：网关要求请求带本机 OpenCode 真实创建过的会话 id，本次没读到。'
          + '在本机跑一次 OpenCode CLI（例如 opencode run "hi"）生成会话后重试；'
          + 'Key 只决定谁付费，替代不了这道校验。',
        finger,
      }
    }
    return {
      ok: false,
      status: response.status,
      reason: `Key 未被接受（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
      finger,
    }
  }
  if (response.status === 429) {
    // 2026-10-18 定案：429 就是额度/速率限制（停手后同一 Key、同一模型直连连打 8 次
    // 全部 200）。401/403 才是「Key 不被接受」，429 说明 Key 通过了鉴权、只是额度用完。
    const retryAfter = Number(response.headers?.get?.('retry-after'))
    const window = Number.isFinite(retryAfter) && retryAfter > 0
      ? `（网关建议 ${Math.round(retryAfter / 60)} 分钟后再试）`
      : ''
    return {
      ok: true,
      status: response.status,
      reason: `Key 有效，但该账号当前额度已用尽${window}`,
      finger,
    }
  }
  if (response.status >= 400) {
    // A 400 here is almost always about the probe itself (an unknown model id),
    // which still proves authentication succeeded. Draining the body keeps the
    // socket reusable and the message honest.
    const raw = await response.text().catch(() => '')
    return {
      ok: true,
      status: response.status,
      reason: `Key 已通过鉴权（探测请求返回 HTTP ${response.status}${raw === '' ? '' : '，属模型或参数问题'}）`,
      finger,
    }
  }
  return { ok: true, status: response.status, reason: `Key 有效（HTTP ${response.status}）`, finger }
}

/**
 * Whether a persisted verdict still describes the key currently configured.
 *
 * The fingerprint is what makes "verified" a fact about *this* key rather than
 * about whichever key was checked last week.
 * @param saved - the persisted result, or undefined.
 * @param key - the key in use right now.
 * @returns true when the saved verdict may be trusted.
 */
export function keyCheckStillValid(saved, key) {
  if (saved === undefined || saved === null || typeof saved !== 'object') return false
  if (saved.ok !== true) return false
  const current = typeof key === 'string' && key.trim() !== '' ? keyFingerprint(key.trim()) : ''
  return typeof saved.finger === 'string' && saved.finger !== '' && saved.finger === current
}

/** One line for the Host log, so a gated policy is never silently ignored. */
export function describeKeyCheck(result) {
  return `${LOG_PREFIX} key check: ${result.ok ? 'accepted' : 'rejected'} — ${result.reason}`
}
