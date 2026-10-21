// 最终判定：429 是不是**频率限流**（而不是身份、额度、TLS）。
//
// 现在直连全部 200，而此前我密集探针时全是 429 且 retry-after 越推越长（6h→22h）。
// 若连续快速请求会在第 N 次开始 429、停下后又恢复，那整件事就是速率限制——
// 「客户端 200 / 插件 429」也只是因为我探针时一直在打、客户端只打了一次。
//
// 用法：node scripts/probe-rate-limit.mjs <session> [次数] [间隔ms]

import https from 'node:https'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'
const SESSION = process.argv[2]
const COUNT = Number(process.argv[3] ?? 8)
const GAP = Number(process.argv[4] ?? 0)
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'
const PROJECT = process.env.PROBE_PROJECT ?? '63520fb4f7c674060e1e57672600308f7338a08d'

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })
const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 64, stream: true, stream_options: { include_usage: true },
  tool_choice: 'auto', tools: [fn('bash'), fn('read')],
})

function once(i) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({
      host: HOST, path: PATH, method: 'POST', agent: false, timeout: 60000,
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
        'x-opencode-client': 'cli',
        'x-opencode-project': PROJECT,
        'x-opencode-request': 'msg_14d4d6850001ETqpHUbdACPXr4',
        'x-opencode-session': SESSION,
        'x-opencode-session-id': SESSION,
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
      },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        const tag = /FreeUsageLimitError/.test(text) ? '429' : res.statusCode === 200 ? '200' : String(res.statusCode)
        const ra = res.headers['retry-after']
        console.log(`  #${String(i + 1).padStart(2)} -> ${tag}${ra ? `  retry-after=${ra}s` : ''}  (${Date.now() - t0}ms)`)
        resolve(tag)
      })
    })
    req.on('timeout', () => { req.destroy(); console.log(`  #${i + 1} -> 超时`); resolve('TIMEOUT') })
    req.on('error', (e) => { console.log(`  #${i + 1} -> ERR ${e.message}`); resolve('ERR') })
    req.end(body)
  })
}

console.log(`模型 ${MODEL} | 会话 ${SESSION} | 连打 ${COUNT} 次，间隔 ${GAP}ms\n`)
const seq = []
for (let i = 0; i < COUNT; i++) {
  seq.push(await once(i))
  if (GAP > 0) await new Promise((r) => setTimeout(r, GAP))
}
console.log('\n序列:', seq.join(' '))
const first429 = seq.indexOf('429')
console.log(first429 >= 0
  ? `\n⇒ 从第 ${first429 + 1} 次开始 429：这是速率限制，不是身份判定`
  : '\n⇒ 连打全部通过：429 与频率无关')
process.exit(0)
