// 对照探针：同一真实 session、同一 body、同一时刻，只改变头部集合。
// 目的：定位「CLI 能用免费额度、插件却 429」的请求侧差异。
//
// 背景（2026-10-18 逆向 E:\Programs\OpenCode\OpenCode.exe 内嵌 bundle 所得）：
// 真实客户端对 opencode 系 provider 发送的头部是：
//   x-opencode-session-id / x-opencode-session / x-opencode-project /
//   x-opencode-request(msg id) / x-opencode-client / User-Agent: opencode/<ver>
// 而插件只发 x-opencode-session 一个。
//
// 本探针逐组增减头部，观察网关判定的变化（状态码 + 全部响应头 + body）。

const BASE = 'https://opencode.ai/zen/v1'
const MODEL = process.env.PROBE_MODEL ?? 'big-pickle'
// 2026-10-18 00:10:38 由本机 OpenCode 真实创建的会话（CLI 侧已成功跑完，
// 插件从未用过它——插件只取库里最新一条，失败时最新的是 00:10:54 那条）。
const SESSION = process.env.PROBE_SESSION ?? 'ses_eb55ed479ffeNn2TADfgda0RAB'
const PROJECT = process.env.PROBE_PROJECT ?? '17c2c713b7bee7b3305512caa4c4ff1c34588a64'

const PLUGIN_UA = 'opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const CLI_UA = 'opencode/1.18.35' // 装机版 InstallationVersion

// msg_ + 26 字符（与真实消息 id 同形状：12 位十六进制时间戳 + 14 位 base62）
function mintMessageId() {
  const now = Date.now()
  const inverted = ~(BigInt(now) * 4096n + 1n)
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  ).join('')
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return 'msg_' + time + Array.from(bytes, (b) => chars[b % 62]).join('')
}

const fn = (name) => ({
  type: 'function',
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
  },
})

function body() {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 32,
    tools: [fn('bash'), fn('read')],
    tool_choice: 'auto',
  }
}

// 2026-10-18 00:38 补充：桌面版 spawn 本地 server 时设 OPENCODE_CLIENT=desktop
// （见 app.asar offset 102641333），即真实桌面请求带 x-opencode-client: desktop；
// 且两个探针 session 都是子代理会话（parent_id=ses_eb55fd518ffeMfJqeeMbd5lZVe），
// 真实客户端会额外发 x-opencode-parent-session-id。
const PARENT = 'ses_eb55fd518ffeMfJqeeMbd5lZVe'
const cases = {
  // A: 完整复刻真实客户端（逆向所得头部全集）
  'A full-cli-replica': {
    'User-Agent': CLI_UA,
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-opencode-project': PROJECT,
    'x-opencode-request': mintMessageId(),
    'x-opencode-client': 'cli',
    'x-session-affinity': SESSION,
    'X-Session-Id': SESSION,
  },
  // B: 完整复刻插件现状（只有 x-opencode-session + 长 UA）
  'B plugin-replica': {
    'User-Agent': PLUGIN_UA,
    'x-opencode-session': SESSION,
  },
  // C: A + 桌面版客户端标识
  'C plus-client-desktop': {
    'User-Agent': CLI_UA,
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-opencode-project': PROJECT,
    'x-opencode-request': mintMessageId(),
    'x-opencode-client': 'desktop',
    'x-session-affinity': SESSION,
    'X-Session-Id': SESSION,
  },
  // D: A + 父会话头
  'D plus-parent-session': {
    'User-Agent': CLI_UA,
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-opencode-parent-session-id': PARENT,
    'x-opencode-project': PROJECT,
    'x-opencode-request': mintMessageId(),
    'x-opencode-client': 'cli',
    'x-session-affinity': SESSION,
    'X-Session-Id': SESSION,
  },
  // E: A + 两者
  'E plus-both': {
    'User-Agent': CLI_UA,
    'x-opencode-session-id': SESSION,
    'x-opencode-session': SESSION,
    'x-opencode-parent-session-id': PARENT,
    'x-opencode-project': PROJECT,
    'x-opencode-request': mintMessageId(),
    'x-opencode-client': 'desktop',
    'x-session-affinity': SESSION,
    'X-Session-Id': SESSION,
  },
}

async function run(label, headers) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer public', ...headers },
    body: JSON.stringify(body()),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text().catch(() => '')
  const interesting = {}
  for (const [k, v] of res.headers) {
    if (/ratelimit|retry|limit|quota|x-/i.test(k)) interesting[k] = v
  }
  console.log(`\n### ${label} -> HTTP ${res.status}`)
  console.log('headers:', JSON.stringify(interesting, null, 1))
  console.log('body:', text.slice(0, 400).replace(/\n/g, ' '))
  return res.status
}

const only = process.argv[2]
for (const [label, headers] of Object.entries(cases)) {
  if (only && !label.startsWith(only)) continue
  try {
    await run(label, headers)
  } catch (e) {
    console.log(`\n### ${label} -> ERR ${e?.message ?? e}`)
  }
}
