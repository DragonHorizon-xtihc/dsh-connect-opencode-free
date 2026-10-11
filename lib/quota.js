// dsh-connect-opencode-free · free-quota accounting (Host only).
//
// OpenCode Zen's anonymous tier is rate-limited per source, and the 429 body
// says nothing about when the window reopens. Without a record of it the
// operator only sees "rate limited" and has no idea whether to wait a minute
// or go find a key — so the plugin remembers the hits, estimates the reset from
// whatever the response offers, and persists that across restarts.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { LOG_PREFIX } from './core.js'

/** Fallback reset guess when the response carries no usable `Retry-After`. */
export const DEFAULT_QUOTA_WINDOW_MS = 60_000
/** A remembered window longer than this is treated as a provider misreport, not a quota. */
const MAX_QUOTA_WINDOW_MS = 6 * 60 * 60 * 1000

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
    this.state = { hits: 0, lastHitAt: 0, resetAt: 0 }
    this.restore()
  }

  /** Read persisted state, discarding anything implausible. */
  restore() {
    const saved = readJson(this.cachePath)
    if (saved === undefined || typeof saved !== 'object') return
    const hits = Number(saved.hits)
    const lastHitAt = Number(saved.lastHitAt)
    const resetAt = Number(saved.resetAt)
    if (!Number.isFinite(hits) || !Number.isFinite(lastHitAt)) return
    this.state = {
      hits: Math.max(0, Math.floor(hits)),
      lastHitAt: lastHitAt > 0 ? lastHitAt : 0,
      resetAt: Number.isFinite(resetAt) && resetAt > 0 ? resetAt : 0,
    }
  }

  /**
   * Record a throttled request.
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
    }
    writeJson(this.cachePath, this.state)
    return this.state
  }

  /** Forget a throttled request that later succeeded, so the counter means something. */
  clear() {
    if (this.state.hits === 0) return
    this.state = { hits: 0, lastHitAt: 0, resetAt: 0 }
    writeJson(this.cachePath, this.state)
  }

  /**
   * A JSON-serializable view for the settings page.
   * @param now - epoch milliseconds.
   */
  snapshot(now) {
    const throttled = this.state.resetAt > now
    return {
      hits: this.state.hits,
      lastHitAt: this.state.lastHitAt,
      resetAt: throttled ? this.state.resetAt : 0,
      throttled,
      remainingMs: throttled ? this.state.resetAt - now : 0,
    }
  }
}

/**
 * Resolve the credential the free tier authenticates with.
 *
 * An operator who has a key gets their own quota, so an explicitly configured
 * env var always wins. Several may be listed comma-separated to spread load;
 * with none, the shared public tier is the answer and needs no key at all.
 * @param apiKeyEnv - comma-separated env var names, most preferred first.
 * @param env - the environment to read.
 * @returns `{ key, source, anonymous }`.
 */
export function resolveCredential(apiKeyEnv, env = process.env) {
  for (const name of String(apiKeyEnv ?? '').split(',').map((n) => n.trim()).filter(Boolean)) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') {
      return { key: value.trim(), source: name, anonymous: false }
    }
  }
  return { key: 'public', source: 'public', anonymous: true }
}

/** Every credential candidate, for round-robin across an operator's own keys. */
export function credentialPool(apiKeyEnv, env = process.env) {
  return String(apiKeyEnv ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map((name) => ({ name, key: env[name] }))
    .filter((entry) => typeof entry.key === 'string' && entry.key.trim() !== '')
    .map((entry) => ({ name: entry.name, key: entry.key.trim() }))
}

/**
 * One credential name's value: the Harness credential store first, then the
 * process environment.
 *
 * A key entered in the settings UI is stored by `credentials` rather than
 * exported into the environment, so an environment-only read would silently
 * miss it and the request would fall back to the shared public quota.
 * @param name - credential name, normally an environment variable name.
 * @param store - the `credentials` service, when the Host provides one.
 * @param env - environment to fall back to.
 * @returns the value, or undefined when neither source has one.
 */
export async function credentialValue(name, store, env = process.env) {
  if (store && typeof store.resolve === 'function') {
    try {
      const hit = await store.resolve(name)
      const value = hit?.value
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    } catch (error) {
      // An unreadable store must not block the environment fallback, and the
      // failing name is worth knowing when a configured key is silently unused.
      console.warn(LOG_PREFIX, `credential store could not answer for ${name}:`, error && error.message)
    }
  }
  const value = env[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The same pool, resolved name by name through the Harness credential store
 * first and the environment second.
 *
 * A key saved in the settings UI lives in the credential store, not in the
 * process environment, so an environment-only pool would silently miss it and
 * fall back to the shared public quota. Duplicated names are dropped, keeping
 * the first occurrence, so one name listed twice is still one quota.
 * @param apiKeyEnv - comma-separated credential names, most preferred first.
 * @param lookup - resolves one name to its stored value, or undefined.
 * @returns key entries in preference order, as {@link credentialPool} reports them.
 */
export async function resolveCredentialPool(apiKeyEnv, lookup) {
  const names = String(apiKeyEnv ?? '').split(',').map((name) => name.trim()).filter(Boolean)
  const pool = []
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const stored = await lookup(name)
    if (typeof stored === 'string' && stored.trim() !== '') pool.push({ name, key: stored.trim() })
  }
  return pool
}

/** Default cache location for one profile-independent plugin. */
export function defaultCachePath(dshHome, fileName) {
  return join(String(dshHome), 'cache', fileName)
}

/** Whether a path already holds a cache worth reading. */
export function cacheExists(path) {
  return existsSync(path)
}
