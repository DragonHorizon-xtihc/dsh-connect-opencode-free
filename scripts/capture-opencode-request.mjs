// 抓取 OpenCode CLI 真实发出的上游请求（明文）。
//
// 原理：把 Zen provider 的 baseURL 临时指到本机 http 端口，CLI 就会把完整
// 请求（头 + body）以明文发过来。本脚本记录一份到 oc-capture.json，再原样
// 转发到 https://opencode.ai，并把响应（含 SSE 流）pipe 回去。
//
// 用法：
//   node scripts/capture-opencode-request.mjs            # 起代理，等待一次请求
//   然后另开一个终端：
//   OPENCODE_CONFIG=<tmp>/cap.json <opencode-cli 路径> run -m opencode/mimo-v2.6-flash-free "reply with OK"
//
// 本次只做观测，不改任何全局配置。
import http from 'node:http'
import https from 'node:https'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.CAP_PORT || 18080)
// 默认落到系统临时目录：这是含完整对话的诊断产物，不该留在仓库根目录。
const OUT = process.env.CAP_OUT || join(tmpdir(), 'oc-capture.json')
const UPSTREAM = 'opencode.ai'
// 本地路径前缀，转发时去掉它再拼回真实前缀
const LOCAL_PREFIX = '/zen/v1'

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const record = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyBytes: Buffer.byteLength(raw),
      body: raw,
    }
    writeFileSync(OUT, JSON.stringify(record, null, 2))
    console.log('[capture] %s %s %d bytes -> %s', req.method, req.url, record.bodyBytes, OUT)

    const path = req.url
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    if (raw) headers['content-length'] = Buffer.byteLength(raw)

    const up = https.request({ host: UPSTREAM, port: 443, path, method: req.method, headers }, (ur) => {
      console.log('[upstream] status=%d %s', ur.statusCode, ur.headers['content-type'] || '')
      res.writeHead(ur.statusCode, ur.headers)
      ur.pipe(res)
    })
    up.on('error', (e) => {
      console.log('[upstream-err] %s', e.message)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('proxy error: ' + e.message)
    })
    up.end(raw)
  })
})

server.listen(PORT, '127.0.0.1', () => console.log('[capture] listening on http://127.0.0.1:%d%s', PORT, LOCAL_PREFIX))
