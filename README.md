# dsh-connect-opencode-free

把 **OpenCode Zen** 的免费模型接进 **DeepSeek Harness**：实时发现官方免费档模型，在设置里逐个启停，一键写入 provider。**免 key**，认证固定为 `Bearer public`。

> OpenCode Zen 是第三方公开服务，其可用性、模型清单与限流策略由其运营方决定。本插件只是客户端适配层。

## 功能

- **免 key 接入 OpenCode Zen 免费档**：匿名通道复用公开额度，认证固定为 `Bearer public`；为通过免费档校验，适配器会伪装成 OpenCode CLI（特定的 `User-Agent`、`x-opencode-session` 会话 id，以及 `bash`/`read` 工具名）。
- **`bash`/`read` 是真工具，不是占位**：免费档网关要求请求里必须出现 `bash` 与 `read` 两个名字，只挂名字不实现会让模型去调一个永远无法执行的工具、整轮被带偏（这正是同一模型在 OpenCode 里流畅、走本插件却报错的原因）。因此插件把这两个名字注册成**真实可执行**的工具（见 `lib/gate-tools.js`）。
- **双源模型发现**：实时合并 `opencode.ai/zen/v1/models`（此刻真实存在哪些 id）与 `models.dev/api.json` 的 `opencode` 段（哪些免费、上下文多大、支持什么能力），任一源不可达仍沿用上次结论，一次网络抖动不会让模型凭空消失。
- **设置页一键管理**：搜索、逐个启停、全部启用/停用、限流状态与恢复时间一目了然。
- **一键写入 provider**：把当前免费模型列表写入 `llm-pi-ai.providers.opencode-zen`（也支持移除与手动补模型）。
- **额度与重试**：429 区分「公共额度」与「自有账号」记账、Key 轮换、退避重试。
- **流式健壮性**：工具调用块边界、推理档位、结束原因兜底；以及 wire 边界的防御——工具结果按 `role:tool` 序列化、空 `arguments` 归一为 `{}`、压缩/续接后孤立的工具结果改标为 `user` 而不发非法请求。

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 共享纯逻辑 | `lib/core.js` | 模型集合合并、provider 条目生成、命名空间解析。无依赖，宿主与浏览器共用 |
| 运行时配置 | `lib/config.js` | schemastery Config，除缓存目录外全部 `volatile` |
| 模型发现 | `lib/discovery.js` | 合并 `opencode.ai/zen/v1/models` 与 `models.dev/api.json` |
| 额度与密钥 | `lib/quota.js` | 429 记账与恢复时间估算、密钥解析（凭据库优先、环境变量兜底）、缓存读写 |
| 宿主 | `lib/index.js` | 注册 `opencode-free` 路由、周期发现、目录缓存、本机目录桥 |
| 适配器 | `lib/provider.js` | 免 key 的 OpenAI 兼容 adapter：流式块边界、工具调用、推理档位、退避重试 |
| 浏览器 | `src/client.js` | React 设置页，注册进 `settings.section` 槽位 |

浏览器半边的产物 `lib/client.cjs` 由 `scripts/build.mjs` 从 `lib/core.js` + `src/client.js` 生成 —— 客户端模块系统的 `require` 只能解析包名和平台种子词，无法解析相对路径，所以共享逻辑必须内联。构建脚本还会拒绝任何未被内联的相对 import。

## 安装

本插件是一个 DSH **cordis 插件包（bundle）**，通过 profile 的 `package.json` 接入；在开发态用源码软链即可运行，无需先发布。

1. 进入目标 profile 目录（例如 `E:/UserAgentData/.dsh/profiles/web`）。
2. 在 `package.json` 的 `dsh.profile.bundles` 数组里加入包名：
   ```json
   "dsh-connect-opencode-free"
   ```
3. 在同文件 `dependencies` 中登记依赖。开发态用 `link:` 指向本仓库源码：
   ```json
   "dsh-connect-opencode-free": "link:D:/ClaudeCode/deepseek-harness/plugins/dsh-connect-opencode-free"
   ```
   若要安装发布版，则写版本范围，例如 `"^0.2.0"`。
4. 在该 profile 目录执行安装（会重新解析软链并应用 `cordis.patch.yml`）：
   ```sh
   pnpm install
   ```
5. 启动对应 profile（如 `dsh web`），打开「设置 → OpenCode 免费模型」即可使用。

依赖要求：Node ≥ 18，且宿主提供 `@deepseek-ai/dsh-llm`（peer 范围 `>=0.1.7-rc.1 <0.3.0`）。`cordis.patch.yml` 由 `package.json` 的 `dsh.bundle.patch` 自动加载，无需手动处理。

> 提示：宿主半边的 `lib/` 为源码，`lib/client.cjs` 是 `npm run build` 生成的浏览器半边产物；若该 bundle 需要随仓库分发，请确保已执行构建（或仅在此开发树内 `link` 使用）。

## 模型发现

目录由两个数据源合并，任一单独都不够：

