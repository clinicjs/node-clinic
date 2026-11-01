'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('rejects oversized start input before invoking the runner', async t => {
  let starts = 0
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    runner: { start: async () => { starts++; return { status: 'queued' } } },
    budgets: { maxInputCharsPerCall: 200 }
  })
  const response = await server.call('start_profile_run', {
    workload: 'fibonacci',
    parameters: { iterations: 1, note: 'x'.repeat(500) }
  })
  t.equal(response.error.code, 'request_too_large')
  t.equal(starts, 0)
  t.end()
})

test('tracks estimated input/output tokens and enforces session and window budgets', async t => {
  let now = 1000
  const server = new ProfileMcpServer({
    workloads: {},
    now: () => now,
    budgets: {
      maxWindowInputTokens: 100,
      maxWindowOutputTokens: 100,
      maxSessionInputTokens: 100,
      maxSessionOutputTokens: 100,
      maxProcessInputTokens: 100,
      maxProcessOutputTokens: 100,
      windowMs: 1000
    }
  })
  const first = await server.call('list_profile_workloads', {})
  t.equal(first.ok, true)
  t.ok(first.usage.estimated_input_tokens > 0)
  t.ok(first.usage.estimated_output_tokens > 0)
  t.equal(first.usage.token_counts_are_estimates, true)

  server.budgets.maxWindowOutputTokens = server.usage.windowOutputTokens
  const rejected = await server.call('list_profile_workloads', {})
  t.equal(rejected.error.code, 'output_budget_exceeded')

  now += 1001
  server.budgets.maxWindowOutputTokens = 100
  const afterWindow = await server.call('list_profile_workloads', {})
  t.equal(afterWindow.ok, true)
  t.ok(afterWindow.usage.window_output_tokens_remaining < 100)
  t.end()
})
