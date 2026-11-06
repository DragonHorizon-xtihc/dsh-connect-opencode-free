// 用真实 OpenCode v2 客户端（serve API）发一次免费模型请求，捕获真实的 200 / 429。
// 与插件 zen/v1 通道做对比。命令行由外层 Bash 注入 PORT/PW_FILE/LOCATION。
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.env.PORT)
const PW = fs.readFileSync(process.env.PW_FILE, 'utf8').trim()
const AUTH = 'Basic ' + Buffer.from('opencode:' + PW).toString('base64')
const MODEL = process.env.MODEL || 'mimo-v2.6-flash-free'
const PROMPT = process.env.PROMPT || 'Reply with exactly the single word: PONG'
const LOCATION = process.env.LOCATION

function req(method, path, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const r = http.request({
      host: '127.0.0.1', port: PORT, path, method,
      headers: { Authorization: AUTH, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(buf) } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: buf })
      })
    })
    r.on('error', reject)
    r.setTimeout(timeoutMs, () => { r.destroy(new Error('req timeout')) })
    if (data) r.write(data)
    r.end()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('OPENCODE_TEST_START', new Date().toISOString(), 'MODEL=', MODEL)
  const created = await req('POST', '/api/session', {
    agent: 'build',
    model: { providerID: 'opencode', id: MODEL },
    location: { directory: LOCATION },
  })
  if (created.status !== 200 || !created.body?.data?.id) {
    console.log('OPENCODE_FREE_RESULT=SESSION_CREATE_FAILED', created.status, created.raw.slice(0, 200))
    return
  }
  const session = created.body.data.id
  console.log('SESSION', session)
  await req('POST', `/api/session/${session}/prompt`, { text: PROMPT })

  const deadline = Date.now() + 8 * 60_000
  while (Date.now() < deadline) {
    try {
      const perm = await req('GET', `/api/session/${session}/permission`)
      for (const pr of (perm.body?.data ?? [])) {
        if (pr?.id) await req('POST', `/api/session/${session}/permission/${pr.id}/reply`, { decision: 'reject', message: 'text-only test' })
      }
    } catch {}
    const msg = await req('GET', `/api/session/${session}/message`)
    const rows = (msg.body?.data ?? [])
    const idle = rows.find((r) => r.type === 'idle')
    if (idle) {
      const assistants = rows.filter((r) => r.type === 'assistant')
      const final = assistants.find((r) => r.finish !== 'tool-calls') ?? assistants[0]
      const text = (final?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('')
      if (idle.outcome === 'failed') {
        const err = idle.error ?? final?.error ?? {}
        console.log('OPENCODE_FREE_RESULT=ERROR')
        console.log('OCTYPE=', err.type, 'OSTATUS=', err.status, 'OMSG=', err.message)
        console.log('ORETRY=', err.retryAfterMs ?? (err.response?.headers ? '' : ''))
      } else {
        console.log('OPENCODE_FREE_RESULT=200')
        console.log('TEXT=', JSON.stringify(text))
        console.log('USAGE=', JSON.stringify(final?.tokens ?? null))
      }
      console.log('OPENCODE_TEST_END', new Date().toISOString())
      return
    }
    await sleep(250)
  }
  console.log('OPENCODE_FREE_RESULT=TIMEOUT')
}

main().catch((e) => { console.log('HARNESS_CRASH=', e?.message ?? String(e)); process.exit(1) })
