# dsh-connect-opencode-free

把 **OpenCode Zen** 的免费模型接进 **DeepSeek Harness**：实时发现官方免费档模型，在设置里逐个启停，一键写入 provider。

> **出网只有一条路**：每一轮对话都由本机真实的 `opencode serve` 进程代发（下称 bridge）。插件自己不构造 HTTP 请求、不配置 Key、不做匿名认证。

> OpenCode Zen 是第三方公开服务，其可用性、模型清单与限流策略由其运营方决定。本插件只是适配层。

## 为什么只走 bridge

2026-11-06 的同一时刻对照实测：

| 出网方式 | 结果 |
| --- | --- |
| 本机真实 `opencode serve` 进程 | **200** |
| 插件直连（`Bearer public` / Node / Bun TLS 转发） | **一律 429 `FreeUsageLimitError`** |

逐项换过都救不回来：Bun 二进制（通用 bun 与 `opencode-cli.exe` 的 `BUN_BE_BUN=1`）、cli/desktop 全套请求头、JA3/JA4 TLS 指纹、伪造与真实 `x-opencode-session`、2 KB 无 tools 到 234 KB+ 的原报文、OpenCode 官方 system 提示词注入。结论是网关放行**真实客户端进程的连接态**，独立脚本复刻不出来。

两个被实测推翻的旧判断，不要再拿来做依据：

- 「429 = 公共池额度耗尽」——同一时刻 bridge 稳定 200，不是全局额度问题。
- 「234 KB+ 报文 / 工具表太大 / 13 小时冷却期」——bridge 发同样 234 KB+ 报文照样 200，直连发 2 KB 无 tools 照样 429。

因此直连代码（Bun 转发器、提示词注入、伪造会话、网关 shape gate、私有 Key 池与校验、三档使用规则）已全部删除。

## 功能

- **双源模型发现**：实时合并 `opencode.ai/zen/v1/models`（此刻真实存在哪些 id）与 `models.dev/api.json` 的 `opencode` 段（哪些免费、上下文多大、支持什么能力）；任一源不可达仍沿用上次结论，一次网络抖动不会让模型凭空消失。
- **设置页一键管理**：搜索、逐个启停、全部启用/停用、客户端免费档限流状态与恢复时间。
- **一键写入 provider**：把当前免费模型列表写入 `llm-pi-ai.providers.opencode-zen`（也支持移除与手动补模型）。
- **账户登录入口**：OAuth 设备流登录本机插件缓存；客户端自身的登录态决定可用到哪一档免费额度。
- **失败重试**：bridge 报错最多再试 3 次（指数退避、单次封顶 8 秒）；429 与上下文超窗不重试。
- **wire 边界防御**：工具结果按 `role:tool` 转录、空 `arguments` 归一为 `{}`、压缩/续接后孤立的工具结果改标为 `user`；超长历史裁剪时始终保留 system 与第一条 user。

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 共享纯逻辑 | `lib/core.js` | 模型集合合并、provider 条目生成、命名空间解析。无依赖，宿主与浏览器共用 |
| 运行时配置 | `lib/config.js` | schemastery Config，除缓存目录外全部 `volatile` |
| 模型发现 | `lib/discovery.js` | 合并 Zen 模型列表与 models.dev 目录 |
| 额度记账 | `lib/quota.js` | 客户端 429 的恢复窗口估算与持久化 |
| 可用性账本 | `lib/availability.js` | 上游永久故障的模型退役与恢复 |
| 宿主 | `lib/index.js` | 注册 `opencode-free` 路由、周期发现、目录缓存、本机目录桥、账户登录端点 |
| 适配器 | `lib/provider.js` | 唯一的请求路由：消息规范化 → bridge → 流式块/工具协议 |
| 客户端驱动 | `lib/oc-bridge.js` | 启动并复用 `opencode serve`，文本工具协议（`toolProtocolOf` / `parseProtocol` / `transcriptOf`） |
| 账户登录 | `lib/oc-account.js` | OAuth 设备流、token 存取、状态与登出（token 不参与对话请求） |
| 浏览器 | `src/client.js` | React 设置页，注册进 `settings.section` 槽位 |

浏览器半边的产物 `lib/client.cjs` 由 `scripts/build.mjs` 从 `lib/core.js` + `src/client.js` 生成 —— 客户端模块系统的 `require` 只能解析包名和平台种子词，无法解析相对路径，所以共享逻辑必须内联。构建脚本会拒绝任何未被内联的相对 import。

