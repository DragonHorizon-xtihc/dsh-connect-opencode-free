// dsh-connect-opencode-free · real implementations of the gateway's gate tools.
//
// Zen's anonymous free-tier gate rejects a request whose body does not carry
// function tools named `bash` and `read` (verified live: a body with only the
// caller's own tools answers 403, the same body plus those two answers 200).
// The names therefore have to be advertised — but advertising a name that does
// nothing is worse than not advertising it, because the model reaches for it,
// the call is dropped, and the whole turn derails. That is exactly why the same
// model is smooth in OpenCode: there, `bash` and `read` are real tools.
//
// Registering real `bash` and `read` here closes the loop:
//   • the gate still sees the two names it demands;
//   • `gateTools()` finds them already present, so it injects no stubs;
//   • the stream interceptor has nothing to suppress, because the tools exist.
//
// The capability is not new — the Harness already runs commands — but it is
// gated by the `realGateTools` setting and degrades to the old placeholder
// behaviour (call dropped, turn continues) if registration is unavailable.

import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/** Keep one tool result from swallowing the whole context window. */
const MAX_OUTPUT = 64_000
const COMMAND_TIMEOUT_MS = 120_000

function clip(text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…(truncated)` : text
}

/** Run one shell command and resolve with its exit code and combined output. */
function runShell(command, cwd) {
  return new Promise((resolve) => {
    exec(command, {
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === 'number' ? error.code : (error ? 1 : 0)
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

/**
 * The two tool definitions, built with the supplied `defineTool`.
 *
 * Split out from registration so a test can build them with the real
 * `defineTool` and prove the schema DSL is accepted, without needing a live
 * Harness tool registry.
 * @param defineTool - the `dsh-tools` factory.
 * @returns the `bash` and `read` definitions.
 */
export function gateToolDefinitions(defineTool) {
  return [
    defineTool({
      name: 'bash',
      description: 'Execute a shell command and return its output and exit code. '
        + 'Use it for inspection (sed, grep, wc, git) and for builds and tests. '
        + 'The working directory defaults to the process working directory.',
      parameters: {
        command: { type: 'string', required: true, description: 'The shell command to execute.' },
        cwd: { type: 'string', description: 'Working directory for the command.' },
      },
      output: textOutput,
      async execute(args) {
        const command = String(args?.command ?? '')
        if (command === '') return 'bash: no command supplied'
        const { code, stdout, stderr } = await runShell(command, args?.cwd)
        const body = [stdout, stderr].filter((part) => part !== '').join('\n')
        return `${clip(body)}\n[exit ${code}]`
      },
    }),
    defineTool({
      name: 'read',
      description: 'Read a text file, optionally a 1-based inclusive line range.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path, or relative to the process working directory.' },
        offset: { type: 'number', description: 'First line to return (1-based).' },
        limit: { type: 'number', description: 'How many lines to return.' },
      },
      output: textOutput,
      async execute(args) {
        const path = String(args?.path ?? '')
        if (path === '') return 'read: no path supplied'
        const text = await readFile(path, 'utf8')
        const lines = text.split(/\r?\n/)
        const start = Math.max(0, Math.trunc(Number(args?.offset) || 1) - 1)
        const count = Number(args?.limit) > 0 ? Math.trunc(Number(args.limit)) : lines.length
        return clip(lines.slice(start, start + count).join('\n'))
      },
    }),
  ]
}

/**
 * Register `bash` and `read` as real tools on the Harness tool registry.
 *
 * Every step is optional by design: the tools service, the `dsh-tools` module,
 * and `defineTool` itself are all probed, so a deployment that cannot serve
 * them keeps working exactly as before instead of failing to activate.
 * @param ctx - the plugin context; the tools service is soft-probed.
 * @param log - sink for one line explaining why registration did not happen.
 * @returns `{ registered, dispose }`; `dispose` withdraws both tools, so the
 * operator's switch can be flipped without a restart.
 */
export async function registerGateTools(ctx, log = () => {}) {
  const service = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  const none = { registered: false, dispose: () => {} }
  if (!service || typeof service.register !== 'function') {
    log('tools service unavailable; bash/read stay placeholders')
    return none
  }
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    log(`dsh-tools unavailable; bash/read stay placeholders (${error?.message ?? error})`)
    return none
  }
  if (typeof defineTool !== 'function') {
    log('defineTool missing; bash/read stay placeholders')
    return none
  }

  // `register` returns the disposer that withdraws the tool, so the switch can be
  // flipped live. A name the Harness already owns throws instead, which is why
  // this is guarded: in that case the real tools already exist and are used.
  const disposers = []
  try {
    for (const definition of gateToolDefinitions(defineTool)) {
      const dispose = service.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    for (const dispose of disposers) {
      try { dispose() } catch { /* a partial registration must still be withdrawn */ }
    }
    log(`gate tool registration failed; bash/read stay placeholders (${error?.message ?? error})`)
    return none
  }
  return {
    registered: true,
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* withdrawal must never throw across a toggle */ }
      }
    },
  }
}
