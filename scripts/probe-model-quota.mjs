// 最终判定：免费额度是否**按模型**计量。
//
// 这一轮推翻了前面所有「身份判定」的结论：同一份报文、同一条干净通路，
// `mimo-v2.6-flash-free` 直连 200，而我此前一直拿 `deepseek-v4.1-flash-free` /
// `big-pickle` 做探针 —— 那两个模型的额度早已被上百次探测打光。
//
// 若各模型状态不同，那么「客户端 200 / 插件 429」的对照从根上就不成立：
// 我比较的是两个不同模型的额度，不是两个不同的发出者。
//
// 用法：node scripts/probe-model-quota.mjs <session>

import https from 'node:https'
import fs from 'node:fs'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'
const SESSION = process.argv[2]
const PROJECT = process.env.PROBE_PROJECT ?? '63520fb4f7c674060e1e57672600308f7338a08d'

const MODELS = process.env.PROBE_MODELS
  ? process.env.PROBE_MODELS.split(',')
  : ['mimo-v2.6-flash-free', 'deepseek-v4.1-flash-free', 'big-pickle']

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })

function attempt(model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'say hi' }],
    max_tokens: 256, stream: true, stream_options: { include_usage: true },
    tool_choice: 'auto', tools: [fn('bash'), fn('read')],
  })
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
        const tag = /FreeUsageLimitError/.test(text) ? '429 额度/限流'
          : /within OpenCode/.test(text) ? '403 闸门'
            : /exceeds the model window/.test(text) ? '502 超窗'
              : res.statusCode === 200 ? '200 可用' : `其它 ${res.statusCode}`
        const ra = res.headers['retry-after']
        console.log(`${model.padEnd(28)} -> ${tag}${ra ? `  retry-after=${ra}s` : ''}  (${Date.now() - t0}ms)`)
        resolve({ model, status: res.statusCode, tag, retryAfter: ra })
      })
    })
    req.on('timeout', () => { req.destroy(); console.log(`${model} -> 超时`); resolve({ model, status: 'TIMEOUT' }) })
    req.on('error', (e) => { console.log(`${model} -> ERR ${e.message}`); resolve({ model, status: 'ERR' }) })
    req.end(body)
  })
}

const results = []
for (const m of MODELS) {
  results.push(await attempt(m))
  await new Promise((r) => setTimeout(r, 600))
}

console.log('\n汇总:')
for (const r of results) console.log(`  ${r.model}: ${r.tag ?? r.status}`)

// 顺带看看目录里标为免费的模型，好知道哪些还值得试
try {
  const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG ?? 'opencode-zen-catalog.json', 'utf8'))
  void catalog
} catch { /* 没有就算 */ }
