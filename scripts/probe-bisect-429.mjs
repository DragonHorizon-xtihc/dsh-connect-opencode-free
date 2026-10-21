// 二分：到底是哪个变量让 429 消失的。
//
// 已知：https.request（干净头）+ 与 session 匹配的真实 msg id + mimo → 200。
// 变量候选：
//   1. 传输实现：https.request（只有我给的头） vs fetch（undici 自动加
//      accept-language / sec-fetch-mode: cors 等真实客户端从不发的头）
//   2. msg id：与本次 session 匹配的真实 msg vs 随便一个
//   3. 会话：客户端刚创建并使用过的 vs 库里随便一条
//
// 用法：node scripts/probe-bisect-429.mjs <session> <realMsgId>

import https from 'node:https'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const SESSION = process.argv[2]
const REAL_MSG = process.argv[3] ?? 'msg_14d4d6850001ETqpHUbdACPXr4'
const PROJECT = process.env.PROBE_PROJECT ?? '63520fb4f7c674060e1e57672600308f7338a08d'

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })
const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 4096, stream: true, stream_options: { include_usage: true },
  tool_choice: 'auto', tools: [fn('bash'), fn('read')],
})

function headers(msgId) {
  return {
    authorization: 'Bearer public',
    'content-type': 'application/json',
    'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    'x-opencode-client': 'cli',
    'x-opencode-project': PROJECT,
    'x-opencode-request': msgId,
    'x-opencode-session': SESSION,
    'x-opencode-session-id': SESSION,
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
  }
}

function viaRaw(label, msgId) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({ host: HOST, path: PATH, method: 'POST', agent: false, timeout: 60000, headers: headers(msgId) }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => { report(label, res.statusCode, text, Date.now() - t0); resolve() })
    })
    req.on('timeout', () => { req.destroy(); report(label, 'TIMEOUT', '', 0); resolve() })
    req.on('error', (e) => { report(label, 'ERR', e.message, 0); resolve() })
    req.end(body)
  })
}

async function viaFetch(label, msgId) {
  const t0 = Date.now()
  try {
    const res = await fetch(`https://${HOST}${PATH}`, { method: 'POST', headers: headers(msgId), body, signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    report(label, res.status, text, Date.now() - t0)
  } catch (e) {
    report(label, 'ERR', e.message, 0)
  }
}

function report(label, status, text, ms) {
  const tag = /FreeUsageLimitError/.test(text) ? '[429]'
    : /within OpenCode/.test(text) ? '[403]'
      : status === 200 ? '[200 成功]' : ''
  console.log(`${label.padEnd(42)} -> HTTP ${status} ${tag} (${ms}ms)`)
}

console.log('会话:', SESSION, '| 模型:', MODEL, '\n')
await viaRaw('A https.request + 真实 msg id', REAL_MSG)
await viaRaw('B https.request + 伪造 msg id', 'msg_14af12e0f001I2lVqU5iaRrBja')
await viaFetch('C fetch(undici) + 真实 msg id', REAL_MSG)
await viaFetch('D fetch(undici) + 伪造 msg id', 'msg_14af12e0f001I2lVqU5iaRrBja')
