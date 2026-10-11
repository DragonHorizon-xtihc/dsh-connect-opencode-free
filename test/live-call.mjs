// Reproduces the reported failure against the real llm service:
//   packages/llm/llm/src/index.ts -> registration.adapter.prepareCall(...)
// A plain-object adapter registers fine and then throws
// "prepareCall is not a function" on the first model call.
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { OpenCodeFreeAdapter } from '../lib/provider.js'
import { installOpenCodeFreeProvider } from '../lib/provider.js'

const ctx = new Context()
await ctx.plugin(LlmRuntime)

const control = { enabled: () => true }
const hooks = {
  credentials: () => [],
  maxAttempts: () => 3,
  backoffMs: () => 200,
  zenBaseURL: () => 'http://127.0.0.1:18999/zen/v1',
}
const handle = installOpenCodeFreeProvider(ctx, (m) => console.log('  [plugin]', m), control, hooks)
const adapter = handle.adapter
adapter.setModels([
  { id: 'space-bunny-free', name: 'Space Bunny Free', contextWindow: 200000, maxTokens: 32000, reasoning: true, tool_call: true },
])

console.log('1. listModels')
const models = await ctx.llm.listModels('opencode-free')
console.log('   ->', models.map((m) => `${m.provider}/${m.id}`).join(', ') || '(empty)')

console.log('2. ctx.llm.prepareCall()  <-- the line that used to throw')
const prepared = await ctx.llm.prepareCall({ provider: 'opencode-free', model: 'space-bunny-free' })
console.log('   -> model:', prepared.model?.id ?? prepared.config?.model, '| ok, no throw')

console.log('3. stream a real turn through the fixture')
const chunks = []
for await (const chunk of prepared.stream({ ...prepared.config, messages: [createUserMessage({ content: [{ type: 'text', text: 'say PONG' }] })] })) {
  chunks.push(chunk)
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
}
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const finish = chunks.find((c) => c.type === 'finish')
const usage = chunks.find((c) => c.type === 'usage')
console.log('\n   -> text:', JSON.stringify(text))
console.log('   -> finish:', JSON.stringify(finish?.reason))
console.log('   -> usage:', JSON.stringify(usage?.usage))

if (text !== 'PONG') {
  console.error('\nFAIL: expected PONG from the fixture, got', JSON.stringify(text))
  process.exitCode = 1
} else {
  console.log('\nPASS: prepareCall + stream both work end to end')
}

handle()
await ctx.fiber.dispose()
