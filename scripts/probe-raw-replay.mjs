// 精确复刻真实客户端报文：用 Node 原生 https.request，不用 fetch。
//
// 起因（用户质疑）：之前的「逐字节重放」其实不逐字节——undici 的 fetch 会自动
// 注入 `accept-language: *`、`sec-fetch-mode: cors`、`accept-encoding: gzip, deflate`
// 等真实客户端**从来不发**的头。如果网关的判定与这些有关，那一整轮对照就污染了。
//
// https.request 只发你给的头（加上它自己必要的 Host/Connection），是目前最接近
// 「照抄」的做法。

import fs from 'node:fs'
import https from 'node:https'
import { DatabaseSync } from 'node:sqlite'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'

/** 真实客户端在 opencode 分支上发出的头，顺序即捕获顺序。 */
function headersFor(sessionId) {
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

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })

function realSession() {
  try {
    const db = new DatabaseSync(`${process.env.USERPROFILE}/.local/share/opencode/opencode.db`, { readOnly: true })
    const row = db.prepare('SELECT id FROM session ORDER BY time_created DESC LIMIT 1').get()
    db.close()
    return row?.id
  } catch (err) {
    console.log('会话读取失败:', err?.message ?? err)
    return null
  }
}

const captured = process.argv[2] && fs.existsSync(process.argv[2])
  ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  : null

const body = typeof captured?.body === 'string'
  ? captured.body
  : JSON.stringify(captured?.body ?? {
      model: process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      tools: (captured?.tools ?? [fn('bash'), fn('read')]),
    })

const sessionId = captured?.session ?? process.env.PROBE_SESSION ?? realSession()
const headers = headersFor(sessionId)
console.log('session:', sessionId)
console.log('body:', Buffer.byteLength(body), '字节')
console.log('发出的头:', JSON.stringify(headers, null, 1))

const t0 = Date.now()
const req = https.request(
  { host: HOST, path: PATH, method: 'POST', headers, agent: false, timeout: 60000 },
  (res) => {
    let text = ''
    res.on('data', (c) => { text += c })
    res.on('end', () => {
      const tag = /FreeUsageLimitError/.test(text) ? '[429 伪装限流]'
        : /within OpenCode/.test(text) ? '[403 闸门]'
          : /exceeds the model window|futile round/.test(text) ? '[502 超窗 ⇒ 身份已过]'
            : res.statusCode === 200 ? '[200 成功]' : '[其它]'
      console.log(`\nHTTP ${res.statusCode} ${tag}  (${Date.now() - t0}ms)`)
      console.log('retry-after:', res.headers['retry-after'])
      console.log(text.slice(0, 300).replace(/\n/g, ' '))
    })
  },
)
req.on('timeout', () => { console.log('超时'); req.destroy() })
req.on('error', (e) => console.log('ERR', e.message))
req.end(body)
