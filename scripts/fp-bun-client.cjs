// 让 Bun 连过来，供 probe-tls-fingerprint.mjs 抓它的 ClientHello。
const tls = require('node:tls')
const port = Number(process.argv[2] ?? 9443)
const s = tls.connect({ host: '127.0.0.1', port, servername: 'opencode.ai', rejectUnauthorized: false }, () => {
  setTimeout(() => { s.destroy(); process.exit(0) }, 1200)
})
s.on('error', () => process.exit(0))
setTimeout(() => process.exit(0), 8000)
