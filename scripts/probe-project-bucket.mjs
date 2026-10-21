// 关键假设：免费额度按 **project** 计量。
//
// 线索来自逆向：`x-opencode-project` 是客户端从 cwd 算出来的 git 根 hash
// （`(yield* context4).project.id`），我第一次抓到的是 `17c2c713…`，换到插件目录后
// 变成 `63520fb4…`。而我此前所有探针都硬编码了 `17c2c713…`——那个 project 的额度
// 早被上百次探测打光了。
//
// 若假设成立：同一个 session、同一份报文，只把 project 换成「客户端此刻正在用的
// 那个」，429 应当消失。
//
// 用法：node scripts/probe-project-bucket.mjs <project-a> <project-b> <session>

import https from 'node:https'

const HOST = 'opencode.ai'
const PATH = '/zen/v1/chat/completions'
const MODEL = process.env.PROBE_MODEL ?? 'mimo-v2.6-flash-free'

const fn = (name) => ({ type: 'function', function: { name, description: `tool ${name}`, parameters: { type: 'object', properties: { x: { type: 'string' } } } } })
const body = JSON.stringify({
  model: MODEL,
  messages: [{ role: 'user', content: 'say hi' }],
  max_tokens: 4096,
  stream: true,
  stream_options: { include_usage: true },
  tool_choice: 'auto',
  tools: [fn('bash'), fn('read')],
})

function attempt(label, project, session) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const req = https.request({
      host: HOST, path: PATH, method: 'POST', agent: false, timeout: 60000,
      headers: {
        authorization: 'Bearer public',
        'content-type': 'application/json',
        'user-agent': 'opencode/1.18.34 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
        'x-opencode-client': 'cli',
        'x-opencode-project': project,
        'x-opencode-request': 'msg_14d4d6850001ETqpHUbdACPXr4',
        'x-opencode-session': session,
        'x-opencode-session-id': session,
        accept: '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
      },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        const tag = /FreeUsageLimitError/.test(text) ? '[429]'
          : /within OpenCode/.test(text) ? '[403]'
            : /exceeds the model window|futile round/.test(text) ? '[502 超窗]'
              : res.statusCode === 200 ? '[200 成功]' : '[其它]'
        console.log(`${label.padEnd(30)} project=${project.slice(0, 12)}… -> HTTP ${res.statusCode} ${tag} (${Date.now() - t0}ms)`)
        if (res.statusCode !== 200) console.log('   ', text.slice(0, 160).replace(/\n/g, ' '))
        resolve()
      })
    })
    req.on('timeout', () => { req.destroy(); console.log(`${label} -> 超时`); resolve() })
    req.on('error', (e) => { console.log(`${label} -> ERR ${e.message}`); resolve() })
    req.end(body)
  })
}

const oldProject = process.argv[2] ?? '17c2c713b7bee7b3305512caa4c4ff1c34588a64'
const newProject = process.argv[3] ?? '63520fb4f7c674060e1e57672600308f7338a08d'
const session = process.argv[4] ?? 'ses_eb2b2ab87ffeUKFdLZm1T6uIP2'

console.log('模型:', MODEL, '| 会话:', session, '\n')
await attempt('A 旧 project（探针常用）', oldProject, session)
await attempt('B 客户端当前 project', newProject, session)
await attempt('C 客户端 project + 新会话', newProject, process.env.PROBE_SESSION ?? session)
