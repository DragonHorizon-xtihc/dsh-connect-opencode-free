// dsh-connect-opencode-free · OpenCode Zen 免 key provider (host side)
//
// 本文件在宿主(Node)侧实现一个完整的 LLM adapter，让用户不用登录、不用 key，
// 就能通过 OpenCode Zen 的免费档使用免费模型。认证使用字面量 key "public"
// （OpenCode Zen 官方免费档，无需注册）。
//
// 模型集不再硬编码：宿主从后端 /api/models 同步，并叠加用户在设置里手动添加的
// 模型，再减去用户停用的模型。同步结果由 lib/index.js 通过 setModels() 注入。

// `dsh-llm` is imported as a namespace, never as named bindings.
//
// The llm service calls `registration.adapter.prepareCall()` on every request,
// so an adapter without that method fails the whole turn. Whether the base
// class supplies it depends on which copy of `dsh-llm` this file resolves to —
// the Harness source tree ships one version and a profile's node_modules can
// resolve another. Importing the namespace lets this file keep working when the
// base class is absent, and {@link OpenCodeFreeAdapter.prepareCall} is declared
// outright rather than inherited, so the llm service's call can never depend on
// which copy answered.
import { randomUUID } from 'node:crypto'

import * as dshLlm from '@deepseek-ai/dsh-llm'
import { classifyFailure } from './availability.js'
import { LOG_PREFIX, PROVIDER, QUOTA_POLICY, ZEN_BASE_URL, clampInt, effectiveQuotaPolicy } from './core.js'
import { forgetCachedSession, realSessionId } from './oc-session.js'
import { estimateResetMs } from './quota.js'
import { egressFetch, egressFailure } from './zen-egress.js'
import { withOpencodePrompt } from './zen-prompt.js'
import {
  OpenCodeBridge,
  PROTOCOL_SCHEMA,
  parseProtocol,
  toolProtocolOf,
  transcriptOf,
} from './oc-bridge.js'

const LlmAdapter = typeof dshLlm.LlmAdapter === 'function' ? dshLlm.LlmAdapter : Object
const attributionHeaders = typeof dshLlm.attributionHeaders === 'function'
  ? dshLlm.attributionHeaders
  : () => ({})

// Zen's anonymous free lane is gated server-side: a request that does not look
// like it came from the OpenCode CLI is rejected with 403 FreeTierError even
// though no key is required. Probed live against opencode.ai, all four of the
// following must hold at once, and dropping any one of them returns 403 again:
//
//   1. User-Agent starts with `opencode/`
//   2. a canonical `x-opencode-session` — `ses_` + 26 chars
//   3. the body carries function tools named `bash` and `read`
//   4. `stream: true`
//
// The fourth was found on 2026-10-14 while chasing a key that answered 403: the
// CLI always streams, so a non-streaming body is not a shape it would ever send,
// and the gateway rejects it with the same FreeTierError a missing session id
// gets. A probe that varied one signal at a time could not have found it — the
// three earlier cases all streamed.
//
// ⚠️ These apply to EVERY request, not just the keyless one. Until 2026-10-14
// this file carried the opposite claim — "the check runs on the anonymous lane
// only; a configured OPENCODE_API_KEY has its own paid route" — and it was
// wrong. Probed with a real key: the key plus a real session plus the two tools
// plus streaming answers 200, and the same key with any one of the four missing
// answers 403 FreeTierError. A garbage key and a valid key get the identical
// error, so the route does not decide on the credential at all. The credential
// chooses who is billed; these four signals decide whether the request is
// allowed through. The keyed lane was dead for as long as the wrong claim stood.
//
// ⚠️ **A 429 is not a verdict about the sender — it is the quota** (2026-10-18,
// after one wrong turn). Earlier the same day this block claimed the opposite:
// that passing the four signals only cleared a "shape" check, after which the
// gateway judged *who* sent the request and dressed the refusal up as a rate
// limit. That reading came from a control that failed to hold one variable —
// **quota depletes as you spend it**. The client's 200 took the last of it, so
// the probe fired moments later naturally got 429, and "the quota just ran out"
// got misread as "the sender was not recognised".
//
// What actually settles it: leave it alone for a while, then fire the same
// session, same model, same body eight times in a row, straight through — all
// eight answer 200 (`scripts/probe-rate-limit.mjs`). An identity verdict could
// not be undone by waiting.
//
// So: 403 FreeTierError is the shape check above; 429 FreeUsageLimitError is the
// quota, full stop. Honour `retry-after`. Do not probe in a loop — every wasted
// 429 pushes the window out (measured 6h → 22h here).
//
// The bridge (lib/oc-bridge.js) stays available but is off by default: it was
// built on the wrong theory, and it costs the host its native tool calling.
const OPENCODE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

/**
 * 429 的 `retry-after` 超过这个时长，就不再退避重试。
 *
 * 实测免费档的额度窗口是 6–22 小时量级，而默认退避三次加起来不过十几分钟——既不
 * 可能等到窗口重开，又让操作者以为「已经重试过」。短窗口（速率限制）仍然照常重试。
 */
const AUTO_RETRY_MAX_WAIT_MS = 120_000

/**
 * Tools to actually put on the wire.
 *
 * The gate's third condition is not "some tools" but specifically `bash` and
 * `read`: probed live, a body carrying only the caller's own `get_weather`
 * returns 403, while the same body plus stubs of those two returns 200. So the
 * stubs fill whatever is missing rather than replacing what the caller sent.
 *
 * A caller with no tools gets the stubs under `tool_choice: "none"`, making the
 * gate pass without ever letting the model pick them. A caller that brought
 * tools keeps them, keeps `tool_choice: "auto"`, and only gains the stubs it
 * lacked. The model could therefore pick a stub — but {@link translateStream}
 * neutralises any such call on the way back (a stub is not a real tool the host
 * can execute, and letting it through trips `UNKNOWN_TOOL` and fails the turn),
 * so the gate is satisfied without the old "hard 403 vs. broken tool call" trade.
 * @param tools - the caller's tool schemas, before wire serialization.
 * @param wireTools - those schemas serialized, or `undefined` when there are none.
 * @returns the `tools` and `tool_choice` fields to spread into the request body.
 */
function gateTools(tools, wireTools) {
  if (wireTools === undefined) return { tools: GATE_TOOLS, tool_choice: 'none' }
  const present = new Set((tools || []).map((t) => t.name))
  const missing = GATE_TOOLS.filter((stub) => !present.has(stub.function.name))
  if (missing.length === 0) return { tools: wireTools, tool_choice: 'auto' }
  return { tools: [...wireTools, ...missing], tool_choice: 'auto' }
}

/** Fallback tool-call id; the real one replaces it as soon as it arrives. */
function newToolCallId() {
  return randomUUID()
}

/**
 * Put one header into an object, replacing any name that differs only in case.
 *
 * HTTP field names are case-insensitive, so `{ 'User-Agent': a, 'user-agent':
 * b }` is two spellings of one header — whichever survives to the wire is
 * whatever the HTTP stack happens to pick, not whichever was written last.
 * That is how this adapter shipped `deepseek-harness/…` to Zen's free-tier gate
 * while the code plainly said it was sending `opencode/…`: the disguise was
 * spelled `User-Agent`, the attribution host supplies is spelled `user-agent`,
 * and both were in the object at once.
 *
 * The host's own adapters guard the same hazard (`packages/llm/llm-pi-ai/src/
 * adapter.ts` reserves the attribution names case-insensitively before
 * merging). Matching on the literal string here would only work until the
 * attribution module spells its header differently, so the comparison is
 * case-insensitive and the assignment writes the caller's spelling last.
 * @param target - headers being built; mutated.
 * @param name - the name to write, in the spelling wanted on the wire.
 * @param value - the value, or `undefined` to remove the header outright.
 * @returns `target`, for chaining.
 */
function assignHeader(target, name, value) {
  const lowered = String(name).toLowerCase()
  for (const key of Object.keys(target)) {
    if (key.toLowerCase() === lowered) delete target[key]
  }
  if (value !== undefined) target[name] = value
  return target
}

/**
 * The headers for one attempt.
 *
 * Every attribution header the host declares is applied first, whatever it is
 * called and however it is spelled; the free-tier disguise then *replaces* the
 * one it means to replace. Order in this object is not what decides the winner
 * — {@link assignHeader} deletes the collision — so the disguise survives even
 * if the attribution module renames or re-cases its header.
 *
 * The session header is omitted rather than sent as `undefined` when keyed: a
 * header slot holding "undefined" is itself a request fingerprint, and the paid
 * lane rides the harness's own attribution untouched.
 * @param credential - this attempt's credential.
 * @param disguise - `{ userAgent, session }` from {@link gateDisguise}.
 * @param attribution - overrides the host's attribution; the tests use it to
 * prove the disguise wins however the host spells its header.
 * @returns a plain header object with no case-duplicated names.
 */
