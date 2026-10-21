// 把 Node 的 TLS ClientHello 调成真实 OpenCode 客户端的样子，再打一次网关。
//
// 依据（probe-tls-fingerprint.mjs 抓到的事实）：
//   Node 22 默认          JA3 0bfaf0ce…  52 套件  11 扩展  ALPN 无
//   OpenCode 客户端       JA3 e97f5146…  17 套件  12 扩展  ALPN http/1.1
//
// 差分里最可疑的是 ALPN —— 客户端发 `http/1.1`，而 Node 的 tls.connect 默认
// **一个都不发**。一个「HTTP/1.1 客户端」的握手却不声明 ALPN，本身就是异常特征。
// 其次是密码套件集合（52 个 vs 17 个）与曲线集合。
//
// 这些都可通过 tls.connect 的 ciphers / ecdhCurve / ALPNProtocols / sigalgs 指定。
// 本探针逐档加，看哪一档让 429 消失。

import fs from 'node:fs'
import https from 'node:https'
import { DatabaseSync } from 'node:sqlite'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'

/** 客户端那 17 个套件的 OpenSSL 名称，顺序照抄。 */
const CLIENT_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':')

/** 客户端的签名算法（十六进制 → OpenSSL 名），顺序照抄。 */
const CLIENT_SIGALGS = [
  'ecdsa_secp256r1_sha256',      // 0x0403
  'rsa_pss_rsae_sha256',         // 0x0804
  'rsa_pkcs1_sha256',            // 0x0401
  'ecdsa_secp384r1_sha384',      // 0x0503
  'rsa_pss_rsae_sha384',         // 0x0805
  'rsa_pkcs1_sha384',            // 0x0501
  'rsa_pss_rsae_sha512',         // 0x0806
  'rsa_pkcs1_sha512',            // 0x0601
  'rsa_pss_pss_sha256',          // 0x0809
].join(':')

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })

function realSession() {
  try {
    const db = new DatabaseSync(`${process.env.USERPROFILE}/.local/share/opencode/opencode.db`, { readOnly: true })
    const row = db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get()
    db.close()
    return row?.id
  } catch {
    return null
  }
}

const sessionId = process.env.PROBE_SESSION ?? realSession()
const captured = process.argv[2] && fs.existsSync(process.argv[2]) ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : null
const body = typeof captured?.body === 'string' ? captured.body : JSON.stringify({
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 4096, stream: true, stream_options: { include_usage: true },
  tool_choice: 'auto', tools: [fn('bash'), fn('read')],
})

function headers() {
  return {
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
  }
}

function attempt(label, tlsOptions) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({ host: HOST, path: PATH, method: 'POST', headers: headers(), agent: false, timeout: 60000, ...tlsOptions }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        const tag = /FreeUsageLimitError/.test(text) ? '[429]'
          : /within OpenCode/.test(text) ? '[403]'
            : /exceeds the model window|futile round/.test(text) ? '[502 超窗 ⇒ 身份已过]'
              : res.statusCode === 200 ? '[200 成功]' : '[其它]'
        console.log(`${label.padEnd(34)} -> HTTP ${res.statusCode} ${tag}  (${Date.now() - t0}ms)`)
        resolve({ status: res.statusCode, tag, text })
      })
    })
    req.on('timeout', () => { req.destroy(); console.log(`${label.padEnd(34)} -> 超时`); resolve({}) })
    req.on('error', (e) => { console.log(`${label.padEnd(34)} -> ERR ${e.message}`); resolve({}) })
    req.end(body)
  })
}

console.log('session:', sessionId)
console.log('')

await attempt('0 基线（Node 默认握手）', {})
await attempt('1 只加 ALPN http/1.1', { ALPNProtocols: ['http/1.1'] })
await attempt('2 ALPN + 客户端密码套件', { ALPNProtocols: ['http/1.1'], ciphers: CLIENT_CIPHERS })
await attempt('3 ALPN + 套件 + 曲线', {
  ALPNProtocols: ['http/1.1'], ciphers: CLIENT_CIPHERS, ecdhCurve: 'X25519:P-256:P-384',
})
await attempt('4 全套（+ 签名算法）', {
  ALPNProtocols: ['http/1.1'], ciphers: CLIENT_CIPHERS, ecdhCurve: 'X25519:P-256:P-384', sigalgs: CLIENT_SIGALGS,
})
