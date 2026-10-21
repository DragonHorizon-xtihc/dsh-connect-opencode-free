// 抓 TLS ClientHello，算 JA3，对比「真实 OpenCode 客户端」与「Node」的握手指纹。
//
// 为什么这一步是关键：头集合、顺序、大小写、HTTP 版本、出口 IP、会话、工具表都已
// 钉死，仍然是 429。剩下能在握手里。而握手**不是不可伪造的**——知道对方 ClientHello
// 长什么样，Node 的 tls.connect 就能按需拼（ciphers / sigalgs / ecdhCurve / ALPN /
// 扩展顺序都能指定）。所以先量，再定结论。
//
// 用法：
//   node probe-tls-fingerprint.mjs           # 只抓 Node
//   node probe-tls-fingerprint.mjs --client  # 同时让本机 OpenCode 客户端连进来

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const PORT = 9443
const withClient = process.argv.includes('--client')
const withBun = process.argv.includes('--bun')

/** 从累积的字节里解析 ClientHello；不完整时返回 null。 */
function parseClientHello(buf) {
  if (buf.length < 6 || buf[0] !== 0x16) return null
  let p = 5
  if (buf[p] !== 0x01) return null
  const hsLen = buf.readUIntBE(p + 1, 3)
  p += 4
  if (buf.length < p + hsLen) return null
  const version = buf.readUInt16BE(p)
  p += 2
  p += 32
  const sidLen = buf[p]
  p += 1 + sidLen
  const csLen = buf.readUInt16BE(p)
  p += 2
  const ciphers = []
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(p + i))
  p += csLen
  const compLen = buf[p]
  p += 1 + compLen
  const extLen = buf.readUInt16BE(p)
  p += 2
  const end = Math.min(p + extLen, buf.length)
  const extensions = []
  const groups = []
  const sigalgs = []
  const alpn = []
  const versions = []
  while (p + 4 <= end) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    const data = buf.subarray(p + 4, p + 4 + len)
    extensions.push(type)
    if (type === 10 && data.length >= 2) {
      const n = data.readUInt16BE(0)
      for (let i = 0; i < n; i += 2) groups.push(data.readUInt16BE(2 + i))
    } else if (type === 13 && data.length >= 2) {
      const n = data.readUInt16BE(0)
      for (let i = 0; i < n; i += 2) sigalgs.push(data.readUInt16BE(2 + i))
    } else if (type === 16 && data.length >= 3) {
      let q = 2
      while (q + 1 <= data.length) {
        const l = data[q]
        alpn.push(data.subarray(q + 1, q + 1 + l).toString())
        q += 1 + l
      }
    } else if (type === 43 && data.length >= 1) {
      const n = data[0]
      for (let i = 0; i < n; i += 2) versions.push(data.readUInt16BE(1 + i))
    }
    p += 4 + len
  }
  const ja3 = [version, ciphers.join('-'), extensions.join('-'), groups.join('-'), '0'].join(',')
  const greases = [
    ...ciphers.filter((c) => (c & 0x0f0f) === 0x0a0a),
    ...extensions.filter((e) => (e & 0x0f0f) === 0x0a0a),
    ...groups.filter((g) => (g & 0x0f0f) === 0x0a0a),
  ]
  return {
    version, ciphers, extensions, groups, sigalgs, alpn, versions, greases,
    ja3, ja3Hash: crypto.createHash('md5').update(ja3).digest('hex'),
  }
}

let pendingLabel = 'unknown'
const seen = []
const waiters = []

const server = net.createServer((socket) => {
  socket.__label = pendingLabel
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    const parsed = parseClientHello(buf)
    if (!parsed) return
    parsed.label = socket.__label
    if (seen.some((s) => s.label === parsed.label)) return
    seen.push(parsed)
    const w = waiters.shift()
    if (w) w(parsed)
    socket.destroy()
  })
  socket.on('error', () => {})
})