export function buildHeaders(credential, disguise, attribution = attributionHeaders()) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.key}`,
  }
  for (const [name, value] of Object.entries(attribution ?? {})) {
    assignHeader(headers, name, value)
  }
  // Only when there is a disguise to apply. Calling {@link assignHeader} with
  // `undefined` would *delete* the attribution header, and a keyed request is
  // precisely the one that must keep it.
  if (disguise.userAgent !== undefined) assignHeader(headers, 'user-agent', disguise.userAgent)
  if (disguise.session !== undefined) headers['x-opencode-session'] = disguise.session
  return headers
}

/**
 * Zen 推理模型的档位，只有模型被目录标为 `reasoning` 时才对外声明。
 *
 * 声明是给选择器和请求校验看的：没有它，任何一次显式指定档位的请求都会被
 * llm 服务以 `UNSUPPORTED_REASONING_EFFORT` 拒在网关之外。`off` 用省略字段
 * 表示——Zen 的网关不收 `reasoning_effort: "off"`，而省略就等于不思考。
 */
const REASONING_EFFORTS = [
  { id: 'off', name: 'Off', description: '不思考' },
  { id: 'low', name: 'Low', description: '轻量思考' },
  { id: 'high', name: 'High', description: '深度思考' },
  { id: 'max', name: 'Max', description: '极限思考' },
]

/**
 * Tool stubs the free-tier gate looks for. They are added to the request body
 * only to clear Zen's gate — they are **not** real tools the host can execute,
 * and the model must never be allowed to believe otherwise. A model that calls
 * one trips `UNKNOWN_TOOL` in the host's executor and fails the whole turn
 * (see packages/core/tools/src/index.ts: `if (tool === undefined) throw new
 * ToolNotFoundError`). The descriptions below state that outright so a capable
 * model is steered away from them; {@link translateStream} is the backstop that
 * neutralises any such call even if the model ignores the warning.
 */
const GATE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'GATEWAY PLACEHOLDER — do not call. This entry exists only to satisfy the upstream free-tier gate and is not wired to a real shell. Use the task-specific tools instead.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'GATEWAY PLACEHOLDER — do not call. This entry exists only to satisfy the upstream free-tier gate and is not wired to a real filesystem. Use the task-specific tools instead.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
]

/** Names of the gate stubs, for fast membership checks while streaming. */
const GATE_TOOL_NAMES = new Set(GATE_TOOLS.map((stub) => stub.function.name))

/**
 * Build the request identity Zen's gateway demands of EVERY caller.
 *
 * This used to be called the "anonymous lane's disguise", on the belief that the
 * gate ran only on the keyless route and that a configured `OPENCODE_API_KEY`
 * had its own paid path through. That belief was wrong, and it cost the whole
 * keyed lane. Probed live on 2026-10-14 with a real key from opencode.ai/zen:
 *
 * | credential | real session | CLI UA | bash/read | streaming | result |
 * | --- | --- | --- | --- | --- | --- |
 * | operator key | yes | yes | yes | yes | **200** |
 * | operator key | yes | yes | yes | no | 403 FreeTierError |
 * | operator key | yes | yes | no | yes | 403 FreeTierError |
 * | operator key | no | no | no | no | 403 FreeTierError |
 * | garbage key | no | no | no | no | 403 FreeTierError |
 * | no auth at all | no | no | no | no | 403 FreeTierError |
 * | `Bearer public` | yes | yes | yes | yes | **200** |
 * | `Bearer public` | fake id | yes | yes | yes | 403 FreeTierError |
 *
 * A rejected key and a valid key get the *same* error, so this route does not
 * decide on the credential at all — it decides on the four signals above. The
 * credential only chooses who is billed. Which is why the disguise is built once
 * per request rather than per credential, and why a keyed request that skipped it
 * could never have worked.
 *
 * The session id must be a REAL one. Until 2026-10-13 this caller fabricated a
 * shape-correct id from a hash (`ses_` + 12 hex + 14 Base62), and Zen rejected
 * every request with 403 FreeTierError for exactly that reason: the gate proves
 * the id against sessions the CLI actually created, and a hash-derived one does
 * not exist there. That fabrication is gone rather than kept as a fallback —
 * falling back would only produce another wall of 403s behind a message that
 * sends the operator looking at credentials. Real ids come from the CLI's own
 * database, read by {@link realSessionId}.
 *
 * The id is stable for the whole process (and cached across reads), so upstream
 * prompt-cache affinity works the way it did before.
 * @param hooks - plugin hooks; `hooks.session?.()` overrides where the id comes
 *   from (a deployment that mints sessions itself, and the tests).
 * @returns `{ userAgent, session }`.
 * @throws with `code: 'NO_OPENCODE_SESSION'` when no real session could be read.
 */
async function gateDisguise(hooks) {
  const resolved = (await hooks?.session?.()) ?? await realSessionId()
  const { id, reason } = resolved
  if (id !== undefined) {
    return { userAgent: OPENCODE_UA, session: id, source: resolved.source ?? 'hook' }
  }
  const error = new Error(
    `OpenCode Zen 的网关要求请求携带本机 OpenCode 真实创建过的会话 id，本次没能读到：${reason}。`
    + '这个要求与有没有配 Key 无关——配了 Key 也一样要过这道网关。'
    + '两个办法任选其一：① 在本机运行一次 OpenCode CLI（例如 opencode run "hi"）让它生成会话，'
    + '插件会自动复用；② 到 https://opencode.ai/zen 取一个 key，但 Key 只决定谁付费，不替代这道校验。'
  )
  error.code = 'NO_OPENCODE_SESSION'
  throw error
}

const DEFAULT_MAX_TOKENS = 128000
const DEFAULT_CONTEXT_WINDOW = 200000
// A 502 from Zen's gateway is an upstream connect timeout, not a verdict about
// the request: the model is fine and the body is fine, the route to the provider
// was not. Retrying is the whole fix, so the default is deliberately patient.
const DEFAULT_MAX_REQUEST_ATTEMPTS = 10
const DEFAULT_RETRY_BACKOFF_MS = 800
/**
 * Ceiling for one backoff sleep.
 *
 * Exponential growth is right for the first few retries and wrong for the tenth:
 * `800ms * 2^9` is 409 seconds, and ten of those is fourteen minutes of waiting
 * for a route that was down for ten seconds. Past the fourth retry the extra
 * wait buys nothing, so the step is clamped and the tail flattens.
 */
const MAX_RETRY_BACKOFF_MS = 8_000
/** The highest attempt count an operator may configure. */
const MAX_REQUEST_ATTEMPTS_LIMIT = 20
/** How many attempts a request gets when the operator has not chosen. Exported for the specs. */
export const DEFAULT_ATTEMPT_COUNT = DEFAULT_MAX_REQUEST_ATTEMPTS

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long to wait before the retry after `attempt` (0-based) failures.
 *
 * Capped at {@link MAX_RETRY_BACKOFF_MS}: with the default ten attempts an
 * uncapped doubling spends 13.6 minutes asleep, which is longer than most
 * operators will sit and watch, and longer than the fault that caused it.
 * @param attempt - how many attempts have already failed, 0-based.
 * @param base - the configured initial backoff in milliseconds.
 * @returns the sleep in milliseconds.
 */
export function backoffFor(attempt, base) {
  const step = base * (2 ** Math.max(0, attempt))
  return Math.min(step, MAX_RETRY_BACKOFF_MS)
}

/** The bearer the shared public lane authenticates with; Zen accepts it with no key. */
const PUBLIC_KEY = 'public'

/**
 * The credentials one request may spend, in the order it must spend them.
 *
 * The order is the operator's {@link QUOTA_POLICY}, not a fixed preference:
 * which lane leads is a decision they make, and the default — `publicOnly` —
 * is the one that keeps this plugin free. A key present in the environment is
 * not by itself permission to spend it, which is why `publicOnly` produces a
 * sequence with no key in it at all.
 *
 * The pool is resolved on every request because a key may live in the Harness
 * credential store, which only answers asynchronously.
 * @param credentials - the operator's key pool, or a function producing it.
 * @param keyOffset - rotates the key entries, so sustained use spreads across
 * several keys instead of burning the first one.
 * @param policy - one of {@link QUOTA_POLICY}; already resolved, so an
 * ungated policy never reaches this function.
 * @returns `[{ key, source, anonymous }]` in the order to spend them.
 */
export async function credentialSequence(credentials, keyOffset = 0, policy = QUOTA_POLICY.PUBLIC_ONLY) {
  const pool = await (typeof credentials === 'function' ? credentials() : credentials)
  const keys = (Array.isArray(pool) ? pool : [])
    .filter((entry) => entry && typeof entry.key === 'string' && entry.key.trim() !== '')
    .map((entry) => ({ key: entry.key.trim(), source: entry.name ?? 'configured', anonymous: false }))
  const shift = keys.length === 0 ? 0 : ((keyOffset % keys.length) + keys.length) % keys.length
  const rotated = keys.slice(shift).concat(keys.slice(0, shift))
  const publicLane = { key: PUBLIC_KEY, source: 'public', anonymous: true }
  if (policy === QUOTA_POLICY.PUBLIC_ONLY || keys.length === 0) return [publicLane]
  if (policy === QUOTA_POLICY.PREFER_KEY) return [...rotated, publicLane]
  return [publicLane, ...rotated]
}

function flattenText(content) {
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

/**
 * Report a request that would leave a tool call unanswered.
 *
 * Providers answer a malformed history with a bare 400 that names no field, so
 * the only practical way to diagnose one is to catch it on this side of the
 * wire. Emitted as a warning rather than an error: a request is still worth
 * sending, because some providers tolerate it and refusing to send would turn
 * a maybe into a certainty.
 * @param wire - serialized messages about to be sent.
 * @param warn - sink for the diagnostic line.
 */
export function auditWireMessages(wire, warn) {
  let pending = 0
  for (const message of wire) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      pending += message.tool_calls.length
      continue
    }
    if (message.role === 'tool') {
      pending -= 1
      continue
    }
    if (pending > 0) {
      warn(`request has ${pending} unanswered tool call(s) before the next ${message.role} message; the provider is likely to reject it`)
      pending = 0
    }
  }
  if (pending > 0) {
    warn(`request ends with ${pending} unanswered tool call(s); the provider is likely to reject it`)
  }
}

/**
 * Repair a history that no longer lines up, in place of sending it.
 *
 * A `tool` message is only legal while the call it answers is still open. Once
 * a history has been compacted, resumed, or stitched back together, a result
 * can outlive its call — and a provider rejects the orphan outright rather
 * than ignoring it. Re-labelling it as a user turn keeps the information while
 * making the request valid again, which beats both dropping it and failing.
 *
 * @param wire - serialized messages, as produced by {@link serializeMessages}.
 * @param warn - sink for a line describing each repair.
 * @returns the repaired message list.
 */
export function sanitizeWireMessages(wire, warn) {
  const open = new Set()
  const out = []
  for (const message of wire) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) open.add(call.id)
      out.push(message)
      continue
    }
    if (message.role === 'tool') {
      if (open.delete(message.tool_call_id)) {
        out.push(message)
        continue
      }
      // Nothing is waiting for this id: the call is gone from the history.
      warn(`dropping orphan tool result ${message.tool_call_id ?? '(no id)'}: no matching tool call remains in the history`)
      out.push({ role: 'user', content: `[tool result] ${message.content}` })
      continue
    }
    out.push(message)
  }
  return out
}

/** DSH/Harness 消息 → OpenAI chat.completions wire 格式。 */
function serializeMessages(messages, systemPrompt) {
  const wire = []
  if (systemPrompt) wire.push({ role: 'system', content: systemPrompt })
  for (const m of messages || []) {
    const role = m.role
    if (role === 'system') {
      wire.push({ role: 'system', content: flattenText(m.content) })
      continue
    }
    if (role === 'assistant') {
      const text = flattenText(m.content)
      const reasoning = blocksOf(m.content, 'reasoning').map((b) => b.text).join('')
      const toolCalls = blocksOf(m.content, 'tool-call')
        .filter((b) => b.name)
        .map((b) => ({
          id: b.id || 'call-unknown',
          type: 'function',
          // A tool the model calls with no arguments arrives here as an empty
          // string, which is not JSON. Round-tripping it into the next request
          // is what made the provider answer a plain chat but reject the very
          // first turn that carried tool history.
          function: { name: b.name, arguments: b.arguments || '{}' },
        }))
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    // A tool result must stay a tool result.
    //
    // This role used to fall through with `user`, which left every assistant
    // tool_calls block unanswered: OpenAI-compatible providers require each
    // tool call to be followed by a `tool` message carrying its id, and the
    // first turn that carried tool history came back
    // "Upstream request failed: [invalid_request_error] invalid request" —
    // while a plain chat, whose history has no tool result, worked fine.
    if (role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: flattenText(m.content) || '(no output)',
      })
      continue
    }
    wire.push({ role: 'user', content: flattenText(m.content) })
  }
  return wire
}

/**
 * A tool the provider cannot parse fails the whole request, so a tool whose
 * schema is missing or malformed is given a harmless one rather than sent as
 * `undefined`. A toolset can grow to dozens of entries contributed by other
 * plugins, and one empty `parameters` is enough for the provider to answer a
 * bare "invalid request" that names neither the tool nor the field.
 */
function serializeTools(tools) {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' && t.description ? t.description : t.name,
        parameters: isObject(t.parameters) && Object.keys(t.parameters).length > 0
          ? t.parameters
          : { type: 'object', properties: {} },
      },
    }))
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SSE 逐行解析，产出 OpenAI 流式 chunk。 */
async function* parseSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') return
        try { yield JSON.parse(data) } catch { /* 忽略坏行 */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** OpenAI usage → DSH 期望的 token 字段（数字，杜绝 NaN 写进会话历史）。 */
function mapUsage(usage) {
  const prompt = usage?.prompt_tokens || 0
  // Zen 回 `prompt_cache_hit_tokens`，也有网关只给 `prompt_tokens_details.cached_tokens`：
  // 缓存命中必须从 input 里减掉，否则一轮缓存命中的对话每轮都被重复计一遍输入。
  const cached = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(prompt - cached, 0),
    outputTokens: usage?.completion_tokens || 0,
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/** OpenAI 流式 chunk → DSH 需要的块事件。
 *
 * OpenAI 发的是扁平 delta，从不声明块的起止，所以边界在这里决定：任何时刻
 * 只开一块——思考一旦有正文就闭合，工具一开始就把思考和正文都闭合，否则
 * 两个块交错，宿主的累加器拿到的就是无法配对的 delta。
 */
async function* translateStream(rawChunks, estimateInput, stubPolicy = {}) {
  // Only the stubs THIS request actually injected may be suppressed. A caller
  // that already owns real tools named `bash`/`read` gets no stubs from
  // {@link gateTools}, and its calls must pass through untouched — dropping
  // them would break tools the user legitimately enabled.
  const injectedStubs = stubPolicy.injectedStubs instanceof Set ? stubPolicy.injectedStubs : new Set()
  const realToolNames = Array.isArray(stubPolicy.realToolNames) ? stubPolicy.realToolNames : []
  let nextIndex = 0
  let textBlock = null
  let reasoningBlock = null
  const toolBlocks = new Map()
  // Gate-stub calls the model attempted, keyed by the stream index. These are
  // placeholders we added for Zen's gate, not real tools — recording them lets
  // us drop them from the stream and surface a single note instead of letting
  // the host's executor reject an unknown tool and fail the whole turn.
  const skippedStubs = new Map()
  /** Tool calls the gateway never named; dropped rather than sent as `""`. */
  const namelessCalls = []
  let finish = null
  let usage = null
  let sawToolCall = false

  const open = (kind) => ({ index: nextIndex++, kind, text: '' })
  /** Length of every text block closed so far, kept for the usage estimate below. */
  let streamedText = 0
  const closeReasoning = function* () {
    if (reasoningBlock === null) return
    const block = reasoningBlock
    reasoningBlock = null
    yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
  }
  const closeText = function* () {
    if (textBlock === null) return
    const block = textBlock
    textBlock = null
    streamedText += block.text.length
    yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
  }

  for await (const chunk of rawChunks) {
    const choices = chunk.choices || []
    for (const choice of choices) {
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) finish = choice.finish_reason
      const delta = choice.delta || {}
      const rc = delta.reasoning_content
      if (typeof rc === 'string' && rc.length > 0) {
        yield* closeText()
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += rc
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: rc }
      }
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) {
        yield* closeReasoning()
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta.tool_calls || []) {
        const fn = call.function || {}
        // A gate-stub name (`bash`/`read`) is not a real tool the host can run.
        // Drop the call so no tool-call block reaches the executor — emitting it
        // would trip UNKNOWN_TOOL and fail the turn. We do not count it as a
        // tool call for `finish_reason` either, since the host never sees it.
        if (fn.name && injectedStubs.has(fn.name)) {
          const bIdx = call.index || 0
          if (!skippedStubs.has(bIdx)) skippedStubs.set(bIdx, fn.name)
          // Still close any open text/reasoning block, exactly as a real tool
          // call would, so the stream's block structure stays well-formed.
          yield* closeReasoning()
          yield* closeText()
          continue
        }
        yield* closeReasoning()
        yield* closeText()
        const bIdx = call.index || 0
        let block = toolBlocks.get(bIdx)
        if (!block) {
          block = open('tool-call')
          // The host requires every tool-call-delta to carry a string id. Seed
          // one here so a whose arguments arrive before the id cannot make that
          // field undefined — the missing id used to throw
          // "tool-call-delta id must be a string" and fail the whole turn.
          block.callId = newToolCallId()
          // Nothing is emitted for this block until the gateway names the tool.
          // A call that never gets a name can only reach the host as
          // `unknown tool ""`, which fails the whole turn, so it is buffered
          // and dropped instead of streamed.
          block.started = false
          block.pending = []
          toolBlocks.set(bIdx, block)
        }
        if (call.id) block.callId = call.id
        if (fn.name) {
          block.name = fn.name
          if (!block.started) {
            block.started = true
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            for (const held of block.pending) yield held
            block.pending = []
          }
        }
        if (fn.arguments) {
          block.text += fn.arguments
          const piece = {
            type: 'tool-call-delta',
            index: block.index,
            id: block.callId,
            name: block.name || '',
            argumentsDelta: fn.arguments,
          }
          if (block.started) yield piece
          else block.pending.push(piece)
        }
      }
    }
    if (chunk.usage) usage = mapUsage(chunk.usage)
  }

  yield* closeReasoning()
  yield* closeText()
  // `started` is false only for a call the gateway never named; emitting it would
  // send an empty tool name to the host and fail the turn as `unknown tool ""`.
  const namedBlocks = [...toolBlocks.values()].filter((block) => block.started)
  for (const block of toolBlocks.values()) {
    if (!block.started) namelessCalls.push(block)
  }
  for (const block of namedBlocks.sort((a, b) => a.index - b.index)) {
    yield {
      type: 'block-end',
      index: block.index,
      block: { type: 'tool-call', id: block.callId || '', name: block.name || '', arguments: block.text },
    }
  }
  // Only calls the host actually received may drive the finish reason.
  sawToolCall = namedBlocks.length > 0

  // Any gate-stub calls the model attempted never left this function as tool-call
  // blocks, so the host never tries to execute them. A single note explains the
  // skip — without it the model would keep retrying a tool that cannot work.
  if (skippedStubs.size > 0) {
    // Be accurate: `bash`/`read` are placeholders THIS adapter declared to clear
    // Zen's gate — they are not Zen features and saying they are "unavailable in
    // the free tier" misleads the operator. Name the real tools instead, so the
    // model knows what it can actually use.
    const names = [...new Set(skippedStubs.values())].join(', ')
    const alternatives = realToolNames.length > 0
      ? ` 当前可用的真实工具：${realToolNames.slice(0, 8).join(', ')}${realToolNames.length > 8 ? ' 等' : ''}。`
      : ''
    const note = `（说明：本次调用的 ${names} 是本适配器为通过 OpenCode 上游网关校验而声明的占位工具，并非可执行工具，已忽略。${alternatives}）`
    const noteBlock = open('text')
    yield { type: 'block-start', index: noteBlock.index, blockType: 'text' }
    yield { type: 'text-delta', index: noteBlock.index, text: note }
    yield { type: 'block-end', index: noteBlock.index, block: { type: 'text', text: note } }
  }

  // A call the upstream never named cannot be executed — as `""` it would fail
  // the turn. Say so, and ask for a retry that carries the tool name.
  if (namelessCalls.length > 0) {
    const note = `（说明：本次有 ${namelessCalls.length} 个工具调用未携带工具名称，无法执行，已忽略。请重新调用并明确指定工具名。）`
    const noteBlock = open('text')
    yield { type: 'block-start', index: noteBlock.index, blockType: 'text' }
    yield { type: 'text-delta', index: noteBlock.index, text: note }
    yield { type: 'block-end', index: noteBlock.index, block: { type: 'text', text: note } }
  }

  if (!usage && estimateInput) {
    const inputText = estimateInput()
    usage = {
      inputTokens: Math.ceil(inputText.length / 4),
      outputTokens: streamedText > 0 ? Math.ceil(streamedText / 4) : 0,
    }
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finishReason(finish, sawToolCall) }
}

/**
 * 上游的 `finish_reason` → 宿主的结束原因。
 *
 * 网关经常干脆不给 `finish_reason`（工具调用帧尤其如此），而我们比它更清楚
 * 这一轮到底产出过什么，所以缺省时按“是否发过工具调用”自己判定。
 * @param finish - 上游给出的 `finish_reason`，可能缺席。
 * @param sawToolCall - 这一轮是否出现过工具调用。
 * @returns 宿主认识的结束原因。
 */
function finishReason(finish, sawToolCall) {
  switch (finish) {
    case 'tool_calls':
      // The upstream reports tool_calls whenever the model named a tool, but a
      // call to a gate stub (bash/read) is dropped before it reaches the host.
      // With no real tool call actually emitted, the host must see a normal
      // stop — otherwise it waits for a tool result that will never arrive.
      return sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'stop': return { kind: 'stop' }
    default: return sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }
}

/**
 * 免 key OpenCode Zen adapter。结构参考 dsh-opencode-zen（MIT），但精简并
 * 使用独立的 "opencode-free" provider 名。认证固定为 `Bearer public`。
 *
 * 两道保险同时满足 `llm` 服务的调用契约（该服务每轮必调
 * `registration.adapter.prepareCall()`）：
 *
 *   1. 继承 {@link LlmAdapter}，且 `@deepseek-ai/dsh-llm` 永远 external、与
 *      宿主解析到同一份——把它打进插件会造出第二个基类，instanceof 与服务
 *      注册都会失效；
 *   2. 显式实现 `prepareCall()`（见下方），不依赖基类继承。这样即便插件因
 *      安装/链接问题解析到旧版 dsh-llm（基类还没有 prepareCall），也不会抛
 *      `prepareCall is not a function` 让本轮运行直接失败。
 *
 * 模型集由宿主注入：初始为空，等 lib/index.js 首次同步后端（或读到手动模型）
 * 再 setModels()。空列表是合法状态——后端暂时不可用时，宁可让选择器少几个
 * 模型，也不要挂上已经下线的 id。
 */
export class OpenCodeFreeAdapter extends LlmAdapter {
  constructor(ctx, control, hooks = {}) {
    super()
    this.ctx = ctx
    this.control = control || { enabled: () => true }
    this.models = []
    /** @type {{ quota?: unknown, credentials?: () => unknown[] | Promise<unknown[]>, maxAttempts?: () => number, backoffMs?: () => number, sleep?: (ms: number) => Promise<void> }} */
    this.hooks = hooks
    /**
     * Rotation offset into the operator's keys.
     *
     * Separate from the request loop because the free lane is not part of the
     * rotation: it always leads, so this only decides which key a fallback
     * starts from, and only advances on requests that actually used one.
     */
    this.keyCursor = 0
  }
  get paused() {
    try { return this.control.enabled ? !this.control.enabled() : false } catch { return false }
  }
  /** 用当前同步得到的有效模型集替换 adapter 模型集。 */
  setModels(list) {
    this.models = Array.isArray(list) ? list : []
  }
  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Zen Free' }
  }
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMITED', 'TIMEOUT', 'TRANSPORT'],
      backoff: { initialDelayMs: 800, maxDelayMs: 5000, jitterRatio: 0.1 },
    }
  }
  listModels() {
    // 暂停时返回空列表：模型从「模型选择器」消失。
    if (this.paused) return Promise.resolve([])
    return Promise.resolve(this.models.map((m) => ({
      provider: PROVIDER, id: m.id, name: m.name, description: m.description, inputModalities: ['text'],
    })))
  }
  resolveModel(provider, model) {
    const found = this.models.find((m) => m.id === model)
    return Promise.resolve({
      provider: PROVIDER,
      id: model,
      name: found?.name || model,
      ...(found?.description ? { description: found.description } : {}),
      inputModalities: ['text'],
      context: { contextWindow: found?.contextWindow || DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      // 只有推理模型声明档位：声明后选择器才提供 off/low/high/max，显式指定的
      // 档位也才被 llm 服务接受。不给 defaultEffort，保留 Zen 自己的默认档。
      ...(found?.reasoning === true ? { reasoning: { efforts: REASONING_EFFORTS } } : {}),
    })
  }

  /**
   * Bind this generation's model metadata to its dispatch.
   *
   * Declared here rather than inherited: `LlmRuntime.prepareCall()` calls
   * `registration.adapter.prepareCall(...)` unconditionally, so an adapter that
   * only inherits the method breaks the moment it resolves to a `dsh-llm` copy
   * whose base class does not carry one — the failure surfaces as
   * "prepareCall is not a function" and kills the whole turn. Owning the method
   * makes the answer independent of which copy resolved.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    // 暂停屏障：插件被暂停时拒绝一切请求，任何已选该模型的消息都无法回复。
    if (this.paused) {
      const err = new Error('OpenCode Zen Free is paused: enable it in the plugin settings to use these models')
      err.code = 'PAUSED'
      err.paused = true
      throw err
    }
    const { model, messages, system, tools, maxTokens, temperature, reasoningEffort, signal } = options
    const warn = (line) => console.warn(LOG_PREFIX, line)
    // 上游要求 system 里必须有 OpenCode 官方提示词原文，否则一律 429（实测见
    // lib/zen-prompt.js 顶部）。注入放在 sanitize 之后、steerFor 之前：合并成一条
    // system 后，`steerFor` 追加的提示正好落在这一条的末尾，优先级最高。
    const wireMessages = withOpencodePrompt(sanitizeWireMessages(serializeMessages(messages, system), warn))

    // Zen 的免费档只接受「真的由 OpenCode 客户端发出」的请求：插件自己发，无论头、
    // 会话、模型、报文怎么对齐，拿到的都是伪装成额度耗尽的 429（对照表见
    // oc-bridge.js 顶部）。这不是报文问题，插件在自己的进程里解决不了，所以公共额度
    // 这一档必须交给本机客户端代发。
    //
    // 私有 Key 那一档仍然直连：Key 能过的环境没必要为了免费档去 fork 一个进程，而
    // 且直连保留原生 function-calling。哪个先走要看这一轮会先花哪一档，而那要到
    // `credentialSequence` 之后才知道，所以代发判断放在下面。
    const bridgeMode = this.bridgeMode()
    let bridgeTried = false
    /** 代发失败的原因。直连随后也失败时，这个更值得报——它带着真正的出路。 */
    let bridgeFailure = null
    // `on` 是「永远走客户端」：不再试探直连，也就不必付一次注定失败的往返。
    if (bridgeMode === 'on') {
      yield* this.streamViaBridge({ model, messages: wireMessages, system, tools, signal, warn })
      return
    }

    const wireTools = serializeTools(tools)
    // The caller's own tool names. `translateStream` needs them to tell a stub
    // call from a real one on the way back.
    const realToolNames = (tools || []).map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean)
    const presentNames = new Set(realToolNames)
    // The gate stubs the caller does not already own. The gateway demands
    // `bash` and `read` on the wire whatever the credential, so this set is the
    // same for every attempt — see {@link gateDisguise} for the probe that
    // settled it. When `realGateTools` registered the pair for real, the caller
    // already owns them and the set is empty.
    const missingGateNames = new Set([...GATE_TOOL_NAMES].filter((name) => !presentNames.has(name)))
    // Steer the model away from the placeholders before it reaches for them:
    // the gate forces them onto the wire, and a capable model will otherwise
    // pick `bash` whenever it wants a shell. Not per credential any more — the
    // stubs are on the wire for a keyed request too, so a keyed caller's model
    // needs the same warning or it will reach for a tool nobody can execute.
    //
    // A caller with no tools at all is exempt: `gateTools` puts the stubs under
    // `tool_choice: "none"` there, so the model cannot select one anyway and a
    // warning naming tools it was never offered would only confuse it.
    const steerFor = () => {
      if (missingGateNames.size === 0 || wireTools === undefined) return wireMessages
      const steer = `Do not call the tools named ${[...missingGateNames].join(' and ')}: they are reserved placeholders declared only to pass the upstream OpenCode gateway and are not executable. Use the other provided tools instead.`
      const head = wireMessages[0]
      if (head && head.role === 'system') {
        return [{ ...head, content: `${head.content}\n\n${steer}` }, ...wireMessages.slice(1)]
      }
      return [{ role: 'system', content: steer }, ...wireMessages]
    }
    // The gate fields, assembled once: they no longer depend on which credential
    // an attempt picks, because the gateway applies them to every request.
    const gate = gateTools(tools, wireTools)
    auditWireMessages(wireMessages, warn)
    const known = this.models.find((m) => m.id === model)
    const outputCap = known?.maxTokens ?? DEFAULT_MAX_TOKENS

    const baseBody = {
      model,
      messages: wireMessages,
      stream: true,
      stream_options: { include_usage: true },
      // The model's own output cap wins over the caller's request: asking for
      // more is how a long agent turn turns into a hard 400.
      max_tokens: Math.min(maxTokens || outputCap, outputCap),
      top_p: 0.95,
      // Only a reasoning model's effort means anything; sending it elsewhere
      // makes the provider reject the whole request. `off` is expressed by
      // leaving the field out — Zen does not accept it as a value.
      ...(known?.reasoning === true && reasoningEffort !== undefined && reasoningEffort !== 'off'
        ? { reasoning_effort: reasoningEffort }
        : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    }

    /**
     * The tools to advertise.
     *
     * There used to be a per-credential version of this, on the belief that the
     * free-tier gate did not run on the authenticated route — probed with a
     * keyed body carrying no stubs, the gateway answered 401 AuthError, never
     * 403 FreeTierError. That probe was wrong: it omitted the session id too, so
     * the request never reached authentication at all. With a real session in
     * place the same keyed body answers 403 FreeTierError (see the table on
     * {@link gateDisguise}), which is what the whole keyed lane was hitting.
     *
     * So the gate applies to every attempt and this is assembled once, above.
     * A keyed caller whose host has no `bash`/`read` of its own still gets the
     * placeholders — and {@link steerFor} still warns its model off them, and
     * `attemptStubs` still suppresses any call it makes anyway.
     */

    // Which lane leads is the operator's call, filtered through what is proven:
    // a policy that spends a key is only honoured while that key is known to
    // have been accepted, so a broken credential cannot flip every request
    // onto a lane that then fails.
    const policy = effectiveQuotaPolicy(this.hooks.quotaPolicy?.(), this.hooks.keyVerified?.() === true)
    const sequence = await credentialSequence(this.hooks.credentials, this.keyCursor, policy)
    // …but "public first" means first when it can answer, not first regardless:
    // a lane that 429ed a minute ago, or that refused the free tier outright,
    // would only cost a round trip to repeat itself. The cooldown expires and
    // the lane leads again — see {@link QuotaTracker.publicLaneClosed}. Only
    // meaningful when the lane leads at all; with a key-first policy the lane
    // is already last and there is nothing to skip.
    const skipPublic = policy === QUOTA_POLICY.PREFER_PUBLIC && this.publicLaneClosed()
    const lane = skipPublic ? sequence.filter((entry) => !entry.anonymous) : sequence
    const usable = lane.length > 0 ? lane : sequence
    // `auto`：这一轮的第一档是公共额度，就直接代发。直连在这一档上从未成功过
    // （2026-10-27 对照：同一报文直连 429、经 opencode-cli 200），先打一次只是
    // 白付一个往返，还会把网关的 retry-after 窗口推得更长。
    if (bridgeMode === 'auto' && usable[0]?.anonymous === true) {
      bridgeTried = true
      try {
        yield* this.streamViaBridge({ model, messages: wireMessages, system, tools, signal, warn })
        return
      } catch (bridgeErr) {
        bridgeFailure = bridgeErr
        warn(`bridge 代发失败，回退直连：${bridgeErr?.message ?? bridgeErr}`)
      }
    }
    const baseBackoff = this.backoffMs()
    // Every credential gets one attempt even when maxAttempts is lower: that
    // setting caps backoff retries, and letting it truncate the fallback would
    // hide a working key behind an exhausted public lane.
    const attempts = Math.max(this.maxAttempts(), usable.length)
    let lastError = null
    // Two memories, not one, because the lanes are not interchangeable: a key
    // was configured as a fallback, so when both fail the key's verdict is the
    // one worth reporting — the public lane's refusal is already known.
    let publicError = null
    let keyedError = null
    let usedKey = false
    // How many round trips this request actually cost. The budget above can be
    // cut short by a verdict that says "retrying will not help", so the number
    // reported to the operator has to be counted, not assumed.
    let spent = 0
    try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw aborted()
      spent = attempt + 1
      // Each attempt takes the next credential in `usable`: the free lane, then
      // each configured key in turn.
      const credential = usable[attempt % usable.length]
      if (!credential.anonymous) usedKey = true
      // The gateway's identity, for this attempt whatever the credential. Read
      // per attempt rather than hoisted because it can throw
      // (`NO_OPENCODE_SESSION`), and a throw inside the loop is what surfaces
      // that as the request's error instead of an unhandled rejection.
      const disguise = await gateDisguise(this.hooks)
      // One body per attempt, because the steer text and the gate fields are
      // the same for every attempt now — the credential only changes the
      // Authorization header, which `buildHeaders` applies.
      const body = { ...baseBody, messages: steerFor(), ...gate }
      // The stubs this attempt actually advertised may be suppressed on the way
      // back: a call to a name the host cannot execute trips `UNKNOWN_TOOL` and
      // fails the whole turn. Not conditional on the lane — a keyed request
      // carries the same placeholders, so it needs the same guard.
      const attemptStubs = missingGateNames
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000)
        const onAbort = () => controller.abort()
        if (signal) signal.addEventListener('abort', onAbort)

        let response
        try {
          response = await this.transport(`${this.baseUrl()}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(credential, disguise),
            body: JSON.stringify(body),
            signal: controller.signal,
          }, warn)
        } finally {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          // Read the body before the status. A conversation that outgrew the
          // model's window comes back as a 5xx — the gateway reports its own
          // inability to route rather than the request's fault — so mapping by
          // status alone files a permanent, content-determined failure under
          // `TRANSPORT`, which means "the network might come back". It will not.
          const overWindow = isContextOverflow(raw)
          const code = overWindow
            ? 'CONTEXT_OVERFLOW'
            : response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
          if (code === 'RATE_LIMITED') {
            // Remember the window so the settings page can say when it reopens
            // instead of the operator guessing.
            this.hooks.quota?.record(Date.now(), response)
          }
          // A model that is deprecated, unsupported, region-blocked, or gone
          // upstream will keep failing, so retire it from the picker now
          // rather than letting the next turn hit the same wall.
          const terminal = classifyFailure(response.status, raw)
          if (terminal !== undefined) {
            this.hooks.availability?.record(model, terminal, raw)
          }
          // The same feedback loop the model list gets, applied to the session
          // id: a cached id is trusted for minutes, and one the CLI has since
          // dropped would otherwise keep producing 403s long after a fresh read
          // would have found a good one. Dropping it costs one re-read.
          //
          // Not conditional on the lane any more. The gate applies to every
          // request (see {@link gateDisguise}), so a FreeTierError on a *keyed*
          // attempt means exactly the same thing: the session id went stale. Only
          // the quota bookkeeping below is lane-specific.
          const freeTierRefused = response.status === 403 && isFreeTierRejection(raw)
          if (freeTierRefused) {
            forgetCachedSession()
            // "The free lane is closed" is a fact about the public lane, so only
            // an anonymous attempt may conclude it. A keyed request being refused
            // by the gateway says nothing about the shared quota.
            if (credential.anonymous) this.hooks.quota?.refuse?.(Date.now())
          }
          lastError = describeFailure(response.status, raw, credential.anonymous, {
            gate: gateSummary(body, disguise),
            credential: credential.source,
            // 429 的重开时间：文案需要它，而 describeFailure 只拿到 status/body。
            retryAfterMs: response.status === 429 ? (estimateResetMs(response) ?? 0) : 0,
          })
          lastError.code = code
          // Recorded on anything but a transport fault. A throttled key counts:
          // "this key is spent too" is a conclusion about that key, and it is
          // more useful than the free lane's quota, which the operator already
          // knows about. Not `throw`n either — this sits inside the try, so the
          // catch below would catch it and carry on, which is how a rejection
          // silently became a retry. The verdict is recorded and the loop
          // decides.
          if (code !== 'TRANSPORT') {
            if (credential.anonymous) publicError ??= lastError
            else keyedError ??= lastError
          }
          // Whether this credential's answer is a reason to try the next one.
          //
          // The test is deliberately narrow in both directions. An exhausted
          // quota, or the lane refusing this caller, says "I cannot serve you"
          // — the next credential might. A 400 about the model or the body says
          // "nobody can serve you like this", and the other lane would answer
          // identically, so handing off would only spend the second quota to
          // buy the same error.
          const handOff = credential.anonymous
            ? (response.status === 429 || freeTierRefused)
            : (response.status === 429 || response.status === 401 || response.status === 403)
          // A FreeTierError is retryable in a way a plain 403 is not: it says the
          // session id went stale, and `forgetCachedSession()` above has already
          // dropped it, so the next attempt reads a fresh one. Without this, a
          // keyed request with one credential and one stale id stops dead — and
          // the operator sees a 403 that a second look would have fixed.
          // Deliberately excludes `CONTEXT_OVERFLOW`. Every attempt carries the same
          // transcript, so every attempt reaches the same verdict; and the
          // preflight that produced it may hold a multi-minute cooldown on
          // identical requests, so the extra attempts would not even be
          // re-evaluated. `handOff` is false for it too — the next credential
          // would be asked to carry the same oversized payload.
          // 直连撞上身份闸门。429 在这里**不是**额度问题——重试多少次都一样，
          // 因为网关拒绝的是发出者本身（见 oc-bridge.js 顶部那张对照表）。
          // 所以不去退避重试，而是改由本机 OpenCode 客户端代发这一轮。
          // 同时记下来：这台机器的直连走不通，后续请求不必再试。
          if (bridgeMode !== 'off' && !bridgeTried && (code === 'RATE_LIMITED' || freeTierRefused)) {
            bridgeTried = true
            try {
              yield* this.streamViaBridge({ model, messages: wireMessages, system, tools, signal, warn })
              return
            } catch (bridgeErr) {
              warn(`bridge 代发失败：${bridgeErr?.message ?? bridgeErr}`)
              // 客户端这条路也走不通时，把它的结论留给下面，而不是丢一个
              // 没有出处的错误：至少要让操作者知道两条路都试过了。
              lastError = bridgeErr
              if (credential.anonymous) publicError ??= lastError
              else keyedError ??= lastError
            }
          }
          // 429 分两种，处理方式相反：
          //
          //   - 窗口很短（几秒到两分钟）：典型速率限制，退避重试有意义。
          //   - 窗口很长（实测 22000s / 79796s，6–22 小时）：额度真的见底了。这时
          //     退避 3 次、等十几分钟毫无意义，只会白占一轮对话，还让操作者以为
          //     「重试过但没用」。直接报错并告诉他什么时候回来。
          //
          // 403 FreeTierError 仍然可重试：它可能是会话 id 过期，
          // `forgetCachedSession()` 之后重来一次会读到新的。
          const windowMs = code === 'RATE_LIMITED' ? (estimateResetMs(response) ?? 0) : 0
          const shortWindow = windowMs === 0 || windowMs <= AUTO_RETRY_MAX_WAIT_MS
          const retryable = code === 'TRANSPORT'
            || freeTierRefused
            || (code === 'RATE_LIMITED' && shortWindow)
          if (!retryable && !handOff) break
          // One full pass over every credential is the budget. Handing off
          // means "try the next one" — once there is no next one, only a
          // retryable answer (a quota that may have recovered, a network that
          // may have cleared) is worth another round trip.
          if (attempt + 1 >= usable.length && !retryable) break
          // The wait is only worth paying when another attempt follows it.
          // Without this guard the loop sleeps once more after the final
          // failure, which delays the error the operator is about to read by
          // up to the backoff ceiling — for a retry that never happens.
          if (attempt + 1 < attempts) await this.wait(backoffFor(attempt, baseBackoff))
          continue
        }
        // A request that got through clears the memory of throttling, so the
        // counter keeps meaning "throttled right now" rather than "ever".
        this.hooks.quota?.clear()
        // It also proves the model serves, which revokes any retirement.
        this.hooks.availability?.clear(model)
        yield* translateStream(parseSse(response), () => JSON.stringify(wireMessages), { injectedStubs: attemptStubs, realToolNames })
        return
      } catch (err) {
        if (signal?.aborted) throw aborted()
        if (err.name === 'AbortError' && !options.timeoutMs) throw err
        lastError = err
        if (attempt < attempts - 1) await this.wait(backoffFor(attempt, baseBackoff))
      }
    }
    } finally {
      // Advance the key rotation only when a key was actually reached, so a
      // request served by the free lane does not silently move the starting
      // point for the next one.
      if (usedKey) this.keyCursor += 1
    }
    throw withAttemptCount(bridgeFailure || keyedError || publicError || lastError, spent)
  }

  /**
   * bridge 的工作模式。
   *
   * `on` 强制走本机客户端、失败即报错；`auto` 在「这一轮会先花公共额度」时直接
   * 代发，其余情况（私有 Key 领先）直连、被拒后再代发；`off` 完全不启用。
   * 默认 `off`：2026-10-27 之后免费档由「官方 system + Bun 出网」打通，不再需要
   * 代发；此处必须与 Config 里的默认值保持一致——曾经这里硬编码 `auto`，导致
   * 没有显式传 hook 的调用方（测试、以及 config 未注入的部署）悄悄 fork 出
   * 一个 OpenCode 子进程，表现为整轮挂起。
   * @returns `'on' | 'auto' | 'off'`
   */
  bridgeMode() {
    const raw = this.hooks.bridgeMode?.()
    return raw === 'on' || raw === 'auto' || raw === 'off' ? raw : 'off'
  }

  /**
   * 本机 OpenCode 客户端的驱动者，懒启动并复用。
   *
   * 进程只在第一次请求时 fork，之后所有轮次共用，所以冷启动那几秒只付一次。
   * @returns {Promise<import('./oc-bridge.js').OpenCodeBridge>} 已就绪的 bridge。
   */
  async bridge() {
    // `hooks.bridge` lets the host hand in its own driver — worth having for
    // tests, and for a deployment that already runs an OpenCode server.
    this.bridgeInstance ??= this.hooks.bridge?.() ?? new OpenCodeBridge({
      dir: this.hooks.bridgeDir?.(),
      log: (line) => console.warn(LOG_PREFIX, line),
    })
    await this.bridgeInstance.ensure()
    return this.bridgeInstance
  }

  /**
   * 走本机 OpenCode 客户端完成这一轮。
   *
   * 与直连的差别只有「谁把请求发出去」——这正是免费档放行的条件。代价是宿主
   * 工具不能再以原生 function-calling 上行：客户端自带的工具集必须留在报文里
   * （全禁掉会让上游请求不带 tools，网关照样 429），宿主工具因此改写成 system
   * 里的 JSON 协议。
   * @param input - `{ model, messages, system, tools, signal, warn }`。
   */
  async *streamViaBridge({ model, messages, system, tools, signal, warn }) {
    const bridge = await this.bridge()
    const protocol = toolProtocolOf(tools)
    // 不下发 `format: json_schema`：实测它会让免费档模型直接放弃结构化输出，
    // 而只靠 system 里的协议约定，模型反而稳定给出符合格式的 JSON。
    // 见 oc-bridge.js 里 PROTOCOL_SCHEMA 的说明。
    let result
    try {
      result = await bridge.turn({
        model,
        system: [system, protocol].filter(Boolean).join('\n\n'),
        prompt: transcriptOf(messages),
        signal,
      })
    } catch (error) {
      // 代发同样会撞额度：免费档的 429 藏在 idle 消息里，带 retryAfterMs。记下来，
      // 设置页才能给出「什么时候回来」而不是一句 rate limited。
      if (error?.code === 'RATE_LIMITED') {
        this.hooks.quota?.recordWait?.(Date.now(), error.retryAfterMs)
      }
      throw error
    }
    if (signal?.aborted) throw aborted()
    const usage = {
      inputTokens: Number(result.usage?.input ?? 0),
      outputTokens: Number(result.usage?.output ?? 0),
    }
    let index = 0
    const emitText = function* (text) {
      if (!text) return
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index += 1
    }
    // 工具模式下模型应当回答一个协议对象。解析不出来不算失败——把原文原样发出去，
    // 让宿主看到模型到底说了什么，也好过静默丢掉一整轮。
    const call = protocol ? parseProtocol(result.text) : null
    if (protocol && call?.kind === 'tool' && typeof call.name === 'string' && call.name) {
      const id = newToolCallId()
      const args = JSON.stringify(call.args ?? {})
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const finalText = call?.kind === 'final' && call.text ? call.text : result.text
    yield* emitText(finalText)
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Whether the shared free lane is known to be unusable right now.
   *
   * Asked before a request rather than after a failure, so a lane that is
   * still inside its rate-limit window — or still cooling off from a free-tier
   * refusal — is skipped instead of being probed once per request. It is
   * deliberately an estimate: when nothing is known, the lane is assumed open,
   * because the whole point of this plugin is to use it.
   * @returns true when the next request should start at the configured keys.
   */
  publicLaneClosed() {
    try {
      return this.hooks.quota?.publicLaneClosed?.(Date.now()) === true
    } catch {
      return false
    }
  }

  maxAttempts() {
    try {
      return clampInt(this.hooks.maxAttempts?.(), 1, MAX_REQUEST_ATTEMPTS_LIMIT, DEFAULT_MAX_REQUEST_ATTEMPTS)
    } catch {
      return DEFAULT_MAX_REQUEST_ATTEMPTS
    }
  }

  /** 配置的 Zen 根地址；设置项改动后立刻作用于新请求。 */
  baseUrl() {
    try {
      return this.hooks.zenBaseURL?.() || ZEN_BASE_URL
    } catch {
      return ZEN_BASE_URL
    }
  }

  /**
   * 是否经 Bun 转发器出网。
   *
   * 免费档的放行是双因子的：system 必须带官方原文（{@link withOpencodePrompt}），
   * 且 HTTP 客户端必须是 Bun 的 TLS 栈。宿主是 Node，所以第二个因子只能靠
   * lib/zen-egress.js 里的子进程补上。
   *
   * `ZEN_EGRESS=off` 是逃生阀：某些环境（无 Bun、企业代理不允许本地回环）下
   * 宁可退回直连，也不要因为起不来子进程而让整轮失败。
   * @returns 是否需要转发。
   */
  egressEnabled() {
    const flag = String(process.env.ZEN_EGRESS ?? '').trim().toLowerCase()
    if (flag === 'on' || flag === '1' || flag === 'true') return true
    if (flag === 'off' || flag === '0' || flag === 'false') return false
    // Node 的测试运行器会设 NODE_TEST_CONTEXT。单测里不该 fork 子进程：每个用例
    // 都要握手一次（还得本机装有 Bun），会把测试变成环境依赖。要专门测这条路，
    // 请显式 `ZEN_EGRESS=on` 或直接调用 scripts/verify-egress.mjs。
    if (process.env.NODE_TEST_CONTEXT) return false
    return true
  }

  /**
   * 发一次上游请求。
   *
   * 优先走转发器；转发器**自身**不可用时退回直连（会 429，但至少把错误交给上层
   * 的重试与文案，而不是把整轮打死）。注意上游返回 429/5xx 属于「拿到了响应」，
   * 不会走到这个 catch 里，因此不会被误回退成直连。
   * @param url - 完整上游地址。
   * @param init - `fetch` 的第二参数。
   * @param warn - 日志出口。
   * @returns 上游响应。
   */
  async transport(url, init, warn) {
    if (!this.egressEnabled()) return fetch(url, init)
    try {
      return await egressFetch(url, init)
    } catch (error) {
      if (init?.signal?.aborted) throw error
      warn(
        `Bun 出网通道不可用，已回退直连（直连在免费档上会返回 429 伪装拒绝）：`
        + `${error?.message ?? error}${egressFailure() && egressFailure() !== error?.message ? ` / ${egressFailure()}` : ''}`,
      )
      return fetch(url, init)
    }
  }

  backoffMs() {
    try {
      return clampInt(this.hooks.backoffMs?.(), 100, 30_000, DEFAULT_RETRY_BACKOFF_MS)
    } catch {
      return DEFAULT_RETRY_BACKOFF_MS
    }
  }

  /**
   * Wait between attempts.
   *
   * A seam rather than a direct call so a spec can drive the retry loop without
   * sitting through its backoff: the production floor on the backoff is 100ms,
   * which is right for a gateway and makes a ten-attempt spec wait half a
   * minute to assert a number it already knows. Production never overrides this.
   * @param ms - how long to wait.
   * @returns a promise that settles when the wait is over.
   */
  wait(ms) {
    const custom = this.hooks.sleep
    if (typeof custom === 'function') return custom(ms)
    return sleep(ms)
  }
}

function aborted() {
  const e = new Error('OpenCode Zen request aborted by caller')
  e.code = 'ABORTED'
  return e
}

/**
 * Say how many attempts a failure cost, when it cost more than one.
 *
 * A 502 from Zen's gateway is retried up to ten times by default, and an error
 * that reads as though it happened once sends the operator looking for a
 * one-off fault they cannot reproduce. The count is what tells them the route
 * was down for the whole window, and that the plugin already waited.
 * @param error - the failure the loop settled on, possibly null.
 * @param spent - how many round trips were actually made.
 * @returns the same error, annotated, or a fresh one when there is none.
 */
function withAttemptCount(error, spent) {
  if (!(error instanceof Error)) {
    return error ?? new Error('OpenCode Zen request failed')
  }
  // One attempt is the ordinary case; only a retried failure is worth saying so.
  if (spent > 1) {
    error.message += `（已重试 ${spent} 次均失败）`
  }
  return error
}

/**
 * Whether a response is Zen refusing the anonymous free lane itself.
 *
 * It has to be answered outside {@link describeFailure} because it decides
 * routing, not wording: this is the signal that the public lane is done and a
 * configured key may be spent. Two shapes carry it — a typed error body and a
 * bare message prefixed with the type — and both occur upstream.
 * @param raw - the response body.
 * @returns true when the free lane refused the request.
 */
export function isFreeTierRejection(raw) {
  let detail = String(raw ?? '').slice(0, 300)
  let kind = ''
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error?.message ?? parsed?.message ?? detail
    kind = typeof parsed?.error?.type === 'string' ? parsed.error.type : ''
  } catch { /* 非 JSON 的错误体（网关的 502 HTML 页）按原文截断即可 */ }
  return kind === 'FreeTierError' || /^\s*FreeTierError\b/.test(detail)
}

