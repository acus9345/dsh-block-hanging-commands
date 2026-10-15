import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginEntry, runDsh } from './helpers/dsh.ts'

const plugin = { id: 'block-hanging-commands', entry: pluginEntry }

test('a real dsh run denies a dev server and lets the follow-up command run', async () => {
  const run = await runDsh({
    plugins: [plugin],
    script: [
      { tool: 'bash', input: { description: 'Start dev server', command: 'npm run dev' } },
      { tool: 'bash', input: { description: 'Print marker', command: 'echo block-hanging-commands-ok' } },
    ],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.equal(run.toolResults.length, 2, JSON.stringify(run.events))
  const [denied, ran] = run.toolResults
  assert.match(denied!.result, /block-hanging-commands blocked this command/)
  assert.match(denied!.result, /run_in_background/)
  assert.match(ran!.result, /block-hanging-commands-ok/)
  // The model saw the denial text in its next request.
  assert.match(JSON.stringify(run.requests.at(-2)), /block-hanging-commands blocked/)
})

test('run_in_background bypasses the guard', async () => {
  const run = await runDsh({
    plugins: [plugin],
    script: [{ tool: 'bash', input: { description: 'Tail', command: 'tail -f /dev/null', run_in_background: true } }],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.doesNotMatch(run.toolResults[0]!.result, /block-hanging-commands/)
})

test('ask mode routes to approval; headless has no approver so it is denied without running', async () => {
  const run = await runDsh({
    plugins: [{ ...plugin, config: { mode: 'ask' } }],
    script: [{ tool: 'bash', input: { description: 'Edit', command: 'vim notes.txt' } }],
  })
  assert.equal(run.exitCode, 0, run.stderr)
  assert.notEqual(run.toolResults[0]!.status, 'completed')
})

test('installed with `dsh plugin add`, it loads from the profile and honours the user patch layer', async () => {
  const installed = await runDsh({
    installed: true,
    script: [{ tool: 'bash', input: { description: 'Edit', command: 'vim notes.txt' } }],
  })
  assert.equal(installed.exitCode, 0, installed.stderr)
  assert.match(installed.toolResults[0]!.result, /block-hanging-commands blocked this command/)

  const configured = await runDsh({
    installed: true,
    homePatch: '- id: block-hanging-commands\n  config:\n    disabledRules: [server]\n',
    script: [{ tool: 'bash', input: { description: 'Dev server', command: 'npm run dev' } }],
  })
  assert.equal(configured.exitCode, 0, configured.stderr)
  assert.doesNotMatch(configured.toolResults[0]!.result, /block-hanging-commands/)
})
