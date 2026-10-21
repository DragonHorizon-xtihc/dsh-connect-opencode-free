// 用 Bun 精确复刻真实客户端的请求 —— 不启动 opencode。
//
// 依据：probe-tls-fingerprint 显示 Bun 与 OpenCode 客户端的 TLS 栈几乎同一套
// （同为 BoringSSL：17 个密码套件、曲线 29/23/24、签名算法逐项相同）。
//
// 三档，逐档加 ALPN：
//   A  Bun fetch（最省事，但它可能不发 ALPN）
//   B  Bun tls.connect 手工发 HTTP/1.1，带 ALPN http/1.1
//   C  B + 收窄 ciphers 到客户端那 17 个
//
// 用法：bun scripts/probe-bun-replay.js [sessionId]

import tls from 'node:tls'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'

const CLIENT_CIPHERS = 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA:AES256-SHA'

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })

function realSession() {
  // Bun 解析不了 node:sqlite，所以会话由调用方通过参数/环境传入。
  return process.env.PROBE_SESSION ?? null
}

const sessionId = process.argv[2] ?? process.env.PROBE_SESSION ?? realSession()
const body = JSON.stringify({
  model: process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 4096,
  stream: true,
  stream_options: { include_usage: true },
  tool_choice: 'auto',
  tools: [fn('bash'), fn('read')],
})

const HEADERS = () => ({
  authorization: 'Bearer public',
  'content-type': 'application/json',
  'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  'x-opencode-client': 'cli',
  'x-opencode-project': '17c2c713b7bee7b3305512caa4c4ff1c34588a64',
  'x-opencode-request': 'msg_14af12e0f001I2lVqU5iaRrBja',
  'x-opencode-session': sessionId,
  'x-opencode-session-id': sessionId,
  accept: '*/*',
  'accept-encoding': 'gzip, deflate, br, zstd',
})

function tag(status, text) {
  if (/FreeUsageLimitError/.test(text)) return '[429]'
  if (/within OpenCode/.test(text)) return '[403]'
  if (/exceeds the model window|futile round/.test(text)) return '[502 超窗 ⇒ 身份已过]'
  return status === 200 ? '[200 成功]' : '[其它]'
}

console.log('session:', sessionId, '\n')

// ---- A: Bun fetch ----
{
  const t0 = Date.now()
  try {
    const res = await fetch(`https://${HOST}${PATH}`, { method: 'POST', headers: HEADERS(), body })
    const text = await res.text()
    console.log(`A Bun fetch                          -> HTTP ${res.status} ${tag(res.status, text)} (${Date.now() - t0}ms)`)
  } catch (e) {
    console.log('A Bun fetch -> ERR', e.message)
  }
}

// ---- B/C: 手工发 HTTP/1.1，可控 ALPN 与 ciphers ----
function rawPost(label, tlsOptions) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const hs = HEADERS()
    let raw = `POST ${PATH} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(hs)) raw += `${k}: ${v}\r\n`
    raw += `host: ${HOST}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n`

    let settled = false
    const done = (msg) => { if (!settled) { settled = true; console.log(`${label.padEnd(36)} -> ${msg} (${Date.now() - t0}ms)`); resolve() } }

    const socket = tls.connect({ host: HOST, port: 443, servername: HOST, ...tlsOptions }, () => {
      socket.write(raw)
      socket.write(body)
    })
    socket.setTimeout(45000, () => { socket.destroy(); done('超时') })
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      if (!buf.includes('\r\n\r\n')) return
      const status = Number(buf.split(' ')[1])
      done(`HTTP ${status} ${tag(status, buf)}`)
      socket.destroy()
    })
    socket.on('error', (e) => done('ERR ' + e.message))
  })
}

await rawPost('B 手工 HTTP/1.1 + ALPN', { ALPNProtocols: ['http/1.1'] })
await rawPost('C B + 客户端密码套件', { ALPNProtocols: ['http/1.1'], ciphers: CLIENT_CIPHERS })
process.exit(0)
