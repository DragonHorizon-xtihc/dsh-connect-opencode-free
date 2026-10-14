# dsh-connect-opencode-free

把 **OpenCode Zen** 的免费模型接进 **DeepSeek Harness**：实时发现官方免费档模型，在设置里逐个启停，一键写入 provider。**免 key**，认证固定为 `Bearer public`。

> OpenCode Zen 是第三方公开服务，其可用性、模型清单与限流策略由其运营方决定。本插件只是客户端适配层。

## 功能

- **免 key 接入 OpenCode Zen 免费档**：匿名通道复用公开额度，认证固定为 `Bearer public`；为通过免费档校验，适配器会伪装成 OpenCode CLI（特定的 `User-Agent`、`x-opencode-session` 会话 id，以及 `bash`/`read` 工具名）。
- **`bash`/`read` 是真工具，不是占位**：免费档网关要求请求里必须出现 `bash` 与 `read` 两个名字，只挂名字不实现会让模型去调一个永远无法执行的工具、整轮被带偏（这正是同一模型在 OpenCode 里流畅、走本插件却报错的原因）。因此插件把这两个名字注册成**真实可执行**的工具（见 `lib/gate-tools.js`）。
- **双源模型发现**：实时合并 `opencode.ai/zen/v1/models`（此刻真实存在哪些 id）与 `models.dev/api.json` 的 `opencode` 段（哪些免费、上下文多大、支持什么能力），任一源不可达仍沿用上次结论，一次网络抖动不会让模型凭空消失。
- **设置页一键管理**：搜索、逐个启停、全部启用/停用、限流状态与恢复时间一目了然。
- **三档使用规则**：默认**仅使用公共额度**，配了 Key 也不动用；另外两档（公共优先 / 私有优先）需要先通过 Key 校验才能选用。详见[使用规则](#使用规则三档额度策略)。
- **一键写入 provider**：把当前免费模型列表写入 `llm-pi-ai.providers.opencode-zen`（也支持移除与手动补模型）。
- **额度与重试**：429 区分「公共额度」与「自有账号」记账、Key 轮换、退避重试。
- **流式健壮性**：工具调用块边界、推理档位、结束原因兜底；以及 wire 边界的防御——工具结果按 `role:tool` 序列化、空 `arguments` 归一为 `{}`、压缩/续接后孤立的工具结果改标为 `user` 而不发非法请求。

## 架构

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 共享纯逻辑 | `lib/core.js` | 模型集合合并、provider 条目生成、命名空间解析。无依赖，宿主与浏览器共用 |
| 运行时配置 | `lib/config.js` | schemastery Config，除缓存目录外全部 `volatile` |
| 模型发现 | `lib/discovery.js` | 合并 `opencode.ai/zen/v1/models` 与 `models.dev/api.json` |
| 额度与密钥 | `lib/quota.js` | 429 记账与恢复时间估算、密钥解析（凭据库优先、环境变量兜底）、公共通道冷却、缓存读写 |
| Key 校验 | `lib/keycheck.js` | 用一个最小请求证明 Key 被 Zen 接受；按指纹持久化，不存 Key 本身 |
| 宿主 | `lib/index.js` | 注册 `opencode-free` 路由、周期发现、目录缓存、本机目录桥 |
| 适配器 | `lib/provider.js` | 免 key 的 OpenAI 兼容 adapter：流式块边界、工具调用、推理档位、退避重试 |
| 浏览器 | `src/client.js` | React 设置页，注册进 `settings.section` 槽位 |

浏览器半边的产物 `lib/client.cjs` 由 `scripts/build.mjs` 从 `lib/core.js` + `src/client.js` 生成 —— 客户端模块系统的 `require` 只能解析包名和平台种子词，无法解析相对路径，所以共享逻辑必须内联。构建脚本还会拒绝任何未被内联的相对 import。

## 安装

本插件是一个 DSH **cordis 插件包（bundle）**，通过 profile 的 `package.json` 接入。

### 方式一：npm 安装（推荐）

1. 进入目标 profile 目录（如 `~/.dsh/profiles/<profile-name>`）。
2. 在 `package.json` 的 `dependencies` 加入：
   ```json
   "dsh-connect-opencode-free": "^0.3.0"
   ```
3. 在 `dsh.profile.bundles` 数组里加入包名：
   ```json
   "dsh-connect-opencode-free"
   ```
4. 执行安装：
   ```sh
   pnpm install
   ```
5. 启动对应 profile（如 `dsh web`），打开「设置 → OpenCode 免费模型」即可使用。

### 方式二：从源码运行（开发态）

1. clone 本仓库到本地。
2. 在 profile 的 `package.json` 中用 `link:` 指向源码绝对路径：
   ```json
   "dsh-connect-opencode-free": "link:/absolute/path/to/dsh-connect-opencode-free"
   ```
3. 同样在 `dsh.profile.bundles` 加入包名。
4. 执行 `pnpm install`，重启 dsh。

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
- **额度顺序**：由 `quotaPolicy` 决定（详见[使用规则](#使用规则三档额度策略)），默认 `publicOnly`——只用公共免费额度。每个 Key 名先查 Harness 凭据库（设置里保存的 key 在这里，不在环境变量里），再查进程环境。
- **失败提示**：429 区分「公共额度」与「自有账号」，401/403 说明是凭据被拒还是没给，并给出下一步（去哪取 key、检查哪个账号），而不是只抛一个状态码。两条额度都用尽时，报**第一个失败的 Key** 而不是最后一个——要修的是它。

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
| `apiKeyEnv` | `OPENCODE_API_KEY` | **私有额度**密钥的环境变量名，逗号分隔轮换，先查凭据库再查环境变量；是否动用由 `quotaPolicy` 决定 |
| `quotaPolicy` | `publicOnly` | 使用规则：`publicOnly` 仅用公共额度；`preferPublic` 公共优先、被拒时回退私有；`preferKey` 私有优先、失败时回退公共。后两者需先通过 Key 校验 |
| `maxRequestAttempts` | `3` | 单次请求最多尝试次数 |
| `retryBackoffMs` | `800` | 重试初始退避，按次数指数增长 |
| `defaultContextWindow` | `200000` | 目录未给大小时的兜底 |
| `realGateTools` | `true` | 把网关要求的 `bash`/`read` 注册成真实可执行工具；关闭后它们只是占位，模型调用会被忽略并提示（**即时生效**，无需重启） |
| `disabledModels` | `[]` | 停用的模型 id |
| `manualModels` | `[]` | 手动添加的模型 |
| `bridgePort` | `18766` | 目录桥端口 |
| `cachePath` | `''` | 缓存文件；留空用 `<DSH_HOME>/cache/` |
| `debug` | `false` | 宿主输出详细日志 |

页面提供：搜索、逐个启停、全部启用/停用、一键写入 `llm-pi-ai.providers.opencode-zen`、移除 provider、手动添加模型、公共额度的限流/被拒状态与恢复时间、三档使用规则选择，以及 Key 校验按钮与结果。

## 使用规则：三档额度策略

「设置 → OpenCode 免费模型」底部的 **使用规则** 决定一次调用可以花谁的额度。默认是 **仅使用公共额度**——本插件的意义是免 key，所以一个恰好躺在环境变量里的 Key 不会自动变成所有调用的计费对象。

| 规则 | 值 | 顺序 | 需要 Key 校验 |
| --- | --- | --- | --- |
| **仅使用公共额度** | `publicOnly` | 只用公共额度，配了 Key 也不动用 | 否（默认） |
| **优先使用公共额度** | `preferPublic` | 公共 → Key1 → Key2 → … | **是** |
| **优先使用私有额度** | `preferKey` | Key1 → Key2 → … → 公共 | **是** |

后两档必须**先通过 Key 校验**才可选用。校验方式是向 Zen 发一个最小请求，只问一个问题——「这个 Key 被接受了吗」。只有 401/403 算不通过；400（模型/参数问题）、429（该账号限流）都发生在鉴权之后，因此反而证明 Key 是真的。校验结果带 Key 的指纹持久化（不存 Key 本身），**换了 Key 自动失效**，需要重新校验。

> 未校验通过时选了后两档，Host 会按 `publicOnly` 处理并在日志里说明原因——设置页可能是旧的、只读的、被绕过的，所以这道闸门由 Host 把守，不靠 UI 自觉。

### 规则一：仅使用公共额度（默认）

```
第 1 次尝试：公共免费额度（Bearer public，免 key）
        └─ 成功 ──────► 返回
        └─ 失败 ──────► 报错，不动用任何 Key
```

429 与 5xx 仍会按退避重试公共额度（等待可能让额度恢复），但**永远不会**落到 Key 上。

### 规则二：优先使用公共额度

```
第 1 次尝试：公共免费额度
        ├─ 成功 ───────────────────────► 返回（不消耗任何 Key）
        ├─ 429 公共额度已用尽 ──────────► 回退到 Key
        ├─ 403 拒绝了匿名免费档调用 ────► 回退到 Key
        └─ 其它错误（400/401/404…）────► 直接失败，不动用 Key
```

1. **只有两种回答会解锁 Key**：`429` 和 `403 FreeTierError`。其它错误在付费通道上会以同样方式失败（例如模型 id 不存在），花你的额度重发一遍只买到同一个错误。
2. **已知关闭就不再空跑。** 公共额度被限流时记下恢复时间，被拒时记 10 分钟冷却；期间下一次调用直接从 Key 开始，省掉一次注定失败的往返。**窗口一过自动回到公共额度优先**，不需要任何操作。

### 规则三：优先使用私有额度

```
第 1 次尝试：Key1 → Key2 → … → 公共免费额度
```

只有 Key 说「我不能服务」时才交棒：`429`（该账号额度用尽）、`401`/`403`（Key 无效或被拒）。模型不存在之类的 400 同样不会回退——公共额度也会给出同一个错误。

### 三档共用的规则

- **多 Key 轮换。** `apiKeyEnv` 填多个环境变量名（逗号分隔）会轮换使用；只有真正动用到 Key 的请求才推进轮换起点，被公共额度服务的请求不会打乱它。
- **一轮就是预算。** 一次调用最多把当前规则序列里的凭据各试一次；此后只有可重试的错误（429/5xx）才值得再等一轮，避免在同一个答案上空转。
- **两条都失败时报 Key 的错误。** 公共额度不可用你已经知道了，需要修的是 Key；报错会带上出事的凭据名，多 Key 时不会被最后一个误导。

### 配置私有额度 Key

Key 是可选的。公共额度能用的时候不需要它。

1. 到 <https://opencode.ai/zen> 领取 Key。
2. 打开「设置 → OpenCode 免费模型」，在 **私有额度 Key（环境变量名）** 里填一个名字，默认 `OPENCODE_API_KEY`（多个用逗号分隔）。
3. 把 Key 的值放进这个环境变量，**或者**在宿主的凭据库里以同名保存（**优先查凭据库**，再查环境变量）。设置页保存的 Key 走凭据库，不会写进环境。
4. 点 **「校验 Key」**。通过后，后两档规则才变为可选；设置页会显示「已配置 N 个 Key · 当前规则：X」。

## 报错：OpenCode Zen 拒绝了匿名免费档调用（HTTP 403）

```
OpenCode Zen 拒绝了匿名免费档调用（HTTP 403 FreeTierError）：
OpenCode's free tier can only be used from within OpenCode. …
（本次请求：session 来源=cache，网关工具=bash+read 齐全，工具总数=247）
```

这句话的真实含义是：**网关没把这次请求认成 OpenCode CLI 发起的**。它同时放行必须满足三个条件，缺一个就 403：

| 条件 | 要求 | 本插件怎么满足 |
| --- | --- | --- |
| `User-Agent` | 以 `opencode/` 开头 | 匿名通道伪装成 CLI 的 UA |
| `x-opencode-session` | **OpenCode 真实创建过**的会话 id（`ses_` + 26 位） | 从本机 OpenCode 的 SQLite 会话库读取最近一条 |
| 请求体的 `tools` | 必须含 `bash` 和 `read` | 把这两个名字注册成真实可执行的工具 |

### 排查顺序

括号里的诊断行就是为此准备的——它直接说明这次请求到底带了什么，不用猜：

- **`session 来源=无`** → 本机读不到 OpenCode 会话库。跑一次 OpenCode CLI（例如 `opencode run "hi"`）让它生成会话，插件会自动复用；或者干脆[配置 Key](#配置私有额度-key)。
- **网关工具=只有 bash / 都缺** → `bash`/`read` 没注册上（宿主工具服务不可用，或 `realGateTools` 被关）。把 `realGateTools` 打开并重启 dsh。
- **三项全绿仍 403** → 检查 `User-Agent`。宿主会叠加自己的归因头（`deepseek-harness/…`），若它与伪装的 UA 大小写不一致，两者会同时出现在请求里并在传输层互相覆盖 —— 2026-10-13 修的就是这个（`lib/provider.js` 的 `assignHeader` 现在按大小写不敏感替换，不再依赖拼写一致）。
- **以上都正常** → 公共免费额度通道确实不可用（运营方调整、来源限流）。这时才轮到 Key：按[上面的步骤](#配置私有额度-key)配置并通过校验，再把使用规则改成「优先使用公共额度」，插件就会在 429/403 时自动切过去。

### 仍想只用公共额度

保持默认的「仅使用公共额度」即可——这正是默认值，不需要配 Key 也不需要额外操作。此时 429/403 就是终点，插件不会去找 Key。

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
