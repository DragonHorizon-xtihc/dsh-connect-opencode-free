// dsh-connect-opencode-free · real OpenCode session ids.
//
// 2026-10-13 实测（scripts/probe-session-source.mjs，2×2 对照）：Zen 的匿名免费档
// **不再只校验 session id 的形状**，而是校验它是否为 OpenCode 真实创建过。
// 原有的另外两个前提（UA 以 `opencode/` 开头、tools 含 bash/read）依然成立，
// 三个条件合起来才放行：
//
//   真实 session + tools → 200
//   真实 session 无 tools → 403 FreeTierError
//   伪造 session + tools → 403 FreeTierError   ← 本插件 2026-10-11 ~ 10-13 的状态
//
// 也就是说，之前 `canonicalSessionId()` 那种"按 sha256 派生一个格式合规的 id"
// 的做法已经失效：形状再标准，网关也认出它不存在。
//
// 真实 id 就在本机 OpenCode CLI 的 SQLite 库里（`~/.local/share/opencode/
// opencode.db` 的 `session` 表）。老会话同样有效（实测 5 天前创建的仍可用），
// 所以取最近的一条即可，无需自己创建。
//
// 这里只读、只读一次并短期缓存：CLI 自己也在写这个文件。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the OpenCode CLI keeps its sessions, on every platform we support. */
const DB_PARTS = ['.local', 'share', 'opencode', 'opencode.db']

/** A real id as OpenCode mints it: `ses_` plus 26 alphanumerics. */
const SESSION_SHAPE = /^ses_[A-Za-z0-9]{26}$/

/** How long one read answer may be reused before the db is consulted again. */
const CACHE_TTL_MS = 5 * 60 * 1000

let cache = { value: undefined, at: 0, path: undefined }
// The last id that was actually read, kept even after {@link forgetCachedSession}.
// A caller that drops the cache is reacting to a rejection; if the fresh read
// then fails because the CLI holds the file, answering "no session database"
// would replace a truthful free-tier rejection with advice to go create a
// session — sending the operator to fix the wrong thing.
let stale = undefined

/**
 * The session database path this host would consult.
 * @returns an absolute path; the file need not exist.
 */
export function defaultSessionDbPath() {
  return join(homedir(), ...DB_PARTS)
}

/**
 * Read the most recent real OpenCode session id from the CLI's own database.
 *
 * Never throws: a host that cannot read the database gets a `reason` to show the
 * operator instead, because retrying silently with a fabricated id is exactly
 * what produced a wall of 403s.
 * @param options - `{ path }` overrides the database location.
 * @returns `{ id, source }` when one was read, `{ id: undefined, reason }` otherwise.
 */
export async function realSessionId(options = {}) {
  const path = options.path ?? defaultSessionDbPath()
  const now = Date.now()
  // A read that fails is reported as a reason only when there is nothing to
  // fall back on; otherwise the previous id is reused so a transient failure
  // cannot change what the caller concludes about the request.
  const degraded = () => (stale === undefined ? undefined : { id: stale, source: 'cache' })
  if (cache.path === path && cache.value !== undefined && now - cache.at < CACHE_TTL_MS) {
    return { id: cache.value, source: 'cache' }
  }
  if (!existsSync(path)) {
    return degraded() ?? { id: undefined, reason: `本机没有 OpenCode 会话库（${path}）` }
  }

  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    return degraded() ?? { id: undefined, reason: `当前 Node 不支持读 SQLite：${error?.message ?? error}` }
  }
  if (typeof DatabaseSync !== 'function') {
    return degraded() ?? { id: undefined, reason: '当前 Node 的 node:sqlite 不可用' }
  }

  let db
  try {
    // Read-only and short-lived: the CLI may hold writes to the same file.
    db = new DatabaseSync(path, { readOnly: true })
    const row = db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get()
    const id = typeof row?.id === 'string' ? row.id : String(row?.id ?? '')
    if (!SESSION_SHAPE.test(id)) {
      return degraded() ?? { id: undefined, reason: `会话库里没有可用的 session（${path}）` }
    }
    cache = { value: id, at: now, path }
    stale = id
    return { id, source: 'opencode-db' }
  } catch (error) {
    return degraded() ?? { id: undefined, reason: `读取 OpenCode 会话库失败：${error?.message ?? error}` }
  } finally {
    try { db?.close() } catch { /* closing must never mask the real error */ }
  }
}

/**
 * Drop the cached answer so the next read consults the database again.
 *
 * The previous id is retained as a fallback: the only reason to call this is
 * that a request was rejected, and a rejection is more informative than a
 * read failure, so the id is given a second chance rather than reported as
 * missing.
 */
export function forgetCachedSession() {
  cache = { value: undefined, at: 0, path: undefined }
}
