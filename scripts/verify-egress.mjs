// 出网通道自检（2026-10-27）。
//
// 只发 GET /zen/v1/models：它不消耗免费额度，但足以验证整条链路——
//   运行时发现 → 子进程握手 → Bun 转发 → 响应回传。
//
// 用法：
//   node scripts/verify-egress.mjs          # 只验证通道本身（不消耗额度）
//   node scripts/verify-egress.mjs --chat   # 再打一次真实对话（消耗少量免费额度）
// 退出码：0 正常；1 找不到 Bun 或转发失败（此时插件会回退直连并 429）。
import { egressFetch, resolveRuntime, shutdownEgress } from '../lib/zen-egress.js'
import { opencodeSystemPrompt, promptVersion, withOpencodePrompt } from '../lib/zen-prompt.js'

console.log('运行时：', resolveRuntime()?.label ?? '未找到')
console.log('提示词快照：', promptVersion())

// 注入逻辑的自检：一条 system、原文在开头、宿主内容在后。
const injected = withOpencodePrompt([
  { role: 'system', content: 'HOST SYSTEM MARKER' },
  { role: 'user', content: 'hi' },
])
const prompt = opencodeSystemPrompt()
const system = injected.find((m) => m.role === 'system')
const checks = [
  ['只保留一条 system', injected.filter((m) => m.role === 'system').length === 1],
  ['原文完整在前', system?.content.startsWith(prompt.slice(0, 100)) === true],
  ['完整包含原文', system?.content.includes(prompt) === true],
  ['宿主 system 在后', (system?.content.lastIndexOf('HOST SYSTEM MARKER') ?? -1) > prompt.length - 1],
  ['重复注入不叠加', withOpencodePrompt(injected) === injected],
]
for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`)

let failed = checks.some(([, ok]) => !ok)

try {
  const res = await egressFetch('https://opencode.ai/zen/v1/models', { method: 'GET' })
  console.log('\n经转发器 GET /zen/v1/models → status=%s', res.status)
  if (res.ok) {
    const json = await res.json()
    const list = json.data ?? json
    console.log('  模型数：', Array.isArray(list) ? list.length : '未知')
  } else {
    console.log('  响应：', (await res.text()).slice(0, 200))
    failed = true
  }
} catch (error) {
  console.log('\n转发失败：', error?.message ?? error)
  failed = true
} finally {
  shutdownEgress()
}

// `--chat`：额度恢复之后用它确认「双因子」都到位了。
// 只发一条极短对话，system 用注入后的完整形态（原文在前 + 说明在后）。
if (process.argv.includes('--chat')) {
  const { DatabaseSync } = await import('node:sqlite')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  let session
  try {
    const db = new DatabaseSync(join(homedir(), '.local/share/opencode/opencode.db'), { readOnly: true })
    session = db.prepare('SELECT id, project_id FROM session_v2 ORDER BY time_created DESC LIMIT 1').get()
    db.close()
  } catch (error) {
    console.log('\n读不到 OpenCode 会话库，跳过 --chat：', error?.message ?? error)
    session = undefined
  }
  if (session) {
    const wire = withOpencodePrompt([
      { role: 'system', content: 'reply concisely.' },
      { role: 'user', content: 'reply with exactly: OK' },
    ])
    try {
      const res = await egressFetch('https://opencode.ai/inference/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: 'Bearer public',
          'content-type': 'application/json',
          'user-agent': 'opencode/latest/2.1.4/cli',
          accept: '*/*',
          'x-opencode-client': 'cli',
          'x-opencode-project': session.project_id,
          'x-opencode-session': session.id,
          'x-opencode-session-id': session.id,
          'x-session-affinity': session.id,
          'x-session-id': session.id,
        },
        body: JSON.stringify({
          model: process.env.PROBE_MODEL || 'deepseek-v4.1-flash-free',
          messages: wire,
          tools: [
            { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
            { type: 'function', function: { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
          ],
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 32000,
        }),
      })
      const text = await res.text()
      console.log('\n真实对话 → status=%s %s', res.status, res.status === 200 ? '✅ 放行' : text.replace(/\s+/g, ' ').slice(0, 140))
      if (res.status !== 200) failed = true
    } catch (error) {
      console.log('\n真实对话失败：', error?.message ?? error)
      failed = true
    } finally {
      shutdownEgress()
    }
  }
}

process.exit(failed ? 1 : 0)
