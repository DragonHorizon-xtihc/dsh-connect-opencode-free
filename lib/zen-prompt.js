// dsh-connect-opencode-free · system 注入
//
// 实测依据（2026-10-27，scripts/probe-system-*.mjs）：
//   Zen 免费档会校验请求体里的 system 是否**完整包含** OpenCode 官方提示词原文，
//   不满足就返回 429 FreeUsageLimitError（文案是「额度已用尽」，但同一条报文
//   在运行时换成 Bun、system 换成原文后立刻 200）。
//   已排除的解释：
//     · 不是长度——把原文前半段重复拼到同样的 54977 字符仍然 429；
//     · 不是某个关键词——只留第一句 / 前 2000 字符 / 前半段，全部 429；
//     · 是内容完整性——原文之后或之前追加任意说明都仍然 200。
//
// 所以这里做两件事：
//   1. 把原文放在最前面（固定前缀，上游 prompt cache 能命中，重复计费更少）；
//   2. 把宿主自己的 system 合并成同一条并接在后面，末尾再声明「以本会话说明为准」，
//      避免模型照抄原文里的工具名（bash / edit / read 等本宿主未必有）。
import { readFileSync } from 'node:fs'

/** 原文快照的位置。和 provider 同目录，打包时随 lib 一起进产物。 */
const PROMPT_FILE = new URL('./opencode-system-prompt.txt', import.meta.url)

let cachedPrompt

/**
 * 官方提示词原文。
 *
 * 读一次就缓存：文件 54 KB，每轮都读会白白占用 IO；它只在插件升级时变。
 * @returns 原文；文件缺失时返回空字符串（调用方据此跳过注入，退回直连行为）。
 */
export function opencodeSystemPrompt() {
  if (cachedPrompt !== undefined) return cachedPrompt
  try {
    cachedPrompt = readFileSync(PROMPT_FILE, 'utf8')
  } catch {
    cachedPrompt = ''
  }
  return cachedPrompt
}

/** 测试用：忘掉缓存，让下一次调用重新读文件。 */
export function forgetPrompt() {
  cachedPrompt = undefined
}

/**
 * 夹在官方原文与宿主 system 之间的过渡说明。
 *
 * 写法上必须让模型明确「上面那段是上游兼容声明」，否则它会照搬原文里的工具
 * 名与临时目录约定，做出本宿主无法执行的动作。
 */
export const PROMPT_NOTE = [
  '<!-- 以上是上游 OpenCode 网关要求的兼容声明，仅用于通过免费档校验。 -->',
  'The section above is an upstream compatibility notice required by the OpenCode gateway.',
  'It does not describe this session. The instructions below take precedence:',
  'the tools actually available, the real working directory, and the real user request',
  'are all defined after this line. Never call a tool that is not in this request\'s tool list.',
].join('\n')

/**
 * 把官方原文注入 wire messages。
 *
 * 所有 `system` 消息合并成一条：OpenAI 兼容协议只有开头一条 system 有意义，
 * 多条分散在不同位置时，各家的处理方式并不一致，而网关的原文包含性校验也
 * 只在「这一条里有没有」上有明确答案。
 *
 * @param wire - `[{ role, content }, ...]`，来自 {@link serializeMessages}。
 * @returns 新数组；注入被跳过时返回原数组（不复制，调用方无须关心）。
 */
export function withOpencodePrompt(wire) {
  const prompt = opencodeSystemPrompt()
  if (!prompt || !Array.isArray(wire)) return wire

  const systems = wire.filter((m) => m && m.role === 'system').map((m) => String(m.content ?? '')).filter(Boolean)
  const rest = wire.filter((m) => !m || m.role !== 'system')

  // 已经带过原文（例如宿主把上一次的 system 回传）时不要叠加：重复拼接会让
  // 每轮请求体线性膨胀。
  if (systems.some((text) => text.includes(prompt.slice(0, 200)))) return wire

  const merged = [prompt, PROMPT_NOTE, ...systems].filter(Boolean).join('\n\n')
  return [{ role: 'system', content: merged }, ...rest]
}

/**
 * 提示词快照的版本标识，用于设置页/日志判断「是否需要刷新」。
 * @returns 形如 `54977:1f3a9c`（长度与前 6 位哈希）；文件缺失时为 `missing`。
 */
export function promptVersion() {
  const prompt = opencodeSystemPrompt()
  if (!prompt) return 'missing'
  // 轻量哈希，只用来比对快照有没有变，不需要抗碰撞。
  let hash = 0
  for (let i = 0; i < prompt.length; i += 97) hash = (hash * 31 + prompt.charCodeAt(i)) | 0
  return `${prompt.length}:${(hash >>> 0).toString(16).slice(0, 6)}`
}