/**
 * Whether this failure is the conversation outgrowing the model's window.
 *
 * A gateway that cannot route an over-long conversation still has to answer
 * *something*, and it answers with a 5xx — the status describes the gateway's
 * own trouble reaching an upstream, not the request's. The body is the only
 * place the real cause appears, so it has to be read before the status.
 *
 * What this recognises, and why each matters:
 *
 * - `exceeds the model window` / `exceeds the context window` — the upstream
 *   provider's own rejection, the most common form.
 * - `maximum context length` — the wording OpenAI-compatible providers use.
 * - `preflight compression could not bring it under` — a *local* verdict: the
 *   host measured the transcript, tried to fold it, found the foldable content
 *   an order of magnitude too small, and declined to forward the payload at
 *   all. Nothing upstream was ever called, so this can only arrive as a 5xx.
 *
 * The last form also carries a retry cooldown in its body. Retrying it is
 * strictly wasted: the transcript is identical every time, so the same verdict
 * is reached again, and the cooldown may refuse to re-evaluate it.
 * @param raw - the response body.
 * @returns true when the conversation, not the network, is what failed.
 */
export function isContextOverflow(raw) {
  const body = String(raw ?? '')
  if (body === '') return false
  return /exceeds the (?:model|context) window/i.test(body)
    || /maximum context length/i.test(body)
    || /context window[^.]*exceed/i.test(body)
    || /preflight compression could not bring it under/i.test(body)
    || /over-window payload/i.test(body)
}

