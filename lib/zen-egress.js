// dsh-connect-opencode-free · Zen 出网转发器（宿主编排侧）
//
// 职责：找到一台可用的 Bun，用它拉起 lib/zen-egress-runner.mjs，并把
// `egressFetch()` 暴露给 provider。
//
// 为什么不是「让插件自己也跑在 Bun 里」：宿主进程是 Node，插件无法自选运行时；
// 能改的只有「这次 HTTP 由谁发出」。见 zen-egress-runner.mjs 顶部的实测依据。
//
// 关键约束：
//   · 懒启动。没有请求就不起进程；解析不到 Bun 时返回 undefined，调用方回退直连
//     （回退会 429，但至少不会因为缺少运行时把整轮打死）。
//   · 进程崩溃/退出后自动重建：下一次请求会重新拉起，而不是永久失效。
//   · 空闲回收：默认 10 分钟没有请求就退出，避免长期占用一个常驻子进程。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('./zen-egress-runner.mjs', import.meta.url))
const START_TIMEOUT_MS = 20_000
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** 子进程状态：`{ child, port }`，未启动时为 null。 */
let server = null
/** 启动中的去重 promise，避免并发请求各起一个进程。 */
let starting = null
let idleTimer = null
/** 最近一次失败原因，供设置页/日志说明为什么回退直连。 */
let lastFailure = null

/**
 * Bun 与 OpenCode CLI 的候选路径。
 *
 * `BUN_BE_BUN=1` 是一个关键退路：Bun 编译出来的单文件可执行（OpenCode 的
 * opencode-cli 就是）在设了该环境变量后，会把自己当成 bun 运行时执行脚本。
 * 这样「用户装了 OpenCode 但没装 Bun」的机器也能拿到 Bun 的 TLS 栈。
 * @returns 绝对路径数组，存在的才留下。
 */
function candidates() {
  const home = homedir()
  const win = process.platform === 'win32'
  const bun = win ? 'bun.exe' : 'bun'

  const buns = [
    process.env.ZEN_EGRESS_BUN,
    join(home, '.bun', 'bin', bun),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', bun) : undefined,
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
    '/usr/bin/bun',
  ].filter(Boolean)

  const opencodeCli = [
    process.env.OPENCODE_CLI,
    win && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Programs', 'OpenCode', 'resources', 'opencode-cli.exe')
      : undefined,
    win ? 'C:\\Program Files\\OpenCode\\resources\\opencode-cli.exe' : undefined,
    '/Applications/OpenCode.app/Contents/Resources/opencode-cli',
    '/opt/OpenCode/resources/opencode-cli',
    '/usr/lib/opencode/resources/opencode-cli',
  ].filter(Boolean)

  return { buns, opencodeCli }
}

/**
 * 选出第一个可用的运行时。
 *
 * 顺序上先找真 Bun、再找 opencode-cli：真 Bun 的行为最可预期，而
 * `BUN_BE_BUN` 依赖 OpenCode 的打包产物长期保持这一兼容开关。
 * @returns `{ command, env, label }`，找不到时 undefined。
 */
export function resolveRuntime() {
  const { buns, opencodeCli } = candidates()
  for (const path of buns) {
    if (path && existsSync(path)) return { command: path, env: {}, label: `bun:${path}` }
  }
  for (const path of opencodeCli) {
    if (path && existsSync(path)) {
      return { command: path, env: { BUN_BE_BUN: '1' }, label: `bun-be-bun:${path}` }
    }
  }
  return undefined
}

/** 最近一次启动/转发失败的原因；undefined 表示一直正常。 */
export function egressFailure() {
  return lastFailure
}

function stopIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function armIdleTimer() {
  stopIdleTimer()
  idleTimer = setTimeout(() => {
    // 空闲回收。这里不 await：杀进程是同步的，下一次请求会重新拉起。
    const current = server
    server = null
    try {
      current?.child.kill()
    } catch {
      /* 已经退出就算了 */
    }
  }, IDLE_TIMEOUT_MS)
  // 不阻止宿主退出。
  idleTimer.unref?.()
}

function forget() {
  server = null
  starting = null
  stopIdleTimer()
}

/**
 * 启动转发器（幂等）。
 * @returns `{ port }`。
 * @throws 运行时缺失、启动超时或子进程提前退出时抛错。
 */
async function ensureServer() {
  if (server) return server
  if (starting) return starting

  starting = (async () => {
    const runtime = resolveRuntime()
    if (!runtime) {
      const error = new Error(
        '找不到可用的 Bun 运行时，无法建立 Zen 出网通道。'
        + '两个办法任选其一：① 安装 Bun（https://bun.sh）；'
        + '② 保留本机 OpenCode 安装（插件会自动用 BUN_BE_BUN 复用它的运行时）。',
      )
      error.code = 'NO_BUN_RUNTIME'
      lastFailure = error.message
      throw error
    }

    const child = spawn(runtime.command, [RUNNER], {
      env: { ...process.env, ...runtime.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const port = await new Promise((resolve, reject) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch { /* ignore */ }
        reject(new Error(`Bun 转发器启动超时（${START_TIMEOUT_MS}ms）：${stderr.slice(-300) || '无输出'}`))
      }, START_TIMEOUT_MS)
      timer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
        // 握手行可能和别人写的东西混在一起，逐行找。
        const match = /EGRESS_READY\s+(\d+)/.exec(stdout)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`Bun 转发器无法启动：${error.message}`))
      })
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`Bun 转发器提前退出（code=${code}）：${stderr.slice(-300) || '无输出'}`))
        }
      })
    })

    // 退出即失效：下一次请求重建，而不是对着死端口发请求。
    child.on('exit', () => {
      if (server?.child === child) forget()
    })

    server = { child, port, runtime: runtime.label }
    lastFailure = undefined
    armIdleTimer()
    return server
  })()

  try {
    return await starting
  } catch (error) {
    lastFailure = error?.message ?? String(error)
    forget()
    throw error
  } finally {
    starting = null
  }
}

/**
 * 经 Bun 转发一次请求。
 *
 * 返回的 `Response` 与 `fetch` 一致（body 是可读流），所以调用方不需要为
 * 流式响应做特殊处理。唯一区别是多了一个 `x-egress-url` 头。
 * @param url - 完整的上游 URL。
 * @param init - 与 `fetch` 的第二个参数同义（method/headers/body/signal）。
 * @returns 上游的 Response。
 */
export async function egressFetch(url, init = {}) {
  const { port } = await ensureServer()
  armIdleTimer()
  const headers = new Headers(init.headers ?? {})
  headers.set('x-egress-url', url)
  try {
    return await fetch(`http://127.0.0.1:${port}/`, { ...init, headers })
  } catch (error) {
    // 转发器可能刚好死掉：清掉状态，让下一次请求重建。
    if (error?.name === 'TypeError' || error?.cause?.code === 'ECONNREFUSED') forget()
    lastFailure = `转发失败：${error?.message ?? error}`
    throw error
  }
}

/** 主动关闭转发器（插件卸载/测试用）。 */
export function shutdownEgress() {
  const current = server
  forget()
  try {
    current?.child.kill()
  } catch {
    /* ignore */
  }
}

// 宿主退出时不要让子进程变孤儿。
process.once('exit', () => {
  try { server?.child.kill() } catch { /* ignore */ }
})
