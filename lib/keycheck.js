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
// Nothing here stores the key: what is persisted is a fingerprint, so the
// cached answer is invalidated the moment a different key is configured.

import { createHash } from 'node:crypto'

import { LOG_PREFIX, clampInt } from './core.js'

/** How much of one answer to ask for; the point is the status, not the text. */
const PROBE_MAX_TOKENS = 16
const PROBE_TIMEOUT_MS = 20_000

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
 * @param options - `baseURL`, `key`, `model` to probe with, optional `timeoutMs`.
 * @returns `{ ok, status, reason, finger }`; `ok` means the key was accepted.
 */
export async function verifyKey(options = {}) {
  const key = typeof options.key === 'string' ? options.key.trim() : ''
  const finger = key === '' ? '' : keyFingerprint(key)
  if (key === '') return { ok: false, status: 0, reason: '没有可校验的 Key', finger }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    return { ok: false, status: 0, reason: '没有可用于探测的模型', finger }
  }

  const url = `${String(options.baseURL ?? '').replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = clampInt(options.timeoutMs, 1000, 120_000, PROBE_TIMEOUT_MS)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: options.model.trim(),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? '请求超时' : (error?.message ?? String(error))
    return { ok: false, status: 0, reason: `无法连接 Zen：${message}`, finger }
  }

  // Only the authentication verdict decides. Everything else happened after
  // the key was accepted, so it is evidence the key works — not against it.
  if (response.status === 401 || response.status === 403) {
    const raw = await response.text().catch(() => '')
    const detail = raw.slice(0, 200)
    return {
      ok: false,
      status: response.status,
      reason: `Key 未被接受（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
      finger,
    }
  }
  if (response.status === 429) {
    return { ok: true, status: response.status, reason: 'Key 有效，但该账号当前额度已用尽', finger }
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
