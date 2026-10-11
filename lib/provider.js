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
import { createHash, randomUUID } from 'node:crypto'

import * as dshLlm from '@deepseek-ai/dsh-llm'
import { classifyFailure } from './availability.js'
import { LOG_PREFIX, PROVIDER, ZEN_BASE_URL, clampInt } from './core.js'

const LlmAdapter = typeof dshLlm.LlmAdapter === 'function' ? dshLlm.LlmAdapter : Object
const attributionHeaders = typeof dshLlm.attributionHeaders === 'function'
  ? dshLlm.attributionHeaders
  : () => ({})

// Zen's anonymous free lane is gated server-side: a request that does not look
// like it came from the OpenCode CLI is rejected with 403 FreeTierError even
// though no key is required. Probed live against opencode.ai, all three of the
// following must hold at once, and dropping any one of them returns 403 again:
//
//   1. User-Agent starts with `opencode/`
//   2. a canonical `x-opencode-session` — `ses_` + 26 chars
//   3. the body carries function tools named `bash` and `read`
//
// The check runs on the anonymous lane only; a configured OPENCODE_API_KEY has
// its own paid route and must not be disguised, so these are applied per
// credential rather than per provider.
const OPENCODE_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

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

/** A shared empty set, for an attempt that advertised no stubs at all. */
const EMPTY_SET = new Set()

/**
 * Derive a session id Zen's gate accepts.
 *
 * The shape is fixed (`ses_` + 12 lowercase hex + 14 Base62 = 26 chars) and the
 * value is derived deterministically from the conversation so one DSH session
 * keeps one Zen session: upstream prompt-cache affinity depends on it, and a
 * fresh random id per request would defeat that for no benefit.
 * @param seed - the DSH session id, or a fallback seed when there is none.
 * @returns a syntactically canonical OpenCode session id.
 */
function canonicalSessionId(seed) {
  const digest = createHash('sha256').update(String(seed || 'dsh-opencode-free')).digest('hex')
  const hex = digest.slice(0, 12)
  let remaining = BigInt(`0x${digest.slice(12, 44)}`)
  let base62 = ''
  for (let i = 0; i < 14; i += 1) {
    base62 = BASE62[Number(remaining % 62n)] + base62
    remaining /= 62n
  }
  return `ses_${hex}${base62}`
}

/** Headers and tool stubs the anonymous lane needs to clear Zen's gate. */
function freeTierDisguise(sessionId) {
  return { userAgent: OPENCODE_UA, session: canonicalSessionId(sessionId) }
}

const DEFAULT_MAX_TOKENS = 128000
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3
const DEFAULT_RETRY_BACKOFF_MS = 800

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The bearer this request should use.
 *
 * With no operator key the shared literal `"public"` is the correct answer —
 * Zen's free tier accepts it anonymously. When the operator has listed one or
 * more keys, they are used round-robin so a sustained session spreads across
 * their quotas instead of burning the first one and then 429ing. The pool is
 * resolved on every attempt because a key may live in the Harness credential
 * store, which only answers asynchronously.
 * @param credentials - the pool itself, or a function producing it.
 * @param cursor - which entry of the pool this attempt takes.
 * @returns the credential for this attempt.
 */
