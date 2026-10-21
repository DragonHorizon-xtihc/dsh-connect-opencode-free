// 端到端验证 bridge：真的把一轮对话交给本机 OpenCode 客户端代发，看免费档是否放行。
//
// 这两件事正是插件直连做不到的：
//   1. 纯文本一轮 —— 直连拿 429，bridge 应当拿到正文
//   2. 工具协议一轮 —— 模型按约定回 {"kind":"tool",...}，解析后能交给宿主执行
//
// 运行：node scripts/verify-bridge.mjs [模型 id]

import {
  OpenCodeBridge,
  PROTOCOL_SCHEMA,
  parseProtocol,
  toolProtocolOf,
  transcriptOf,
} from '../lib/oc-bridge.js'

const MODEL = process.argv[2] ?? 'mimo-v2.6-flash-free'
const bridge = new OpenCodeBridge({ log: (line) => console.log('  ·', line) })

function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  return ok
}

let failures = 0

try {
  // ---- 1. 纯文本 ----
  const t0 = Date.now()
  const plain = await bridge.turn({
    model: MODEL,
    system: 'Reply with exactly: OK',
    prompt: 'ping',
  })
  const okText = /OK/.test(plain.text)
  failures += report('文本轮：客户端代发并返回正文', okText, `${Date.now() - t0}ms, 正文=${JSON.stringify(plain.text.slice(0, 40))}`) ? 0 : 1
  console.log('       tokens:', JSON.stringify(plain.usage))

  // ---- 2. 工具协议 ----
  const tools = [
    { name: 'get_weather', description: 'Look up the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { name: 'add', description: 'Add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  ]
  const protocol = toolProtocolOf(tools)
  const t1 = Date.now()
  // 刻意不发 schema：免费档模型带上它会拒绝产出结构化输出，而纯文本协议能成。
  const tooled = await bridge.turn({
    model: MODEL,
    system: protocol,
    prompt: 'User: What is the weather in Beijing? Use the get_weather tool.',
  })
  const call = parseProtocol(tooled.text)
  const okCall = Boolean(call) && (call.kind === 'tool' ? call.name === 'get_weather' : call.kind === 'final')
  failures += report(
    '工具轮：模型按协议点名宿主工具',
    okCall,
    `${Date.now() - t1}ms, 解析结果=${JSON.stringify(call)}`,
  ) ? 0 : 1

  // ---- 3. 会话文本序列化 ----
  const text = transcriptOf([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'add', arguments: '{"a":1,"b":2}' } }] },
    { role: 'tool', name: 'add', content: '3' },
  ])
  const okTranscript = text.includes('User: hi') && text.includes('add({"a":1,"b":2})') && text.includes('Tool result (add): 3')
  failures += report('会话序列化：工具轮次可读地进入文本', okTranscript, JSON.stringify(text)) ? 0 : 1
} catch (err) {
  failures += 1
  console.log(`FAIL  未预期错误：${err?.message ?? err} (code=${err?.code ?? '-'})`)
} finally {
  bridge.dispose()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
