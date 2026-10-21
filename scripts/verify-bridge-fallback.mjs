// 集成验证：真实 adapter、真实 Zen、真实 OpenCode 客户端，走完整的自动回退路径。
//
// 这一条把「根因」和「修复」缝在一起验证：
//   1. adapter 照常直连 https://opencode.ai/zen/v1 —— 必然拿到 429（身份不被承认）
//   2. 429 触发 bridge 转向
//   3. 本机 OpenCode 客户端代发同一轮 —— 应当 200 并把正文交给宿主
//
// 只有第 1 步真的失败、第 3 步真的成功，才说明修复有效；任何一步被 mock 掉，
// 这条验证就没有意义。
//
// 运行：node scripts/verify-bridge-fallback.mjs [模型 id]

import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { OpenCodeBridge } from '../lib/oc-bridge.js'
import { OpenCodeFreeAdapter } from '../lib/provider.js'

const MODEL = process.argv[2] ?? 'mimo-v2.6-flash-free'

/**
 * 从本机 OpenCode 会话库取一条真实会话 id。
 *
 * 闸门那一关要的就是「OpenCode 真实创建过」的会话，所以这里必须是真读，不能编。
 */
function realSession() {
  try {
    const db = new DatabaseSync(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readOnly: true })
    const row = db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get()
    db.close()
    return row?.id
  } catch {
    return undefined
  }
}

const sessionId = realSession()
console.log('使用会话:', sessionId ?? '(未读到；闸门会以 403 拒绝，不影响本验证的核心结论)')

const bridge = new OpenCodeBridge({ log: (line) => console.log('  ·', line) })
const adapter = new OpenCodeFreeAdapter(null, { enabled: () => true }, {
  credentials: () => [],
  session: async () => ({ id: sessionId ?? 'ses_ab12cd34ef56gh78ij90kl12mn', source: 'verify' }),
  // 一轮就够：这里验证的是「429 之后会不会转向」，不是重试循环。
  maxAttempts: () => 1,
  backoffMs: () => 1,
  bridgeMode: () => 'auto',
  bridge: () => bridge,
})
adapter.setModels([{ id: MODEL, name: MODEL }])

// 记下直连到底拿到了什么 —— 必须真的是 429，否则这条验证什么也没证明。
let directStatus = null
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const res = await originalFetch(url, init)
  if (String(url).includes('opencode.ai/zen/v1')) directStatus = res.status
  return res
}

let text = ''
let error
try {
  for await (const chunk of adapter.stream({
    model: MODEL,
    system: 'Reply with exactly: OK',
    messages: [{ role: 'user', content: 'ping' }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
} catch (err) {
  error = err
} finally {
  globalThis.fetch = originalFetch
  bridge.dispose()
}

console.log('直连状态码:', directStatus)
console.log('最终正文:', JSON.stringify(text.slice(0, 60)))
if (error) console.log('错误:', error.message)

const ok = directStatus === 429 && !error && text.trim().length > 0
console.log(ok
  ? '\nPASS  直连 429 → 自动改由本机客户端代发 → 成功拿到正文'
  : `\nFAIL  直连=${directStatus} 错误=${error?.message ?? '无'} 正文=${text.length} 字`)
process.exit(ok ? 0 : 1)
