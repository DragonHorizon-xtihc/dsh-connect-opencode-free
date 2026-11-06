// dsh-connect-opencode-free · OpenCode Zen 免 key provider (host side)
//
// ⚠️ 2026-11-06 定案：**出网只走 bridge**（本机真实 `opencode serve` 进程代发）。
// 直连这条路已整条删除，不要再补回来。同刻对照实测的结论：
//
//   bridge（真实客户端）→ 200
//   直连（Node / Bun 转发进程 / 匿名凭据）→ 一律 429 FreeUsageLimitError
//
// 逐项换过都救不回来：Bun 二进制（通用 bun 与 opencode-cli.exe 同一 exe 的
// BUN_BE_BUN=1）、cli/desktop 全套请求头、JA3/JA4 TLS 指纹、伪造与真实
// x-opencode-session、2KB 无 tools 到 234KB+ 原报文、官方 system 提示词注入。
// 结论：网关放行的是**真实客户端进程的连接态**，独立脚本复刻不出来。
//
// 两个被实测推翻、别再拿来做判断的旧结论：
//   · 「429 = 公共池额度耗尽」——同一时刻 bridge 稳定 200，不是全局额度问题。
//   · 「234KB+ body / 工具表太大 / 13h 冷却期」——bridge 发同样 234KB+ 报文
//     照样 200，直连发 2KB 无 tools 照样 429，与体积/冷却无关。
//
// 因此本文件没有任何 fetch / 请求头 / 凭据 / TLS / 网关 shape gate 代码：
// 这些全部由 OpenCode 客户端自己负责。宿主工具改走 system 里的 JSON 协议
// （见 lib/oc-bridge.js），因为客户端自带的工具集必须留在报文里。
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
import { LOG_PREFIX, PROVIDER, clampInt } from './core.js'
import { diag } from './zen-diag.js'
import {
  OpenCodeBridge,
  parseProtocol,
  toolProtocolOf,
  transcriptOf,
} from './oc-bridge.js'

const LlmAdapter = typeof dshLlm.LlmAdapter === 'function' ? dshLlm.LlmAdapter : Object

/** Fallback tool-call id; the protocol reply carries no upstream id. */
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

const DEFAULT_MAX_TOKENS = 128000
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_RETRY_BACKOFF_MS = 800

/**
 * Ceiling for one backoff sleep.
 *
 * Exponential growth is right for the first few retries and wrong for the tenth:
 * past the fourth retry the extra wait buys nothing, so the step is clamped and
 * the tail flattens.
 */
const MAX_RETRY_BACKOFF_MS = 8_000

/** bridge 失败后的重试次数（固定规则：非 429 报错重试三次）。导出供测试断言。 */
export const BRIDGE_RETRIES = 3

/** wire messages 的体积预算；超出就丢最旧的历史。 */
const WIRE_MESSAGES_BUDGET = 220 * 1024

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How long to wait before the retry after `attempt` (0-based) failures.
 * @param attempt - how many attempts have already failed, 0-based.
 * @param base - the configured initial backoff in milliseconds.
 * @returns the sleep in milliseconds, clamped at {@link MAX_RETRY_BACKOFF_MS}.
 */
export function backoffFor(attempt, base) {
  const step = base * (2 ** Math.max(0, attempt))
  return Math.min(step, MAX_RETRY_BACKOFF_MS)
}

function flattenText(content) {
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  return typeof content === 'string' ? content : ''
}

function blocksOf(content, type) {
  return Array.isArray(content) ? content.filter((b) => b.type === type) : []
}

/**
 * Repair a history that no longer lines up, in place of sending it.
 *
 * A `tool` message is only legal while the call it answers is still open. Once
 * a history has been compacted, resumed, or stitched back together, a result
 * can outlive its call — re-labelling it as a user turn keeps the information
 * while making the transcript valid again.
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
      warn(`dropping orphan tool result ${message.tool_call_id ?? '(no id)'}: no matching tool call remains in the history`)
      out.push({ role: 'user', content: `[tool result] ${message.content}` })
      continue
    }
    out.push(message)
  }
  return out
}

/**
 * 限制 wire messages 的体积：超过预算就丢掉最旧的历史，但**始终保留 system
 * 与第一条 user**（问题本身不能丢）。bridge 把这份历史转成纯文本 prompt，
 * 超长历史照样会拖垮客户端，所以裁剪仍然必要。
 *
 * @param wire - 序列化后的消息数组。
 * @param budget - 总体积预算（字节），含 system。
 * @returns 裁剪后的新数组。
 */
export function trimMessages(wire, budget = WIRE_MESSAGES_BUDGET) {
  if (!Array.isArray(wire)) return wire
  const system = wire.filter((m) => m && m.role === 'system')
  const rest = wire.filter((m) => !m || m.role !== 'system')
  if (rest.length === 0) return wire

  const firstUserIndex = rest.findIndex((m) => m && m.role === 'user')
  const mustKeep = firstUserIndex >= 0 ? [rest[firstUserIndex]] : []

  const out = []
  let bytes = JSON.stringify(system).length + JSON.stringify(mustKeep).length
  // 从最新往回装：最近的上下文对当前回答最有用。
  for (let i = rest.length - 1; i >= 0; i--) {
    if (firstUserIndex >= 0 && i === firstUserIndex) continue
    const size = JSON.stringify(rest[i]).length + 1
    if (bytes + size > budget) break
    out.unshift(rest[i])
    bytes += size
  }
  if (firstUserIndex >= 0) out.unshift(rest[firstUserIndex])

  const dropped = rest.length - out.length
  if (dropped > 0) diag({ event: 'messages-trimmed', dropped, kept: out.length, bytes, budget })
  return [...system, ...out]
}

