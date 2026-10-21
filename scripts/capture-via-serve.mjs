// 抓真实 openencode 客户端发出的完整报文。
// 做法：用 OPENCODE_CONFIG_CONTENT 注入一个指向本地捕获服务器的 provider，
// 然后用 serve 的 HTTP API 触发一次会话消息 —— 真实客户端会把请求打到 8899。
// 捕获到的 headers/body 即「能过免费档闸门」的真实形状，再逐字段与插件请求对比。
const BASE = 'http://127.0.0.1:7788'
const H = { 'content-type': 'application/json' }

const created = await fetch(`${BASE}/session`, { method: 'POST', headers: H, body: JSON.stringify({}) })
const session = await created.json()
console.log('session:', session.id)

const res = await fetch(`${BASE}/session/${session.id}/message`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    model: { providerID: 'probe', modelID: 'probe-model' },
    parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }),
})
console.log('message ->', res.status)
console.log((await res.text()).slice(0, 600))
