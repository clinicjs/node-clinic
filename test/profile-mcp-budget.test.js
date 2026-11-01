'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('deployment budget overrides can lower defaults but cannot raise them', t => {
  const server = new ProfileMcpServer({
    budgets: {
      maxOutputCharsPerCall: 20000,
      maxRunTokens: 100000,
      maxSessionTokens: 128000,
      maxWindowTokens: 500000
    }
  })
  t.equal(server.budgets.maxOutputCharsPerCall, 12000)
  t.equal(server.budgets.maxRunTokens, 64000)
  t.equal(server.budgets.maxSessionTokens, 128000)
  t.equal(server.budgets.maxWindowTokens, 500000)
  t.end()
})

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
      maxWindowTokens: 1000,
      maxSessionTokens: 1000,
      maxProcessTokens: 1000,
      windowMs: 1000
    }
  })
  const first = await server.call('list_profile_workloads', {})
  t.equal(first.ok, true)
  t.ok(first.usage.estimated_input_tokens > 0)
  t.ok(first.usage.estimated_output_tokens > 0)
  t.equal(first.usage.token_counts_are_estimates, true)
  t.equal(first.usage.session_tokens_remaining, server.budgets.maxSessionTokens - server.usage.sessionInputTokens - server.usage.sessionOutputTokens)

  server.budgets.maxWindowTokens = server.usage.windowInputTokens + server.usage.windowOutputTokens + first.usage.estimated_input_tokens + 1
  const rejected = await server.call('list_profile_workloads', {})
  t.equal(rejected.error.code, 'output_budget_exceeded')

  now += 1001
  server.budgets.maxWindowTokens = 1000
  const afterWindow = await server.call('list_profile_workloads', {})
  t.equal(afterWindow.ok, true)
  t.ok(afterWindow.usage.window_tokens_remaining < 1000)
  t.end()
})

test('uses a rolling window and expires usage by each call timestamp', async t => {
  let now = 0
  const server = new ProfileMcpServer({
    workloads: {},
    now: () => now,
    budgets: { windowMs: 100 }
  })
  const first = await server.call('list_profile_workloads', {})
  now = 50
  const second = await server.call('list_profile_workloads', {})
  now = 101
  const third = await server.call('list_profile_workloads', {})

  t.equal(server.usage.windowInputTokens, second.usage.estimated_input_tokens + third.usage.estimated_input_tokens)
  t.equal(server.usage.windowOutputTokens, second.usage.estimated_output_tokens + third.usage.estimated_output_tokens)
  t.not(server.usage.windowInputTokens, first.usage.estimated_input_tokens + second.usage.estimated_input_tokens + third.usage.estimated_input_tokens)
  t.end()
})

test('enforces an aggregate token budget for run-scoped requests', async t => {
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
  t.ok(started.usage.run_tokens_remaining > 0)

  const runId = started.data.run_id
  const charged = server.runUsage.get(runId)
  t.equal(started.usage.run_tokens_remaining, server.budgets.maxRunTokens - charged.inputTokens - charged.outputTokens)
  const currentRunTokens = server.runUsage.get(runId).inputTokens + server.runUsage.get(runId).outputTokens
  server.budgets.maxRunTokens = currentRunTokens
  const response = await server.call('get_profile_status', { run_id: runId, run_capability: started.data.run_capability })
  t.equal(response.error.code, 'run_budget_exceeded')
  t.equal(statusCalls, 0)
  t.end()
})

test('rejects a run before starting when its input and response exceed the run budget', async t => {
  let starts = 0
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    runner: { start: async () => { starts++; return { status: 'queued' } } },
    budgets: { maxRunTokens: 1 }
  })
  const response = await server.call('start_profile_run', { workload: 'fibonacci' })
  t.equal(response.error.code, 'output_budget_exceeded')
  t.equal(starts, 0)
  t.end()
})
