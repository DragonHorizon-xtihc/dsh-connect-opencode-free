// dsh-connect-opencode-free · free-quota accounting (Host only).
//
// OpenCode 客户端的免费档被限流时，429 不带「什么时候恢复」。这里把网关给的
// 等待窗口记下来并跨重启保存，设置页才有一句能照着做的话可说。
//
// 只走 bridge：额度是本机 OpenCode 客户端那一份，与任何私有 Key 无关。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Fallback reset guess when the response carries no usable `Retry-After`. */
export const DEFAULT_QUOTA_WINDOW_MS = 60_000
/**
 * A remembered window longer than this is treated as a provider misreport.
 *
 * The real free-tier reset is a daily bucket that reopens at 00:00 UTC, so a
 * refusal at 03:00Z legitimately asks for ~21 hours. The old six-hour ceiling
 * silently truncated those to a window that had already expired by the time the
 * operator read it.
 */
const MAX_QUOTA_WINDOW_MS = 36 * 60 * 60 * 1000
/**
 * How long a refusal keeps the cooldown flag set in `snapshot()`.
 *
 * A refusal is not a full quota, but re-asking immediately adds a doomed round
 * trip to each turn. Ten minutes rides out a transient blip without hiding a
 * recovery for the rest of the session.
 */
export const DEFAULT_REFUSAL_COOLDOWN_MS = 10 * 60 * 1000

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch { /* a cache that cannot be written must never fail a request */ }
}

/**
 * A reset estimate from whatever the response tells us.
 * @param response - the 429 response, when the caller has one.
 * @returns milliseconds to wait, or undefined when nothing usable was offered.
 */
export function estimateResetMs(response) {
  const header = response?.headers?.get?.('retry-after')
  if (header !== undefined && header !== null && header !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_QUOTA_WINDOW_MS, seconds * 1000)
  }
  return undefined
}

/**
 * Track anonymous-quota throttling for one plugin.
 *
 * The state is deliberately tiny — when the last 429 landed and when the window
 * is assumed to reopen — and is written on every change so a restart does not
 * reset the operator's back-of-hand knowledge.
 */
export class QuotaTracker {
  /**
   * @param cachePath - file the state survives restarts in.
   */
  constructor(cachePath) {
    this.cachePath = cachePath
    this.state = { hits: 0, lastHitAt: 0, resetAt: 0, refusedAt: 0 }
    this.restore()
  }

  /** Read persisted state, discarding anything implausible. */
  restore() {
    const saved = readJson(this.cachePath)
    if (saved === undefined || typeof saved !== 'object') return
    const hits = Number(saved.hits)
    const lastHitAt = Number(saved.lastHitAt)
    const resetAt = Number(saved.resetAt)
    const refusedAt = Number(saved.refusedAt)
    if (!Number.isFinite(hits) || !Number.isFinite(lastHitAt)) return
    this.state = {
      hits: Math.max(0, Math.floor(hits)),
      lastHitAt: lastHitAt > 0 ? lastHitAt : 0,
      resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0,
      refusedAt: Number.isFinite(refusedAt) && refusedAt > 0 ? refusedAt : 0,
    }
  }

  /**
   * Record a throttled request.
   *
   * 429 的 `retry-after` 是真实的倒计时，客户端代发同样会撞到它。记下来是为了
   * 告诉操作者什么时候回来；**不**用它决定路由——路由只有 bridge 一条。
   * @param now - epoch milliseconds, injected so tests need no clock.
   * @param response - the 429 response, when available.
   * @returns the updated state.
   */
  record(now, response) {
    const wait = estimateResetMs(response) ?? DEFAULT_QUOTA_WINDOW_MS
    this.state = {
      hits: this.state.hits + 1,
      lastHitAt: now,
      resetAt: now + Math.min(MAX_QUOTA_WINDOW_MS, wait),
      refusedAt: this.state.refusedAt,
    }
    writeJson(this.cachePath, this.state)
    return this.state
  }

  /**
   * Record a throttled request from a bare millisecond window.
   *
   * The bridge reports the quota inside the session (an `idle` message), not as
   * an HTTP response, so there is no `Response` to read a header from. Same
   * bookkeeping, one number instead of a header.
   * @param now - epoch milliseconds.
   * @param ms - how long the provider said to wait; ignored when unusable.
   * @returns the updated state.
   */
  recordWait(now, ms) {
    const value = Number(ms)
    if (!Number.isFinite(value) || value <= 0) return this.state
    this.state = {
      hits: this.state.hits + 1,
      lastHitAt: now,
      resetAt: now + Math.min(MAX_QUOTA_WINDOW_MS, value),
      refusedAt: this.state.refusedAt,
    }
    writeJson(this.cachePath, this.state)
    return this.state
  }

  /**
   * Record the client free lane refusing the caller outright.
   *
   * Distinct from {@link record}: a refusal is not a full quota, so it gets its
   * own memory and its own clock, and `snapshot()` reports it separately.
   * @param now - epoch milliseconds.
   * @returns the updated state.
   */
  refuse(now) {
    this.state = { ...this.state, refusedAt: now }
    writeJson(this.cachePath, this.state)
    return this.state
  }

  /** Forget a throttled request that later succeeded, so the counter means something. */
  clear() {
    if (this.state.hits === 0 && this.state.refusedAt === 0) return
    this.state = { hits: 0, lastHitAt: 0, resetAt: 0, refusedAt: 0 }
    writeJson(this.cachePath, this.state)
  }

  /**
   * Whether the shared free lane is expected to refuse the next request.
   *
   * Answered from memory alone, so it can only ever be a guess — and the guess
   * is deliberately optimistic: with nothing recorded the lane counts as open,
   * because using it is the point of this plugin.
   * @param now - epoch milliseconds.
   * @returns true while a rate-limit window or a refusal cooldown is running.
   */
  publicLaneClosed(now) {
    if (this.state.resetAt > now) return true
    return this.state.refusedAt > 0 && now - this.state.refusedAt < DEFAULT_REFUSAL_COOLDOWN_MS
  }

  /**
   * A JSON-serializable view for the settings page.
   * @param now - epoch milliseconds.
   */
  snapshot(now) {
    const throttled = this.state.resetAt > now
    const refused = this.state.refusedAt > 0 && now - this.state.refusedAt < DEFAULT_REFUSAL_COOLDOWN_MS
    return {
      hits: this.state.hits,
      lastHitAt: this.state.lastHitAt,
      resetAt: throttled ? this.state.resetAt : 0,
      throttled,
      remainingMs: throttled ? this.state.resetAt - now : 0,
      refused,
      refusedAt: refused ? this.state.refusedAt : 0,
      refusedRemainingMs: refused ? this.state.refusedAt + DEFAULT_REFUSAL_COOLDOWN_MS - now : 0,
      closed: throttled || refused,
    }
  }
}
