// 按出口地址族（IPv4/IPv6）分别打 Zen 网关，验证「按来源(IP)限流」假设。
// 本机 opencode.ai 同时有 A(172.65.90.20-23) 与 AAAA(2606:4700:78::90:14x) 记录。
import https from 'node:https'
import dns from 'node:dns'

const SID = process.env.PROBE_SESSION ?? 'ses_eb55ed479ffeNn2TADfgda0RAB'
const PROJECT = '17c2c713b7bee7b3305512caa4c4ff1c34588a64'
const BODY = JSON.stringify({
  model: process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: 'say hi' }],
  stream: true,
  max_tokens: 32,
  tools: [
    { type: 'function', function: { name: 'bash', description: 't', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read', description: 't', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
  ],
  tool_choice: 'auto',
})

function forcedLookup(family) {
  const resolve = family === 4 ? dns.resolve4 : dns.resolve6
  return (hostname, options, callback) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err)
      if (!addresses?.length) return callback(new Error(`no ${family === 4 ? 'A' : 'AAAA'} for ${hostname}`))
      if (options?.all) {
        return callback(null, addresses.map((address) => ({ address, family })))
      }
      callback(null, addresses[0], family)
    })
  }
}

function post(label, lookup) {
  return new Promise((resolve) => {
    const req = https.request({
      host: 'opencode.ai',
      path: '/zen/v1/chat/completions',
      method: 'POST',
      lookup,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer public',
        'User-Agent': 'opencode/1.18.35',
        'x-opencode-session-id': SID,
        'x-opencode-session': SID,
        'x-opencode-project': PROJECT,
        'x-opencode-client': 'desktop',
      },
    }, (res) => {
      const remote = `${res.socket?.remoteFamily ?? '?'}:${res.socket?.remoteAddress ?? '?'}`
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        console.log(`### ${label} -> HTTP ${res.status} remote=${remote}`)
        console.log('  retry-after:', res.headers['retry-after'])
        console.log('  body:', body.slice(0, 200).replace(/\n/g, ' '))
        resolve()
      })
    })
    req.on('error', (e) => { console.log(`### ${label} -> ERR ${e.message}`); resolve() })
    req.setTimeout(30000, () => { req.destroy(); console.log(`### ${label} -> TIMEOUT`); resolve() })
    req.end(BODY)
  })
}

await post('forced-IPv4', forcedLookup(4))
await post('forced-IPv6', forcedLookup(6))
