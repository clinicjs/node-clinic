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
      maxWindowOutputTokens: 1000,
      maxSessionInputTokens: 100,
      maxSessionOutputTokens: 1000,
      maxProcessInputTokens: 100,
      maxProcessOutputTokens: 1000,
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
  server.budgets.maxWindowOutputTokens = 1000
  const afterWindow = await server.call('list_profile_workloads', {})
  t.equal(afterWindow.ok, true)
  t.ok(afterWindow.usage.window_output_tokens_remaining < 1000)
  t.end()
})

test('enforces a separate token budget for run-scoped requests', async t => {
  let statusCalls = 0
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    runner: {
      start: async () => ({ status: 'queued', runId: 'runner-run-budget' }),
      status: async () => { statusCalls++; return { status: 'running' } }
    }
  })
  const started = await server.call('start_profile_run', { workload: 'fibonacci' })
  t.equal(started.ok, true)
  t.ok(started.usage.run_input_tokens_remaining > 0)

  const runId = started.data.run_id
  server.budgets.maxRunInputTokens = server.runUsage.get(runId).inputTokens
  const response = await server.call('get_profile_status', { run_id: runId, run_capability: started.data.run_capability })
  t.equal(response.error.code, 'run_budget_exceeded')
  t.equal(statusCalls, 0)
  t.end()
})

test('does not poll a run after its output budget is exhausted', async t => {
  let statusCalls = 0
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    runner: {
      start: async () => ({ status: 'queued', runId: 'runner-output-budget' }),
      status: async () => { statusCalls++; return { status: 'running' } }
    }
  })
  const started = await server.call('start_profile_run', { workload: 'fibonacci' })
  t.equal(started.ok, true)

  server.budgets.maxRunOutputTokens = server.runUsage.get(started.data.run_id).outputTokens
  const response = await server.call('get_profile_status', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability
  })
  t.equal(response.error.code, 'run_budget_exceeded')
  t.equal(statusCalls, 0)
  t.end()
})
