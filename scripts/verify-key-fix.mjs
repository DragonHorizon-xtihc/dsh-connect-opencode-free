// Verify the fix: a keyed request and the key probe both carry the gateway's
// three signals, so a valid key is accepted.
//
// Before the fix the probe sent a bare `Authorization: Bearer <key>` and got
// 403 FreeTierError for every key, valid or not — which is why the two keyed
// policies could never be unlocked and why the operator was told their key was
// rejected when it was fine.
//
// Run: node scripts/verify-key-fix.mjs <key>

import { verifyKey } from '../lib/keycheck.js'

const KEY = process.argv[2]
if (!KEY) {
  console.error('usage: node scripts/verify-key-fix.mjs <key>')
  process.exit(1)
}

const MODELS = ['big-pickle', 'space-bunny-free', 'mimo-v2.6-flash-free']

console.log(`key: ${KEY.slice(0, 14)}…${KEY.slice(-4)}`)
console.log('')

for (const model of MODELS) {
  const result = await verifyKey({
    baseURL: 'https://opencode.ai/zen/v1',
    key: KEY,
    model,
    timeoutMs: 30_000,
  })
  const mark = result.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${model.padEnd(22)} HTTP ${String(result.status).padEnd(4)} ${result.reason}`)
}

console.log('')
console.log('A PASS means the gateway accepted the request and authentication ran.')
console.log('Only a 401/403 that is NOT a FreeTierError means the key itself is bad.')