/** DSH/Harness 消息 → transcriptOf 认识的 wire 格式。 */
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
          // string, which is not JSON.
          function: { name: b.name, arguments: b.arguments || '{}' },
        }))
      const msg = { role: 'assistant', content: text }
      if (reasoning) msg.reasoning_content = reasoning
      if (toolCalls.length) msg.tool_calls = toolCalls
      wire.push(msg)
      continue
    }
    // A tool result must stay a tool result, so the transcript keeps the
    // call/result pairing instead of flattening it into a user turn.
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
 * 免 key OpenCode Zen adapter。
 *
 * 两道保险同时满足 `llm` 服务的调用契约（该服务每轮必调
 * `registration.adapter.prepareCall()`）：
 *
 *   1. 继承 {@link LlmAdapter}，且 `@deepseek-ai/dsh-llm` 永远 external、与
 *      宿主解析到同一份——把它打进插件会造出第二个基类，instanceof 与服务
 *      注册都会失效；
 *   2. 显式实现 `prepareCall()`，不依赖基类继承。这样即便插件因安装/链接
 *      问题解析到旧版 dsh-llm，也不会抛 `prepareCall is not a function`。
 *
 * 模型集由宿主注入：初始为空，等 lib/index.js 首次同步后端（或读到手动模型）
 * 再 setModels()。空列表是合法状态。
 */
export class OpenCodeFreeAdapter extends LlmAdapter {
  constructor(ctx, control, hooks = {}) {
    super()
    this.ctx = ctx
    this.control = control || { enabled: () => true }
    this.models = []
    /** @type {{ quota?: unknown, backoffMs?: () => number, bridge?: () => unknown, bridgeDir?: () => string, sleep?: (ms: number) => Promise<void> }} */
    this.hooks = hooks
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
   * whose base class does not carry one.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 唯一路由：bridge。非 429 报错重试 BRIDGE_RETRIES 次；429（额度/限流）
   * 与 CONTEXT_OVERFLOW 不重试，直接失败。
   */
  async *stream(options) {
    // 暂停屏障：插件被暂停时拒绝一切请求，任何已选该模型的消息都无法回复。
    if (this.paused) {
      const err = new Error('OpenCode Zen Free is paused: enable it in the plugin settings to use these models')
      err.code = 'PAUSED'
      err.paused = true
      throw err
    }
    const { model, messages, system, tools, signal } = options
    const warn = (line) => console.warn(LOG_PREFIX, line)
    const wireMessages = sanitizeWireMessages(trimMessages(serializeMessages(messages, system)), warn)

    const baseBackoff = this.backoffMs()
    let lastError = null
    let spent = 0
    for (let attempt = 0; attempt <= BRIDGE_RETRIES; attempt++) {
      if (signal?.aborted) throw aborted()
      spent++
      try {
        yield* this.streamViaBridge({ model, messages: wireMessages, system, tools, signal, warn })
        return
      } catch (bridgeErr) {
        if (signal?.aborted) throw aborted()
        lastError = bridgeErr
        // 429：额度/限流，重试只会把冷却窗口推得更远 → 不重试。
        // CONTEXT_OVERFLOW：同一份历史重发必然再超窗 → 不重试。
        if (bridgeErr?.code === 'RATE_LIMITED' || bridgeErr?.status === 429
          || bridgeErr?.code === 'CONTEXT_OVERFLOW') break
        if (attempt < BRIDGE_RETRIES) {
          await this.wait(backoffFor(attempt, baseBackoff))
          continue
        }
        break
      }
    }
    throw withAttemptCount(lastError, spent)
  }

  /**
   * 本机 OpenCode 客户端的驱动者，懒启动并复用。
   *
   * 进程只在第一次请求时 fork，之后所有轮次共用，所以冷启动那几秒只付一次。
   * `hooks.bridge` 让宿主/测试注入自己的驱动者，也让单测不会 fork 真实进程。
   * @returns {Promise<import('./oc-bridge.js').OpenCodeBridge>} 已就绪的 bridge。
   */
  async bridge() {
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
   * 代价是宿主工具不能再以原生 function-calling 上行：客户端自带的工具集
   * 必须留在报文里，宿主工具因此改写成 system 里的 JSON 协议。
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

  backoffMs() {
    try {
      return clampInt(this.hooks.backoffMs?.(), 100, 30_000, DEFAULT_RETRY_BACKOFF_MS)
    } catch {
      return DEFAULT_RETRY_BACKOFF_MS
    }
  }

  /**
   * Wait between attempts. A seam rather than a direct call so a spec can drive
   * the retry loop without sitting through its backoff.
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
 * @param error - the failure the loop settled on, possibly null.
 * @param spent - how many round trips were actually made.
 * @returns the same error, annotated, or a fresh one when there is none.
 */
function withAttemptCount(error, spent) {
  if (!(error instanceof Error)) {
    return error ?? new Error('OpenCode Zen request failed')
  }
  if (spent > 1) error.message += `（已重试 ${spent} 次均失败）`
  return error
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