## 安装

本插件是 DSH 的 **cordis 插件包（bundle）**，通过 profile 的 `package.json` 接入。

### 方式一：npm 安装（推荐）

在目标 profile 目录（如 `~/.dsh/profiles/<profile-name>/package.json`）中：

1. 在 `dependencies` 加入：
   ```json
   "dsh-connect-opencode-free": "^0.5.3"
   ```
2. 在 `dsh.profile.bundles` 数组加入 `"dsh-connect-opencode-free"`。
3. 执行 `pnpm install`。
4. 重启 dsh，打开「设置 → OpenCode 免费模型」。

### 方式二：从源码运行（开发态）

把 `dependencies` 中的版本范围换成软链，其余步骤不变：

```json
"dsh-connect-opencode-free": "link:/absolute/path/to/<repo>"
```

> 占位符请替换为仓库的本机绝对路径。`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 自动加载，无需手动处理。

**运行前提**：宿主 Node ≥ 18（推荐 22+）、`@deepseek-ai/dsh-llm`，以及**本机装有 OpenCode 2.x** 且 `opencode` 可执行文件可被解析（PATH 或 npm 全局前缀；也可用 `OPENCODE_BIN` 显式指定）。没有可用的客户端时，请求会以 `BRIDGE_UNAVAILABLE` 失败。

`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 自动加载，无需手动处理。

## 模型发现

目录由两个数据源合并，任一单独都不够：

- `https://opencode.ai/zen/v1/models` —— 哪些 id **此刻真的存在**；
- `https://models.dev/api.json` 的 `opencode` 段 —— 哪些**免费**、上下文多大、支持什么能力。

免费与否由 models.dev 决定（`cost` 全 0），供应与否由 Zen 决定。一个源不可达时沿用上次的判断（冷启动则按免费目录推定并在设置页注明）。目录缓存写在 `<DSH_HOME>/cache/opencode-zen-catalog.json`。

Zen 的模型接口不返回 `Access-Control-Allow-Origin`，浏览器读不到，所以发现动作在宿主完成，再由一个仅监听 `127.0.0.1` 的目录桥交给设置页（端口可配，被占用时自动顺延，响应带标记头并通过 `Access-Control-Expose-Headers` 暴露）。

## 请求与路由

```
宿主 messages
  → serializeMessages / sanitizeWireMessages / trimMessages
  → transcriptOf(messages) 变成纯文本 prompt
  → OpenCodeBridge.turn({ model, system, prompt })
  → 本机 opencode serve 进程发出真正的 HTTP 请求
  → 解析文本回复（或 JSON 工具协议）→ 宿主流式块
```

- **认证与请求头**：全部由 OpenCode 客户端负责。插件不再注入官方提示词、UA、会话 id，也不携带任何凭据。
- **工具协议**：客户端自带的工具集必须留在报文里，所以宿主工具不能走原生 function-calling，改为在 `system` 里列出清单，约定模型以 JSON 回答 `{kind:"tool",name,args}` 或 `{kind:"final",text}`。解析失败时把原文原样发出，不静默丢轮。
- **重试**：bridge 抛错时最多再试 3 次，退避逐次翻倍、单次最长 8 秒；`RATE_LIMITED`/429 与 `CONTEXT_OVERFLOW` 直接失败（重发只会把冷却窗口推得更远或重复超窗）。最终错误会写明一共试了几次。
- **推理档位**：目录标为 `reasoning` 的模型声明 `off/low/high/max` 四档，选择器据此提供选项；`off` 用省略字段表示。
- **额度状态**：429 带 `retryAfterMs` 时由 `QuotaTracker.recordWait()` 记下恢复时间，设置页据此显示「预计何时回来」。

## 设置

打开「设置 → OpenCode 免费模型」。所有字段 `volatile`，改完立即生效，不需要重启。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后模型从选择器撤下且请求被拒 |
| `zenBaseURL` | `https://opencode.ai/zen/v1` | 仅用于读取模型列表，不影响对话 |
| `catalogURL` | models.dev 目录地址 | 免费判定与模型能力来源 |
| `autoSync` / `pollIntervalMs` / `catalogTimeoutMs` | `true` / 1 h / 20 s | 目录周期发现 |
| `includeDeprecated` | `false` | 是否列出已弃用/已下架的免费模型 |
| `syncToken` | `0` | 设置页点「立即同步」时写入 |
| `ocAccountEnabled` | `true` | 是否启用账户登录入口 |
| `retryBackoffMs` | `800` | bridge 失败重试的初始退避（重试次数固定 3 次） |
| `defaultContextWindow` | `200000` | 目录未给出大小时的兜底 |
| `manualModels` / `disabledModels` | `[]` | 手动补模型 / 停用模型 |
| `bridgePort` | `18766` | 设置页读取目录的本机端口，被占用时自动顺延 |
| `cachePath` / `cacheDir` | 空 | 目录缓存与插件缓存位置 |
| `debug` | `false` | 宿主详细日志 |

