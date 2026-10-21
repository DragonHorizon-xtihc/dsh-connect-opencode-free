// 验证「出口 IP 决定免费额度」假设。
//
// 关键前提：本机存在代理环境变量 HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:53355
// （且机器装有 RuiJie / Sangfor SSL VPN 网卡）。Bun 的 fetch 遵循代理环境变量，
// Node 的 fetch(undici) 默认忽略 —— 于是 OpenCode CLI 与 dsh 插件可能从
// **不同的出口 IP** 打同一个网关，落进不同的「来源」额度桶。
//
// 本探针：直连 与 走代理 分别回显公网 IP，再用同一条通路各打一次 Zen。

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

const PROXY = { host: '127.0.0.1', port: 53355 }

function connectViaProxy(targetHost, targetPort = 443) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: `${targetHost}:${targetPort}` })
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`))
      resolve(tls.connect({ socket, servername: targetHost }))
    })
    req.once('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('proxy timeout')) })
    req.end()
  })
}

async function get(url, viaProxy) {
  return new Promise(async (resolve) => {
    const u = new URL(url)
    const options = {
      host: u.hostname,
      path: u.pathname,
      method: 'GET',
      headers: { Host: u.hostname, 'User-Agent': 'opencode/1.18.35' },
      timeout: 20000,
    }
    // createConnection 必须同步返回 socket，所以先建好隧道再发请求
    if (viaProxy) {
      const sock = await connectViaProxy(u.hostname).catch((e) => { resolve({ status: 'ERR', body: 'proxy: ' + e.message }); return null })
      if (!sock) return
      options.createConnection = () => sock
    }
    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.status, body: body.trim().slice(0, 200) }))
    })
    req.once('error', (e) => resolve({ status: 'ERR', body: e.message }))
    req.end()
  })
}

for (const url of ['https://api.ipify.org', 'https://icanhazip.com']) {
  const direct = await get(url, false)
  const proxied = await get(url, true)
  console.log(`\n${url}`)
  console.log('  直连  ->', direct.status, direct.body)
  console.log('  走代理->', proxied.status, proxied.body)
}
