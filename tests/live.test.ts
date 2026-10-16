import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/shared/live.ts'

test('resolveConfig reads live fields and passes plain ones through', () => {
  // Live fields are how DSH's Plugins page changes settings without a restart.
  let mode = 'deny'
  const config = { mode: { get: () => mode }, tools: ['bash', 'pwsh'], extra: { 'gen/**': 'run make' }, on: true }
  assert.deepEqual(resolveConfig(config), { mode: 'deny', tools: ['bash', 'pwsh'], extra: { 'gen/**': 'run make' }, on: true })
  mode = 'ask'
  assert.equal(resolveConfig(config).mode, 'ask', 'a change made on the settings page shows up on the next read')
})

test('an allow pattern that is not a valid regex is skipped, not fatal', async () => {
  // Patterns typed on the settings page apply live, so a typo must not take the plugin down.
  const { compileAllowPatterns } = await import('../src/index.ts')
  const compiled = compileAllowPatterns(['^npm run dev$', '([unclosed'])
  assert.equal(compiled.length, 1)
  assert.ok(compiled[0]!.test('npm run dev'))
})
