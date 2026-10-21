// 决定性对照：同一时刻、同一 session、同一 body、同一组头，
// 唯一变量是「是否走本机代理 http://127.0.0.1:53355」。
//
// 背景：系统设了 HTTP_PROXY/HTTPS_PROXY 但没有 no_proxy。
//   - Bun 的 fetch 遵循代理环境变量 → 真实 OpenCode 客户端大概率走代理出网
//   - Node 的 fetch(undici) 默认完全忽略代理 → 插件侧（Node 宿主）直连出网
// 若两者出口 IP 不同，Zen「按来源限流」就会把它们算进不同的额度桶：
// CLI 那一桶还有额度，插件那一桶已耗尽 —— 这正好解释「同一台机器一成一败」。
//
// 做法：手工建 CONNECT 隧道，再在其上跑 https.request，与直连做 A/B。

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 53355 }
const BASE = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'
const MODEL = process.env.PROBE_MODEL ?? 'big-pickle'
const SESSION = process.env.PROBE_SESSION ?? 'ses_eb5174458ffef2U4frw0yRYu9N'

const CLI_UA = 'opencode/1.18.35'

function connectViaProxy(targetHost, targetPort = 443) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: `${targetHost}:${targetPort}` })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`))
      resolve(tls.connect({ socket, servername: targetHost }))
    })
    req.once('error', reject)
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('proxy timeout')) })
    req.end()
  })
}

const fn = (name) => ({
  type: 'function',
  function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } },
})

const payload = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'say hi' }],
  stream: true,
  max_tokens: 32,
  tools: [fn('bash'), fn('read')],
  tool_choice: 'auto',
})

async function request(viaProxy, path = PATH, method = 'POST') {
  const options = {
    host: BASE,
    path,
    method,
    headers: method === 'POST'
      ? {
          Host: BASE,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: 'Bearer public',
          'User-Agent': CLI_UA,
          'x-opencode-session-id': SESSION,
          'x-opencode-session': SESSION,
          'x-opencode-client': 'cli',
        }
      : { Host: BASE, 'User-Agent': CLI_UA },
    timeout: 30000,
  }
  if (viaProxy) {
    const sock = await connectViaProxy(BASE)
    options.createConnection = () => sock
  }
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        const interesting = {}
        for (const [k, v] of Object.entries(res.headers)) if (/ratelimit|retry|limit|quota|x-opencode/i.test(k)) interesting[k] = v
        resolve({ status: res.statusCode, headers: interesting, body: body.slice(0, 300) })
      })
    })
    req.once('error', (e) => resolve({ status: 'ERR', body: e.message }))
    if (method === 'POST') req.write(payload)
    req.end()
  })
}

for (const [label, viaProxy] of [['直连', false], ['走代理', true]]) {
  const r = await request(viaProxy)
  console.log(`\n### ${label} POST ${PATH} -> HTTP ${r.status}`)
  console.log('  headers:', JSON.stringify(r.headers))
  console.log('  body:', String(r.body).replace(/\n/g, ' '))
}

// 顺带确认两条通路的出口 IP 是否真的相同
for (const url of ['https://api.ipify.org', 'https://icanhazip.com']) {
  const u = new URL(url)
  const out = {}
  for (const [label, viaProxy] of [['direct', false], ['proxy', true]]) {
    const options = { host: u.hostname, path: u.pathname, method: 'GET', headers: { Host: u.hostname, 'User-Agent': CLI_UA }, timeout: 20000 }
    if (viaProxy) {
      const sock = await connectViaProxy(u.hostname)
      options.createConnection = () => sock
    }
    out[label] = await new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let b = ''
        res.on('data', (c) => { b += c })
        res.on('end', () => resolve(String(res.statusCode) + ' ' + b.trim().slice(0, 60)))
      })
      req.once('error', (e) => resolve('ERR ' + e.message))
      req.end()
    })
  }
  console.log(`\n${url}\n  直连: ${out.direct}\n  代理: ${out.proxy}`)
}
