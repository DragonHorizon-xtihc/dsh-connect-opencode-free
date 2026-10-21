// 用真实 OpenCode server 发一次请求，观察真实客户端此刻是否也会 429。
// 这是「插件坏掉」还是「额度真的耗尽」的决定性对照。
const BASE = 'http://127.0.0.1:7788'
const auth = 'Basic ' + Buffer.from('probe:probe1234').toString('base64')
const H = { 'content-type': 'application/json', Authorization: auth }

const created = await fetch(`${BASE}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })
const session = await created.json()
console.log('session:', session.id)

const res = await fetch(`${BASE}/session/${session.id}/message`, {
  method: 'POST',
  headers: { ...H, accept: 'text/event-stream' },
  body: JSON.stringify({
    model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
    parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }),
})
console.log('message ->', res.status, res.headers.get('content-type'))

const reader = res.body.getReader()
const dec = new TextDecoder()
let out = ''
const t0 = Date.now()
while (Date.now() - t0 < 60000) {
  const { done, value } = await reader.read()
  if (done) break
  out += dec.decode(value, { stream: true })
  if (/FreeUsageLimitError|Rate limit|429|error/i.test(out)) {
    console.log('--- 命中错误/限流 ---')
    console.log(out.slice(-1500))
    break
  }
  if (/^\s*$/.test(out)) continue
}
console.log('--- 尾部事件 ---')
console.log(out.slice(-1500))
