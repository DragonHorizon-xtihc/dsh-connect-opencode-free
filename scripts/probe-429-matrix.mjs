// 最后一轮穷举：静态逆向已排除头部/模型/会话/出口 IP，剩下三个变量：
//   1. 根会话 vs 子代理会话（CLI 此刻的成功发生在根会话 ses_eb55fd518ffe…）
//   2. HTTP/1.1(nodici) vs HTTP/2(Bun 可能用 h2)
//   3. 带 Authorization: Bearer public vs 完全不带认证头
// 每个组合打一次，记录状态码 / retry-after / 错误类型。

import https from 'node:https'
import http2 from 'node:http2'

const ROOT = 'ses_eb55fd518ffeMfJqeeMbd5lZVe'
const SUB = 'ses_eb55ed479ffeNn2TADfgda0RAB'
const PROJECT = '17c2c713b7bee7b3305512caa4c4ff1c34588a64'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'

function body() {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'say hi' }],
    stream: true,
    max_tokens: 32,
    tools: [
      { type: 'function', function: { name: 'bash', description: 't', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
      { type: 'function', function: { name: 'read', description: 't', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    ],
    tool_choice: 'auto',
  })
}

function headers(session, parent, auth) {
  return {
    'content-type': 'application/json',
    ...(auth ? { Authorization: 'Bearer public' } : {}),
    'user-agent': 'opencode/1.18.35',
    'x-opencode-session-id': session,
    'x-opencode-session': session,
    ...(parent ? { 'x-opencode-parent-session-id': parent } : {}),
    'x-opencode-project': PROJECT,
    'x-opencode-request': 'msg_14aa168da001Qc4Zx6inM0vfeC',
    'x-opencode-client': 'desktop',
  }
}

function viaH1(label, session, auth) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'opencode.ai', path: '/zen/v1/chat/completions', method: 'POST',
      headers: headers(session, null, auth), timeout: 25000,
    }, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => {
        console.log(`${label} -> ${res.statusCode} retry-after=${res.headers['retry-after'] ?? '-'} ${b.slice(0, 140).replace(/\n/g, ' ')}`)
        resolve()
      })
    })
    req.on('error', (e) => { console.log(`${label} -> ERR ${e.message}`); resolve() })
    req.end(body())
  })
}

function viaH2(label, session, auth) {
  return new Promise((resolve) => {
    const client = http2.connect('https://opencode.ai')
    client.on('error', (e) => { console.log(`${label} -> H2 ERR ${e.message}`); resolve() })
    const req = client.request({ ':path': '/zen/v1/chat/completions', ':method': 'POST', ...headers(session, null, auth) })
    let b = ''
    let status
    req.on('response', (h) => { status = h[':status'] })
    req.setEncoding('utf8')
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      console.log(`${label} -> ${status} ${b.slice(0, 140).replace(/\n/g, ' ')}`)
      client.close()
      resolve()
    })
    req.on('error', (e) => { console.log(`${label} -> H2 ERR ${e.message}`); client.close(); resolve() })
    req.end(body())
    setTimeout(() => { try { client.close() } catch {} resolve() }, 25000)
  })
}

await viaH1('1 root-session + auth   (H1)', ROOT, true)
await viaH1('2 sub-session + auth   (H1)', SUB, true)
await viaH1('3 root-session no-auth (H1)', ROOT, false)
await viaH2('4 root-session + auth   (H2)', ROOT, true)
await viaH2('5 sub-session + auth   (H2)', SUB, true)
