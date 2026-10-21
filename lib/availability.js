// dsh-connect-opencode-free · model availability ledger (host side)
//
// Zen's two catalog sources keep advertising models that no longer serve: one
// is deprecated, one answers that it does not speak this protocol, one is
// region-blocked, one fails upstream on every attempt. Selecting any of them
// yields a 400/403/410 the user can do nothing about, and the failure looks
// like a plugin bug rather than a dead model.
//
// This ledger records the failures that are permanent in character — a model
// that is deprecated, unsupported, region-blocked, or gone upstream — and
// keeps them out of the picker until a request through them succeeds again.
// Transient failures (429, timeouts, 5xx) are deliberately not recorded: a
// shared free quota exhausts constantly, and dropping a model for it would
// empty the list on a busy afternoon.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Failure kinds that mean the model will not serve again on its own. */
const TERMINAL_KINDS = new Set(['deprecated', 'unsupported', 'region', 'unavailable'])

/**
 * Classify one non-2xx Zen response.
 *
 * Zen reports permanent model problems through distinct error types, which is
 * what makes them safe to act on. Everything unrecognised is treated as
 * transient rather than risk retiring a model over a one-off failure.
 * @param status - HTTP status.
 * @param body - raw response text, which may be JSON or empty.
 * @returns a terminal kind, or `undefined` when the failure looks transient.
 */
export function classifyFailure(status, body) {
  let errorType = ''
  let message = ''
  try {
    const parsed = JSON.parse(body)
    errorType = String(parsed?.error?.type ?? parsed?.type ?? '')
    message = String(parsed?.error?.message ?? parsed?.message ?? '')
  } catch {
    /* a non-JSON error body carries no type to classify */
  }
  if (errorType === 'ModelDeprecated' || status === 410) return 'deprecated'
  if (errorType === 'ModelProtocolUnsupported') return 'unsupported'
  if (errorType === 'RegionError') return 'region'
  // "Upstream request failed" wraps the provider's own verdict. Only the
  // permanent one is retireable; its transient siblings (endpoint unavailable,
  // rate limited) must not cost the user a working model.
  if (/upstream request failed/i.test(message) && /model is unavailable/i.test(message)) {
    return 'unavailable'
  }
  return undefined
}

/**
 * Which models to keep out of the picker.
 *
 * State is written through on every change so a restart does not resurrect a
 * model that was already proven dead this morning.
 */
export class AvailabilityTracker {
  /** @param file - absolute path of the JSON ledger. */
  constructor(file) {
    this.file = file
    this.entries = this.read()
  }

  read() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {}
    } catch {
      return {}
    }
  }

  write() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify({ savedAt: Date.now(), entries: this.entries })}\n`, 'utf8')
    } catch {
      /* a ledger that cannot be written must never fail a request */
    }
  }

  /**
   * Record a terminal failure for one model.
   * @param model - exact model id.
   * @param kind - terminal failure kind.
   * @param detail - upstream message, surfaced to the settings page.
   */
  record(model, kind, detail = '') {
    if (!TERMINAL_KINDS.has(kind)) return
    const existing = this.entries[model]
    if (existing?.kind === kind && existing?.detail === detail) return
    this.entries[model] = { kind, detail: detail.slice(0, 300), at: Date.now() }
    this.write()
  }

  /** Forget a model's failures: it just served a request successfully. */
  clear(model) {
    if (this.entries[model] === undefined) return
    delete this.entries[model]
    this.write()
  }

  /** @returns false for a model with a recorded terminal failure. */
  isServable(model) {
    return this.entries[model] === undefined
  }

  /** @returns a detached map of retired models for the settings page. */
  snapshot() {
    return { ...this.entries }
  }
}
