// dsh-connect-opencode-free · Zen 出网转发器（Bun 侧）
//
// 为什么需要这个进程：
//   2026-10-27 实测，Zen 免费档的放行是**双因子**：
//     ① 请求体里的 system 必须完整包含 OpenCode 官方提示词原文；
//     ② HTTP 客户端必须是 Bun 的 TLS 栈。
//   同样一份报文（system 完整、头与凭据一致）：
//     · Node(undici/OpenSSL)      → 429 FreeUsageLimitError
//     · Bun 1.3.12 / 1.4.4        → 200
//   所以 Node 宿主不能直接出网，必须把请求交给一个 Bun 进程代发。
//   作证脚本：scripts/probe-system-*.mjs、scripts/replay-captured.mjs。
//
// 协议（父进程 → 本进程，普通 HTTP）：
//   POST http://127.0.0.1:<port>/<任意路径>
//   x-egress-url: 完整的上游 URL（本进程只认这个头，路径只是占位）
//   其余请求头、body 原样转发；上游响应（含 SSE 流）原样流回。
//
// 启动方式由 lib/zen-egress.js 负责；本文件只关心转发。
// 输出 `EGRESS_READY <port>` 是父子之间的握手信号，不要改格式。

/** 上游主机；只允许这一个，避免被当成通用代理。 */
const ALLOWED_HOST = 'opencode.ai'

function stripHopByHop(headers) {
  // 逐跳头不能跨代理转发；x-egress-url 是本进程私有的指令，更不能外泄。
  for (const name of [
    'x-egress-url',
    'host',
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    // 让 Bun 决定压缩协商：Node 侧已经不压缩，转发时也不要再声明。
    'accept-encoding',
  ]) {
    headers.delete(name)
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  // 免费档的请求偶尔要等上游很久，默认 10s 会误杀。
  idleTimeout: 255,
  async fetch(request) {
    const target = request.headers.get('x-egress-url')
    if (!target) return new Response('missing x-egress-url', { status: 400 })

    let url
    try {
      url = new URL(target)
    } catch {
      return new Response('bad x-egress-url', { status: 400 })
    }
    if (url.hostname !== ALLOWED_HOST) {
      return new Response(`host not allowed: ${url.hostname}`, { status: 403 })
    }

    const headers = new Headers(request.headers)
    stripHopByHop(headers)

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const body = hasBody ? await request.arrayBuffer() : undefined

    try {
      const upstream = await fetch(url.toString(), {
        method: request.method,
        headers,
        body,
        // 客户端断开时上游一起断，避免上游继续计费生成。
        signal: request.signal,
        redirect: 'manual',
      })

      // Bun 的 fetch 已经解压过正文；再带 content-encoding 会让下游二次解压失败。
      const responseHeaders = new Headers(upstream.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      })
    } catch (error) {
      // 上游连不上时给 502，让宿主的既有重试逻辑接住（与网关自身的 502 同义）。
      return new Response(`egress upstream failed: ${error?.message ?? error}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
  },
})

// 握手：父进程读这一行拿端口。
console.log(`EGRESS_READY ${server.port}`)
