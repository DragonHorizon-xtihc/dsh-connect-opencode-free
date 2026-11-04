// dsh-connect-opencode-free · 运行时诊断日志
//
// 为什么需要：11-02 排查发现「同一份 lib 代码，在脚本里直接调用 200，由 dsh 进程
// 调用却 429」。差异只可能在宿主进程内的运行环境（全局 fetch、环境变量、注入是否
// 真的生效），而这类问题在日志之外没有任何线索——dsh 的 stdout 不一定留得下来。
//
// 每次请求追加一行 JSON，看到 429 时读这一行就能知道：走的是 Bun 转发还是回退直连、
// system 里到底有没有官方原文、请求打到哪个端点。**诊断失败绝不影响请求**。
//
// 文件：~/.dsh/cache/opencode-zen-diag.jsonl（尾部追加，保留最近的即可）
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.dsh', 'cache')
const FILE = join(DIR, 'opencode-zen-diag.jsonl')

/** 测试运行器里不写盘，避免单测把诊断文件刷满。 */
function inTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT)
}

/**
 * 追加一条诊断。
 * @param entry - 任意可 JSON 化的字段；`at` 会自动补上。
 */
export function diag(entry) {
  if (inTest()) return
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* 诊断永远不该影响一次请求 */
  }
}

/** 诊断文件位置，给自检脚本打印用。 */
export function diagPath() {
  return FILE
}