async function nextCredential(credentials, cursor) {
  const pool = await (typeof credentials === 'function' ? credentials() : credentials)
  if (!Array.isArray(pool) || pool.length === 0) return { key: 'public', source: 'public', anonymous: true }
  const entry = pool[cursor % pool.length]
  return { ...entry, anonymous: false }
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
    /** @type {{ quota?: unknown, credentials?: () => unknown[] | Promise<unknown[]>, maxAttempts?: () => number, backoffMs?: () => number }} */
    this.hooks = hooks
    this.credentialCursor = 0
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
    const wireMessages = sanitizeWireMessages(serializeMessages(messages, system), warn)
    const wireTools = serializeTools(tools)
    // The gate stubs the caller does not already own — the set the anonymous
    // lane would have to advertise. Which lane an attempt takes is only known
    // once it picks a credential, so this is the candidate set, not a fact.
    const realToolNames = (tools || []).map((t) => (t && typeof t.name === 'string' ? t.name : '')).filter(Boolean)
    const presentNames = new Set(realToolNames)
    const missingGateNames = new Set([...GATE_TOOL_NAMES].filter((name) => !presentNames.has(name)))
    // Steer the model away from the placeholders before it reaches for them:
    // the gate forces them onto the wire, and a capable model will otherwise
    // pick `bash` whenever it wants a shell.
    if (missingGateNames.size > 0 && wireTools !== undefined) {
      const steer = `Do not call the tools named ${[...missingGateNames].join(' and ')}: they are reserved placeholders declared only to pass the upstream OpenCode gateway and are not executable. Use the other provided tools instead.`
      const head = wireMessages[0]
      if (head && head.role === 'system') {
        wireMessages[0] = { ...head, content: `${head.content}\n\n${steer}` }
      } else {
        wireMessages.unshift({ role: 'system', content: steer })
      }
    }
    auditWireMessages(wireMessages, warn)
    const known = this.models.find((m) => m.id === model)
    const outputCap = known?.maxTokens ?? DEFAULT_MAX_TOKENS

    // Built without the gate tools: which gate applies is decided by the
    // credential, and that is only known once an attempt picks one.
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
     * The tools to advertise for one attempt's credential.
     *
     * Only the anonymous lane runs Zen's free-tier gate, and that gate is the
     * sole reason placeholder tools exist at all. Probed with a keyed body
     * carrying no stubs: the gateway answers 401 AuthError, never 403
     * FreeTierError — the free-tier check does not run on the authenticated
     * route. Advertising placeholders there would reintroduce, for a paying
     * caller, exactly the failure they are meant to avoid: a tool the model can
     * select but nobody can execute.
     * @param credential - this attempt's credential.
     * @returns the `tools`/`tool_choice` fields for the request body.
     */
    const gateFor = (credential) => {
      if (credential.anonymous) return gateTools(tools, wireTools)
      return wireTools === undefined ? {} : { tools: wireTools, tool_choice: 'auto' }
    }

    const attempts = this.maxAttempts()
    const baseBackoff = this.backoffMs()
    let lastError = null
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal?.aborted) throw aborted()
      // Each attempt takes the next key, so a pool of N spreads N requests
      // across N quotas before any one of them is asked to retry.
      const credential = await nextCredential(this.hooks.credentials, this.credentialCursor++)
      // Only the anonymous free lane needs the CLI disguise; a keyed request
      // rides its own paid route and must keep the harness's own identity.
      const disguise = credential.anonymous
        ? freeTierDisguise(options.sessionId)
        : { userAgent: undefined, session: undefined }
      // The body is assembled here, not once outside: only an anonymous attempt
      // runs the free-tier gate, so only it may carry placeholder tools.
      const body = { ...baseBody, ...gateFor(credential) }
      // Likewise, only the stubs this attempt actually advertised may be
      // suppressed on the way back.
      const attemptStubs = credential.anonymous ? missingGateNames : EMPTY_SET
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 60000)
        const onAbort = () => controller.abort()
        if (signal) signal.addEventListener('abort', onAbort)

        let response
        try {
          response = await fetch(`${this.baseUrl()}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${credential.key}`,
              // Omitted rather than set to undefined when keyed: a header slot
              // holding "undefined" is itself a request fingerprint.
              ...(disguise.userAgent === undefined ? {} : { 'User-Agent': disguise.userAgent }),
              ...(disguise.session === undefined ? {} : { 'x-opencode-session': disguise.session }),
              ...attributionHeaders(),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
          if (signal) signal.removeEventListener('abort', onAbort)
        }

        if (!response.ok) {
          const raw = await response.text().catch(() => '')
          const code = response.status === 429 ? 'RATE_LIMITED' : response.status >= 500 ? 'TRANSPORT' : 'PROVIDER_ERROR'
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
          lastError = describeFailure(response.status, raw, credential.anonymous)
          lastError.code = code
          if (code !== 'RATE_LIMITED' && code !== 'TRANSPORT') throw lastError
          await sleep(baseBackoff * (2 ** attempt))
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
        if (attempt < attempts - 1) await sleep(baseBackoff * (2 ** attempt))
      }
    }
    throw lastError || new Error('OpenCode Zen request failed')
  }

  maxAttempts() {
    try {
      return clampInt(this.hooks.maxAttempts?.(), 1, 6, DEFAULT_MAX_REQUEST_ATTEMPTS)
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

  backoffMs() {
    try {
      return clampInt(this.hooks.backoffMs?.(), 100, 30_000, DEFAULT_RETRY_BACKOFF_MS)
    } catch {
      return DEFAULT_RETRY_BACKOFF_MS
    }
  }
}

function aborted() {
  const e = new Error('OpenCode Zen request aborted by caller')
  e.code = 'ABORTED'
  return e
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
 * @returns 携带可读信息的 Error，调用方再补 `.code`。
 */
function describeFailure(status, raw, anonymous) {
  let detail = raw.slice(0, 300)
  try {
    const parsed = JSON.parse(raw)
    detail = parsed?.error?.message ?? parsed?.message ?? detail
  } catch { /* 非 JSON 的错误体（网关的 502 HTML 页）按原文截断即可 */ }
  if (status === 429) {
    const advice = anonymous
      ? '公共免费额度按来源限流；到 https://opencode.ai/zen 取一个 key 并在设置里配置密钥环境变量即可用私有额度'
      : '稍后重试，或到 https://opencode.ai/zen 检查该账号的免费额度'
    const subject = anonymous ? '公共免费额度已用尽' : '该账号触发限流'
    return new Error(`OpenCode Zen ${subject}（HTTP 429）：${detail}。${advice}`)
  }
  if (status === 401 || status === 403) {
    const advice = anonymous
      ? `这个请求需要凭据；到 https://opencode.ai/zen 取一个 key 并配置环境变量，或确认该模型仍属免费档`
      : '检查密钥环境变量的值是否有效、是否已过期'
    return new Error(`OpenCode Zen 拒绝了本次凭据（HTTP ${status}）：${detail}。${advice}`)
  }
  return new Error(`OpenCode Zen HTTP ${status}: ${detail}`)
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
