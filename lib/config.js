// dsh-connect-opencode-free · runtime Config schema (Host only).
//
// Every field is volatile, so the browser settings page writes them straight
// into the profile patch and the Host picks each change up live through
// `loader/volatile-update`. Nothing here needs a restart — which is why the
// schema lives apart from core.js: the browser bundle inlines core.js and has
// no schemastery on its module table.

import z from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS, DEFAULT_BRIDGE_PORT, QUOTA_POLICY } from './core.js'
import { CATALOG_URL, ZEN_BASE_URL } from './discovery.js'

/** One model the operator configured by hand instead of taking from discovery. */
export const manualModel = z.object({
  id: z.string().required().description('OpenCode Zen 模型 id'),
  name: z.string().default('').description('显示名；留空显示 id'),
  contextWindow: z.number().step(1).min(1_000).max(10_000_000)
    .default(CONFIG_DEFAULTS.defaultContextWindow)
    .description('上下文长度（tokens）'),
})

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('总开关；关闭后所有免费模型从模型选择器撤下')
    .volatile(),

  // ---- discovery ----
  zenBaseURL: z.string().default(ZEN_BASE_URL)
    .description('OpenCode Zen 接口根地址（模型列表与对话都走这里）')
    .volatile(),
  catalogURL: z.string().default(CATALOG_URL)
    .description('models.dev 目录地址，用来判定哪些模型免费、上下文多大')
    .volatile(),
  autoSync: z.boolean().default(true)
    .description('持续刷新模型目录；关闭后冻结，直到手动同步')
    .volatile(),
  pollIntervalMs: z.number().step(1).min(60_000).max(86_400_000).default(3_600_000)
    .description('目录刷新间隔（毫秒）')
    .volatile(),
  catalogTimeoutMs: z.number().step(1).min(1000).max(120_000).default(20_000)
    .description('目录请求超时（毫秒）')
    .volatile(),
  includeDeprecated: z.boolean().default(false)
    .description('列出 models.dev 标记为已弃用的免费模型并提供服务（Zen 已下架的仍会标记为不可用）')
    .volatile(),
  // The page has no other way to ask the Host to re-read its sources, so it
  // stamps a fresh value here; the Host reacts to the change, not the number.
  syncToken: z.number().step(1).min(0).default(0)
    .description('设置页点「立即同步」时写入，宿主据此重新发现模型')
    .volatile(),

  // ---- credentials ----
  // Keys are typed straight into the settings page and exported to the process
  // environment under generated names. Asking the operator to set an
  // environment variable themselves — and to restart the process so it is
  // picked up — made "add a key" a support question, and a key the process
  // never saw read as "no key", which is indistinguishable from "not
  // configured" when the verify button silently stays disabled.
  apiKeys: z.array(z.string()).default([])
    .description('私有额度 Key，逐条填写即可；保存后自动按 OPENCODE_API_KEY、OPENCODE_API_KEY_1… 写入进程环境变量')
    .volatile(),
  // The manual escape hatch, for a deployment that manages its own secrets.
  // Only consulted when `apiKeys` is empty, so the two never disagree about
  // which key a request spends.
  apiKeyEnv: z.string().default('')
    .description('高级：已有环境变量名（逗号分隔轮换），先查凭据库再查环境变量；留空则由上面的 Key 列表自动生成')
    .volatile(),
  // Which lane a request may spend. `publicOnly` is the default and needs no
  // key; the other two are only honoured once a configured key has been
  // accepted by Zen (see `effectiveQuotaPolicy`), so a broken credential can
  // never flip the plugin onto a lane that then fails every request.
  quotaPolicy: z.union([
    z.const(QUOTA_POLICY.PUBLIC_ONLY),
    z.const(QUOTA_POLICY.PREFER_PUBLIC),
    z.const(QUOTA_POLICY.PREFER_KEY),
  ]).default(QUOTA_POLICY.PUBLIC_ONLY)
    .description('使用规则：publicOnly 仅用公共额度（默认）；preferPublic 优先公共、被拒时回退私有；preferKey 优先私有、失败时回退公共。后两者需先通过 Key 校验')
    .volatile(),
  // A 502 from Zen's gateway is an upstream connect timeout: the model is fine
  // and the body is fine, the route to the provider was not. Retrying is the
  // whole fix, so the default is deliberately patient — ten attempts, with the
  // backoff step capped so the tail does not stretch into minutes.
  maxRequestAttempts: z.number().step(1).min(1).max(20).default(10)
    .description('单次请求最多尝试几次；429/5xx（含 Zen 网关 502）会退避重试，默认 10 次')
    .volatile(),
  retryBackoffMs: z.number().step(1).min(100).max(30_000).default(800)
    .description('重试初始退避（毫秒），按次数指数增长，单次最长 8 秒')
    .volatile(),

  // ---- gateway gate tools ----
  // Zen's free-tier gate only passes when the request body advertises tools
  // named `bash` and `read`. Advertising names that do nothing is worse than
  // not advertising them: the model reaches for them, the call is dropped, and
  // the turn derails. Registering real ones makes the names honest — which is
  // what OpenCode does, and why the same model behaves well there.
  realGateTools: z.boolean().default(true)
    .description('把网关要求的 bash/read 注册成真实可用工具（关闭后它们只是占位，模型调用会被忽略）')
    .volatile(),

  // ---- transport ----
  // ⚠️ 2026-10-18 修正：这段曾经写着「免费档只服务 OpenCode 客户端自己发出的请求」，
  // 并因此默认开启了 bridge。**那个结论是错的**——它建立在一次没有控制「额度随时间
  // 消耗」这个变量的对照上：客户端那次 200 消耗掉了最后的额度，紧接着的探针自然 429，
  // 于是「额度刚好用完」被误读成「发出者不被承认」。
  //
  // 同一份报文、同一模型、同一会话，停手一段时间后直连连打 8 次全部 200
  // （scripts/probe-rate-limit.mjs）。429 就是额度/速率，与发出者无关。
  //
  // 所以默认 `off`：插件直连，不启动任何外部进程。bridge 保留为手动选项——万一
  // 将来真的出现「客户端能过、插件不能」的情形，再打开它，代价是宿主工具要走文本协议。
  bridgeMode: z.union([z.const('off'), z.const('auto'), z.const('on')]).default('off')
    .description('出网方式：off（默认）插件直连；auto 直连被拒后改由本机 OpenCode 客户端代发；on 总是代发。后两者需要本机装有 OpenCode，且宿主工具会改走文本协议')
    .volatile(),

  // ---- model shaping ----
  defaultContextWindow: z.number().step(1).min(1_000).max(10_000_000)
    .default(CONFIG_DEFAULTS.defaultContextWindow)
    .description('目录未给出大小时的兜底上下文长度')
    .volatile(),
  disabledModels: z.array(z.string()).default([])
    .description('停用的模型 id；下一次同步不会把它们加回来')
    .volatile(),
  manualModels: z.array(manualModel).default([])
    .description('手动添加的模型，用于目录未收录的 id')
    .volatile(),

  // ---- settings-page bridge ----
  bridgePort: z.number().step(1).min(1024).max(65_535).default(DEFAULT_BRIDGE_PORT)
    .description('设置页读取模型目录的本机端口；被占用时自动向后顺延')
    .volatile(),

  cachePath: z.string().default('')
    .description('模型目录缓存文件；留空则用 DSH_HOME 下的默认位置')
    .volatile(),
  // Resolved by the bundle patch with `!!js dshHomePath('cache')` rather than by
  // walking the install path: a profile links the bundle into a source checkout
  // and Node resolves that to the real path, so counting parents lands outside
  // the Harness home. Not volatile — it is a fact about the machine, not a
  // setting, so the page must not offer it for editing.
  cacheDir: z.string().default('')
    .description('DSH 缓存目录，由 bundle 注入 dshHomePath 得出'),
  debug: z.boolean().default(false)
    .description('宿主输出详细日志')
    .volatile(),
})