- `https://opencode.ai/zen/v1/models` —— 哪些 id **此刻真的存在**；
- `https://models.dev/api.json` 的 `opencode` 段 —— 哪些**免费**、上下文多大、支持什么能力。

免费与否由 models.dev 决定（`cost` 全 0），供应与否由 Zen 决定。一个源不可达时沿用上次的判断（冷启动则按免费目录推定并在设置页注明），因此一次网络抖动不会让模型凭空消失。目录缓存写在 `<DSH_HOME>/cache/opencode-zen-catalog.json`。

Zen 的模型接口不返回 `Access-Control-Allow-Origin`，浏览器读不到，所以发现动作在宿主完成，再由一个仅监听 `127.0.0.1` 的目录桥交给设置页（端口可配，被占用时自动顺延，响应带标记头并通过 `Access-Control-Expose-Headers` 暴露）。

## 请求

- **块边界**：上游只发扁平 delta，从不声明块的起止，所以边界由适配器决定——任何时刻只开一块：思考一旦有正文就闭合，工具一开始就把思考与正文都闭合。三个 token 计数互斥：缓存命中从输入里扣除，推理 token 单列。
- **结束原因**：网关经常不给 `finish_reason`（工具调用帧尤其如此），缺省时按这一轮是否产出过工具调用判定。
- **推理档位**：目录标为 `reasoning` 的模型声明 `off/low/high/max` 四档，选择器据此提供选项，显式指定的档位才不会被 llm 服务以 `UNSUPPORTED_REASONING_EFFORT` 拒绝；`off` 用省略字段表示，因为 Zen 不接受该取值。不设默认档，保留 Zen 自己的默认。
- **密钥顺序**：`apiKeyEnv` 的每个名字先查 Harness 凭据库（设置里保存的 key 在这里，不在环境变量里），再查进程环境；两者都没有则用公共额度。
- **失败提示**：429 区分「公共额度」与「自有账号」，401/403 说明是凭据被拒还是没给，并给出下一步（去哪取 key、检查哪个账号），而不是只抛一个状态码。

## 设置

打开「设置 → OpenCode 免费模型」。所有字段 `volatile`，改完立即生效，不需要重启。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后所有免费模型撤下 |
| `zenBaseURL` | `https://opencode.ai/zen/v1` | Zen 接口根 |
| `catalogURL` | `https://models.dev/api.json` | 模型目录 |
| `autoSync` | `true` | 持续发现 |
| `pollIntervalMs` | `3600000` | 发现间隔 |
| `catalogTimeoutMs` | `20000` | 目录请求超时 |
| `includeDeprecated` | `false` | 在设置页列出 models.dev 已弃用的免费模型，勾选后一并服务（Zen 已下架的仍标记为不可用） |
| `apiKeyEnv` | `OPENCODE_API_KEY` | 密钥名，逗号分隔轮换，先查凭据库再查环境变量；留空用公共额度 |
| `maxRequestAttempts` | `3` | 单次请求最多尝试次数 |
| `retryBackoffMs` | `800` | 重试初始退避，按次数指数增长 |
| `defaultContextWindow` | `200000` | 目录未给大小时的兜底 |
| `realGateTools` | `true` | 把网关要求的 `bash`/`read` 注册成真实可执行工具；关闭后它们只是占位，模型调用会被忽略并提示（**即时生效**，无需重启） |
| `disabledModels` | `[]` | 停用的模型 id |
| `manualModels` | `[]` | 手动添加的模型 |
| `bridgePort` | `18766` | 目录桥端口 |
| `cachePath` | `''` | 缓存文件；留空用 `<DSH_HOME>/cache/` |
| `debug` | `false` | 宿主输出详细日志 |

页面提供：搜索、逐个启停、全部启用/停用、一键写入 `llm-pi-ai.providers.opencode-zen`、移除 provider、手动添加模型、以及免费额度的限流状态与恢复时间。

## 兼容性

浏览器半边的 `inject` 只有 `['slots', 'locale']` —— 这两个服务在任何 Host 版本上都存在。设置服务 `configForms` 通过 `ctx.get()` 软探测：Cordis 的依赖门是硬性的，声明一个当前 Host 没有提供的服务会让 `apply` 永不执行，页面直接消失。

> 早期版本曾 `inject` 已下线的 `settingsScope`，导致浏览器条目永远 `pending`，`dsh web` 以 `1 entry did not activate` 启动失败。现在已改用 `configForms`（profile-backed forms）。

## 开发

```sh
npm run build    # 生成 lib/client.cjs
npm run verify   # 校验产物是否最新
npm test         # 单元测试
```

## 致谢

机制参考 [randomix777/dsh-opencode-zen](https://github.com/randomix777/dsh-opencode-zen)（双源发现、持久缓存、限流记账、流式块边界与失败提示、凭据库取 key）与 [xiaozhe7772222/dsh-opencode-zen](https://github.com/xiaozhe7772222/dsh-opencode-zen)（429/5xx 退避、Key 轮换、推理档位），均为 MIT。

## 许可证

MIT