function print(parsed) {
  console.log(`\n=== ${parsed.label} ===`)
  console.log('  JA3:', parsed.ja3Hash)
  console.log('  版本', parsed.version, '| 密码套件', parsed.ciphers.length, '个 | 扩展', parsed.extensions.length, '个')
  console.log('  密码套件:', parsed.ciphers.map((c) => '0x' + c.toString(16)).join(' '))
  console.log('  扩展顺序:', parsed.extensions.join(' '))
  console.log('  曲线:', parsed.groups.join(' '))
  console.log('  签名算法:', parsed.sigalgs.join(' '))
  console.log('  ALPN:', parsed.alpn.join(',') || '(无)')
  console.log('  GREASE:', parsed.greases.length ? parsed.greases.map((g) => '0x' + g.toString(16)).join(' ') : '无')
}

function capture(label, connect) {
  pendingLabel = label
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000)
    waiters.push((parsed) => { clearTimeout(timer); resolve(parsed) })
    connect()
  })
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('抓包服务器 127.0.0.1:' + PORT)

const nodeResult = await capture('Node 22 tls.connect（插件所用）', () => {
  const s = tls.connect({ host: '127.0.0.1', port: PORT, servername: 'opencode.ai', rejectUnauthorized: false }, () => {})
  s.on('error', () => {})
  setTimeout(() => s.destroy(), 3000)
})
if (nodeResult) print(nodeResult)

if (withBun) {
  // Bun 用 BoringSSL，和 OpenCode 内嵌运行时是同一个 TLS 栈 —— 若指纹一致，
  // 就意味着「不必借 opencode，用 bun 发请求也能过」。
  const bunFile = new URL('./fp-bun-client.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const bunResult = await capture('Bun（BoringSSL 栈）', () => {
    const p = spawn('bun', [bunFile, String(PORT)], { stdio: 'ignore', shell: true })
    p.on('error', () => {})
  })
  if (bunResult) print(bunResult)
  if (nodeResult && bunResult) {
    console.log('\nBun 指纹:', bunResult.ja3Hash)
    console.log('与 Node 相同?', bunResult.ja3Hash === nodeResult.ja3Hash)
  }
}

if (withClient) {
  // 让真实客户端连过来：把 provider 的 baseURL 指到本地 https（证书会失败，
  // 但 ClientHello 早就发出去了，足够抓指纹）。
  const cfg = {
    $schema: 'https://opencode.ai/config.json',
    model: 'opencode-fp/probe',
    provider: {
      'opencode-fp': {
        npm: '@ai-sdk/openai-compatible',
        name: 'fp',
        options: { baseURL: `https://127.0.0.1:${PORT}/v1`, apiKey: 'public' },
        models: { probe: { name: 'probe', limit: { context: 128000, output: 4096 } } },
      },
    },
  }
  const port = 7823
  pendingLabel = 'OpenCode 客户端（真实发出者）'
  const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
      OPENCODE_SERVER_USERNAME: 'p', OPENCODE_SERVER_PASSWORD: 'p',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    },
    stdio: 'ignore', shell: true,
  })
  child.unref()
  const H = { 'content-type': 'application/json', Authorization: 'Basic ' + Buffer.from('p:p').toString('base64') }
  let ready = false
  for (let i = 0; i < 45; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: H }); if (r.ok) { ready = true; break } } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (ready) {
    const clientResult = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 20000)
      waiters.push((parsed) => { clearTimeout(timer); resolve(parsed) })
    })
    const s = await (await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })).json()
    fetch(`http://127.0.0.1:${port}/session/${s.id}/message`, {
      method: 'POST', headers: H, signal: AbortSignal.timeout(25000),
      body: JSON.stringify({ model: { providerID: 'opencode-fp', modelID: 'probe' }, parts: [{ type: 'text', text: 'hi' }] }),
    }).catch(() => {})
    const parsed = await clientResult
    if (parsed) print(parsed)
    else console.log('\n(客户端没有发起握手)')
  } else {
    console.log('\n(客户端 serve 未就绪)')
  }
}

server.close()
if (nodeResult) console.log('\nNode 指纹:', nodeResult.ja3Hash)
const client = seen.find((s) => s.label.startsWith('OpenCode'))
if (client) {
  console.log('客户端指纹:', client.ja3Hash)
  console.log(client.ja3Hash === nodeResult?.ja3Hash ? '⇒ 指纹相同，不是差异来源' : '⇒ 指纹不同，这就是可复现的差异点')
}
process.exit(0)