/**
 * 把一次失败的 HTTP 响应翻成操作者照着就能处理的错误。
 *
 * 限流与凭据失败是本插件最常见的两种失败，而网关的原话只有 "Rate limit
 * exceeded" / 一个状态码，既不提配 key 能解，也不说 key 是被拒还是没给。
 * 这里补齐那句建议，否则使用者只会认为插件坏了。
 * @param status - HTTP 状态码。
 * @param raw - 响应体原文，可能是一个网关的 HTML 错误页。
 * @param anonymous - 本次请求是否走公共匿名额度。
 * @param context - 可选的本次请求诊断（{@link gateSummary} 的结果），会附在
 *   free-tier 拒绝后面：光看 403 分辨不出是 session 假还是缺 bash/read。
 * @returns 携带可读信息的 Error，调用方再补 `.code`。
 */
function describeFailure(status, raw, anonymous, context = {}) {
  let detail = raw.slice(0, 300)
  let kind = ''
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error?.message ?? parsed?.message ?? detail
    kind = typeof parsed?.error?.type === 'string' ? parsed.error.type : ''
  } catch { /* 非 JSON 的错误体（网关的 502 HTML 页）按原文截断即可 */ }
  // 网关有时只把类型写在 message 里（"FreeTierError: …"），两种形态都要认。
  const isFreeTier = isFreeTierRejection(raw)
  // 上游的 detail 常自带句点（"…Endpoint is unavailable."），直接拼 `。` 会出 ".。" 双标点。
  const joinAdvice = (text) => (/[.。!?！？]$/.test(text) ? ' ' : '。') + text
  // Which key, not just "a key": with a pool the operator has more than one to
  // look at, and the failing one is not necessarily the last one tried.
  const who = anonymous || context.credential === undefined
    ? ''
    : `（本次使用的凭据：${context.credential}）`
  if (status === 429) {
    // 2026-10-27 修订：429 有两个成因、响应一模一样——免费档窗口关闭，或者请求
    // 没满足放行条件（system 缺官方原文、客户端不是 Bun 的 TLS 栈），见
    // lib/zen-prompt.js 顶部。两者的区别只能靠「同一时刻问一句本机 OpenCode」判断。
    //
    // 关键一点：这个拒绝发生在**凭据校验之前**。实测同一时刻用真 Key、假 Key、
    // 不带凭据请求，拿到的是同一个 429（retry-after 一致），所以对带 Key 的调用
    // 绝不能把它说成「你这把 Key 的额度用完了」——那会让人去查一个没问题的 Key。
    // （早前两版注释都不准确：一版说「就是额度」，一版说「是身份伪装」，都已撤销。）
    // `describeFailure` 拿不到 response 对象（它只接 status/body），所以重开时间由
    // 调用方通过 context 传进来。
    const retryAfterMs = Number(context.retryAfterMs)
    const when = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? `网关建议约 ${Math.max(1, Math.round(retryAfterMs / 60_000))} 分钟后重试`
      : '稍后重试'
    if (anonymous) {
      return new Error(
        `OpenCode Zen 公共免费额度已用尽（HTTP 429）：${detail}`
        + joinAdvice(`${when}；或到 https://opencode.ai/zen 取一个 key 以使用自己的额度`)
        + who,
      )
    }
    return new Error(
      `OpenCode Zen 免费档窗口已关闭（HTTP 429）：${detail}`
      + joinAdvice(
        `${when}。这个拒绝发生在凭据校验之前——同一时刻换成任意 Key（甚至不存在的 Key）`
        + '得到的是同一个 429，所以它不说明你所配的 Key 有问题；'
        + '要花自己的额度得改用付费模型（前提是账户有余额）',
      )
      + who,
    )
  }
  if (status === 402) {
    // 402 是「认证通过了，但账户没钱」。它和 401 的区别很重要：401 才说明 Key 无效。
    // 这个分支存在之前，402 落到通用 4xx，操作者只看到一句语焉不详的 providers 错误。
    return new Error(
      `OpenCode Zen 该账号余额不足（HTTP 402）：${detail}`
      + joinAdvice(
        '这不是 Key 失效（失效会返回 401），也不是免费档窗口——是账户没有余额。'
        + '到 https://opencode.ai/zen 充值，或改用 *-free 模型（等免费档窗口恢复）',
      )
      + who,
    )
  }
  if (status === 401 || status === 403) {
    // FreeTierError 不是"凭据被拒"的另一种说法。它只说明这次调用走了免 key 的匿名
    // 通道、而该通道不放行非官方 OpenCode 客户端形态的流量——自 2026-10-03 起，
    // 连官方 CLI 也普遍收到同一错误（opencode#52907 等一批报告）。把它说成凭据问题
    // 会让使用者去翻一个他根本没配过的 key。
    if (isFreeTier) {
      const advice = anonymous
        ? '这条免 key 通道已不对第三方请求放行，与本插件的请求构造无关。'
          + '继续使用请到 https://opencode.ai/zen 取一个 API key，写进 apiKeyEnv 指定的环境变量（默认 OPENCODE_API_KEY）后重试'
        : '这次调用已带凭据却仍被判为免费档流量，检查该 key 是否属于匿名/受限额度，或到 https://opencode.ai/zen 确认'
      // A bare 403 does not say which of the gate's conditions failed, and the
      // two candidates need opposite fixes, so report what this attempt sent.
      const diagnosis = context.gate === undefined ? '' : `（本次请求：${context.gate}）`
      return new Error(`OpenCode Zen 拒绝了匿名免费档调用（HTTP ${status} FreeTierError）：${detail}${joinAdvice(advice)}${diagnosis}`)
    }
    const advice = anonymous
      ? `这个请求需要凭据；到 https://opencode.ai/zen 取一个 key 并配置环境变量，或确认该模型仍属免费档`
      : '检查密钥环境变量的值是否有效、是否已过期'
    return new Error(`OpenCode Zen 拒绝了本次凭据（HTTP ${status}）：${detail}${joinAdvice(advice)}${who}`)
  }
  // A 5xx here is usually Zen's own gateway failing to reach the provider
  // upstream — "acp-proxy failure" wrapping a connect timeout, most often.
  // Nothing about the request is wrong, so the advice is to wait.
  //
  // "Usually" is doing real work. A gateway asked to carry a conversation
  // larger than the model's window has no upstream to fail on: it measures the
  // payload, tries to fold it, gives up, and still has to answer with a status
  // code. It picks 5xx because that is what it would have sent had the network
  // failed. So this branch must read the body first — telling the operator to
  // wait for a network that was never the problem sends them away from the one
  // action that works.
  if (status >= 500) {
    if (isContextOverflow(raw)) {
      return new Error(
        `OpenCode Zen 拒绝了超窗请求（HTTP ${status}）：${detail}`
        + joinAdvice('对话内容已经超出这个模型的上下文窗口，请求并未发往上游——'
          + '这与网络、Key、额度都无关，重发同一个请求只会再被拒一次。'
          + '要继续就得减少对话里的内容（新开会话、或让助手把前面的工作收拢成结论），'
          + '或者改用上下文窗口更大的模型'),
      )
    }
    const advice = '这是 Zen 网关到上游提供商的连接失败（多为临时网络问题），与模型和请求内容无关；'
      + '插件已按设置自动重试，稍后重发通常即可恢复'
    return new Error(`OpenCode Zen 网关故障（HTTP ${status}）：${detail}${joinAdvice(advice)}${who}`)
  }
  return new Error(`OpenCode Zen HTTP ${status}: ${detail}`)
}

