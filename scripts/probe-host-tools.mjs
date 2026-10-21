// 决定性实验：用「宿主真实发出去的 347 工具表」直连打 Zen。
//
// 起因：session.v4.jsonl 显示 2026-10-16 16:41，opencode-free 直连成功跑完 4 步
// 真实工具调用 —— 那时并不存在「直连必然 429」。而之前所有探针用的都是 OpenCode
// 客户端的工具表，从没试过宿主这一套。
//
// 判读：
//   200 → 用户是对的，补全工具表就是解法，bridge 不必要
//   502 → 形状与身份都过了，是超窗（同样是「不是身份问题」的证据）
//   429 → 同一份工具表，真客户端 200 而我们 429，身份判定成立
//
// 用法：node scripts/probe-host-tools.mjs [host_tools.json]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const TOOLS = JSON.parse(fs.readFileSync(process.argv[2] ?? 'host_tools.json', 'utf8'))
const SESSION = process.env.PROBE_SESSION ?? realSession()

function realSession() {
  try {
    const db = new DatabaseSync(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readOnly: true })
    const row = db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get()
    db.close()
    return row?.id
  } catch (err) {
    console.log('会话读取失败:', err?.message ?? err)
    return undefined
  }
}

// 宿主格式 → 线上格式。这正是 lib/provider.js 的 serializeTools 做的事，
// 探针漏这层会造出上游 400 假象（记忆第 14 条）。
const wireTools = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
}))

const payload = JSON.stringify({
  model: process.env.PROBE_MODEL ?? 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 4096,
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true },
  tools: wireTools,
})

console.log(`工具数 ${wireTools.length}，body ${payload.length} 字节，会话 ${SESSION ?? '(无)'}`)

const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer public',
    'User-Agent': 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    ...(SESSION ? { 'x-opencode-session': SESSION, 'x-opencode-session-id': SESSION } : {}),
    'x-opencode-client': 'cli',
  },
  body: payload,
  signal: AbortSignal.timeout(120000),
})
const text = await res.text()
const tag = /FreeUsageLimitError/.test(text) ? '[429 伪装限流]'
  : /within OpenCode/.test(text) ? '[403 闸门]'
    : /exceeds the model window|futile round/.test(text) ? '[502 超窗 ⇒ 身份已过]'
      : res.ok ? '[200 成功]' : '[其它]'
console.log(`HTTP ${res.status} ${tag}`)
console.log('retry-after:', res.headers.get('retry-after'))
console.log(text.slice(0, 300).replace(/\n/g, ' '))