## 报错排查

### `BRIDGE_UNAVAILABLE` / 找不到 opencode

`OpenCodeBridge.resolveCommand()` 依次试 `OPENCODE_BIN`、PATH、npm 全局前缀。确认本机装了 OpenCode 2.x，且 `opencode serve` 能手工启动。启动失败会被记住一段时间，不会每轮重新 fork。

### 429 / 限流

这是**本机 OpenCode 客户端那一份免费额度**的窗口，不是插件的公共池。设置页会显示预计恢复时间。插件不会重试 429——重试只会把窗口推远。确认客户端自身可用（例如在 OpenCode 里发一句），以及账户是否已登录。

### 工具没被调用

bridge 模式下宿主工具走文本协议。检查设置页里该模型是否启用，以及模型是否按 `HOST TOOLS` 清单返回 JSON。免费档模型偶尔会在 JSON 外面裹一句散文，`parseProtocol()` 会从中截取对象；完全不成形时原文会当作普通回答显示。

### 设置页整页空白

浏览器半边 `inject` 只有 `['slots', 'locale']`，`configForms` 通过 `ctx.get()` 软探测。页面空白通常是渲染期异常（例如变量先读后声明）——`node scripts/tdz-scan.mjs` 与 `node scripts/smoke-page.mjs` 专门守这一类问题。改完 `src/client.js` 必须重新构建，见下。

## 兼容性

浏览器半边的 `inject` 只有 `['slots', 'locale']` —— 这两个服务在任何 Host 版本上都存在。设置服务 `configForms` 通过 `ctx.get()` 软探测：Cordis 的依赖门是硬性的，声明一个当前 Host 没有提供的服务会让 `apply` 永不执行，页面直接消失。

> 早期版本曾 `inject` 已下线的 `settingsScope`，导致浏览器条目永远 `pending`，`dsh web` 以 `1 entry did not activate` 启动失败。现在已改用 `configForms`。

## 开发

```sh
node scripts/build.mjs        # 生成 lib/client.cjs
node scripts/build.mjs --check # 校验产物是否最新
node scripts/tdz-scan.mjs      # 设置页 TDZ 静态扫描
node scripts/smoke-page.mjs    # 设置页渲染冒烟
node --test test/core.test.js  # 单元测试
```

> 本仓库在 monorepo 内 `npm` 可能报 `EDUPLICATEWORKSPACE`，直接用上面的 `node` 命令即可。

### 改设置页后必须重新构建，光重启无效

`lib/client.cjs` 是**生成产物**（`scripts/build.mjs` 把 `lib/core.js` + `src/client.js` 内联成浏览器工厂），浏览器加载的是它，不是 `src/client.js`。因此改完页面源码后：

1. `node scripts/build.mjs`；
2. 重启 `dsh web`；
3. 浏览器硬刷新（Ctrl+F5），否则拿到的是缓存里的旧工厂。

只重启进程、不重新构建，页面会继续表现旧代码的行为——包括旧缺陷。`tdz-scan.mjs` 静态扫描「先读后声明」的局部变量（这类错误 `node --check` 看不见，只会在渲染时抛 `ReferenceError` 表现为整页空白）；`smoke-page.mjs` 用 mock 的 `locale`/`slots`/`configForms` 驱动真实产物，在多种配置状态下渲染并核对翻译键齐全。

改宿主 `lib/*.js` 后必须**重启 dsh 进程**（ESM 缓存）；只改 `src/client.js`/`lib/core.js` 则还需重新构建。

## 致谢

机制参考 [randomix777/dsh-opencode-zen](https://github.com/randomix777/dsh-opencode-zen)（双源发现、持久缓存、限流记账）与 [xiaozhe7772222/dsh-opencode-zen](https://github.com/xiaozhe7772222/dsh-opencode-zen)（退避、推理档位），均为 MIT。

## 许可证

MIT