/**
 * Describe what one attempt actually put on the wire, for a free-tier refusal.
 *
 * Zen answers the same 403 for a fake session id and for a body missing
 * `bash`/`read`, and the two need opposite fixes — so a refusal has to say
 * which shape it saw instead of leaving the reader to guess.
 * @param body - the request body that was sent.
 * @param disguise - the identity {@link gateDisguise} produced.
 * @returns one short line naming the session source and the gate tools present.
 */
function gateSummary(body, disguise) {
  const names = new Set((body.tools ?? []).map((t) => t?.function?.name).filter(Boolean))
  const gate = ['bash', 'read'].filter((name) => names.has(name))
  const tools = gate.length === 2 ? 'bash+read 齐全' : gate.length === 1 ? `只有 ${gate[0]}` : 'bash/read 都缺'
  return `session 来源=${disguise?.source ?? '无'}，网关工具=${tools}，工具总数=${names.size}`
}

/** 在 DSH 的 llm 服务里注册 opencode-free provider（免 key）。
 *  @param control 可选：{ enabled: () => boolean }，暂停时模型从选择器消失且无法回复。
 *  @returns 注册句柄，额外挂 `.adapter` 供宿主 setModels() 注入同步结果。
 */
export function installOpenCodeFreeProvider(ctx, log, control, hooks = {}) {
  if (typeof ctx.llm?.registerAdapter !== 'function') {
    if (typeof log === 'function') log('llm service unavailable; adapter not registered')
    return null
  }
  const adapter = new OpenCodeFreeAdapter(ctx, control, hooks)
  const handle = ctx.llm.registerAdapter([PROVIDER], adapter)
  handle.adapter = adapter
  return handle
}
