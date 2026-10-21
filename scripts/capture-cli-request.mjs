// 抓真实 OpenCode CLI 发出的请求：把它引到本地 HTTP 服务器（配置用明文 http，
// 走 OPENCODE_CONFIG_CONTENT 注入，不改动用户配置），记录全部请求头与 body，
// 并回一个合法的 OpenAI 流式响应，让 CLI 能正常结束。
//
// 用途：回答「为什么 CLI 能用免费额度、插件却 429」——拿到客户端真实报文后
// 与插件请求逐字段对比。

import http from 'node:http'
import fs from 'node:fs'

const OUT = process.argv[2] ?? new URL('../.tmp_capture.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const record = { at: new Date().toISOString(), method: req.method, url: req.url, httpVersion: req.httpVersion, headers: req.headers, body }
    fs.appendFileSync(OUT, JSON.stringify(record) + '\n')
    req.socket.remotePort
    console.log(`<< ${req.method} ${req.url} HTTP/${req.httpVersion} from ${req.socket.remoteAddress}:${req.socket.remotePort}`)

    if (req.url?.includes('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const id = 'chatcmpl-probe'
      const chunk = (delta, finish) => `data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'probe-model',
        choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      })}\n\n`
      res.write(chunk({ role: 'assistant', content: 'captured' }))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (req.url?.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model', created: 0, owned_by: 'probe' }] }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
})

server.listen(8899, '127.0.0.1', () => console.log('capture server on http://127.0.0.1:8899 ->', OUT))
