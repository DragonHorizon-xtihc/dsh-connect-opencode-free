// 端到端复现 v2：工具一律转成线上格式 {type:'function',function:{...}}
// （与 lib/provider.js serializeTools 同一转换），排除格式非法造成的假象。
//
// 分组：
//   0  基线 tiny + wire 格式 bash/read         —— 车道是否活着
//   A  全量 347 工具(wire) + 完整消息 + 原参数  —— 原样复现（deepseek-v4.1-flash-free）
//   B  同 A，但打 mimo-v2.6-flash-free          —— 同为 168000 预算、上游存活的模型
//   C  同 A，但打 big-pickle                    —— 另一个 168000 预算模型
//   D  同 A，但打 longcat-2.5-preview-free      —— 100 万窗口模型（反向对照）
//   E  完整消息 + 仅 bash/read(wire)            —— 隔离消息侧
import { readFileSync } from 'node:fs'
import { realSessionId } from '../lib/oc-session.js'

const BASE = 'https://opencode.ai/zen/v1'
const UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const MODEL = 'deepseek-v4.1-flash-free'
const sessionPath = process.argv[2] ?? '.workbuddy/session-analyze.v4.jsonl'

// ---- 与 serializeTools 相同的转换 ----
function toWireTools(tools) {
  return tools
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: typeof t.description === 'string' && t.description ? t.description : t.name,
        parameters: t.parameters && typeof t.parameters === 'object' && Object.keys(t.parameters).length > 0
          ? t.parameters
          : { type: 'object', properties: {} },
      },
    }))
}

// ---- 1. 重建第 5 步载荷 ----
const events = readFileSync(sessionPath, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l))
const byType = (t) => events.filter((e) => e.type === t)
const systemMsg = byType('system/message').at(-1)?.data?.message
const header = byType('request/header').at(-1)?.data?.header
const tools = toWireTools(header.tools)
const wire = [{ role: 'system', content: systemMsg.content.map((b) => b.text).join('') }]
const userMsgs = byType('user/message')
const userText = (u) => (u.data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
wire.push({ role: 'user', content: userText(userMsgs[0]) })
for (const a of byType('assistant/message')) {
  const calls = a.data.message.content.filter((b) => b.type === 'tool-call')
  const reasoning = a.data.message.content.find((b) => b.type === 'reasoning')
  wire.push({
    role: 'assistant',
    content: '',
    ...(reasoning ? { reasoning_content: reasoning.text } : {}),
    tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
  })
}
const callOrder = byType('tool/call').map((e) => e.data.callId)
const resultById = new Map(byType('tool/result').map((e) => [e.data.message.toolCallId, e.data.message]))
for (const callId of callOrder) {
  const r = resultById.get(callId)
  wire.push({ role: 'tool', tool_call_id: callId, content: r.content[0].text })
}
for (const u of userMsgs.slice(1)) wire.push({ role: 'user', content: userText(u) })

const toolsJson = JSON.stringify(tools)
console.log('=== wire 格式载荷尺寸 ===')
console.log(`工具 ${tools.length} 个，JSON ${toolsJson.length} 字符 ≈ ${Math.ceil(toolsJson.length / 4)} tokens`)
console.log(`消息 ${wire.length} 条，JSON ${JSON.stringify(wire).length} 字符 ≈ ${Math.ceil(JSON.stringify(wire).length / 4)} tokens`)

const { id: SID, source, reason } = await realSessionId()
if (SID === undefined) { console.log('读不到真实 session:', reason); process.exit(1) }
console.log(`session: ${SID}（${source}）\n`)

async function attempt(label, model, body) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-opencode-session': SID, Authorization: 'Bearer public' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    })
    const text = await res.text().catch(() => '')
    const over = /exceeds the (model|context) window|preflight compression/i.test(text)
    const reply = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join('')
    console.log(`--- ${label} [${model}] → HTTP ${res.status}${over ? ' 【上下文超窗】' : ''}`)
    console.log('   ', text.slice(0, 420).replace(/\n/g, ' '))
    if (reply) console.log('    回复:', JSON.stringify(reply.slice(0, 50)))
  } catch (e) {
    console.log(`--- ${label} [${model}] → 网络错误: ${e?.message ?? e}`)
  }
}

const gate = tools.filter((t) => ['bash', 'read'].includes(t.function.name))
const tiny = [{ role: 'user', content: 'Reply exactly: OK' }]

await attempt('0 基线 tiny+bash/read', 'mimo-v2.6-flash-free',
  { model: 'mimo-v2.6-flash-free', messages: tiny, stream: true, max_tokens: 16, tools: gate, tool_choice: 'auto' })

await attempt('A 全量工具+完整消息（原样复现）', MODEL,
  { model: MODEL, messages: wire, stream: true, stream_options: { include_usage: true }, max_tokens: 32000, top_p: 0.95, reasoning_effort: 'max', tools, tool_choice: 'auto' })

await attempt('B 同A打 mimo（168k预算·上游存活）', 'mimo-v2.6-flash-free',
  { model: 'mimo-v2.6-flash-free', messages: wire, stream: true, max_tokens: 32000, top_p: 0.95, tools, tool_choice: 'auto' })

await attempt('C 同A打 big-pickle（168k预算）', 'big-pickle',
  { model: 'big-pickle', messages: wire, stream: true, max_tokens: 32000, top_p: 0.95, tools, tool_choice: 'auto' })

await attempt('D 同A打 longcat（100万窗口）', 'longcat-2.5-preview-free',
  { model: 'longcat-2.5-preview-free', messages: wire, stream: true, max_tokens: 32000, top_p: 0.95, tools, tool_choice: 'auto' })

await attempt('E 完整消息+仅bash/read', MODEL,
  { model: MODEL, messages: wire, stream: true, max_tokens: 32000, top_p: 0.95, reasoning_effort: 'max', tools: gate, tool_choice: 'auto' })
