'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('registered workloads are an immutable in-memory snapshot', async t => {
  const workloads = { fibonacci: { profilers: ['clinic-flame'], executable: 'bench.js' } }
  const server = new ProfileMcpServer({ workloads })
  workloads.fibonacci.executable = 'attacker.js'
  workloads.attacker = { executable: 'attacker.js', profilers: ['clinic-flame'] }

  t.equal(server.workloads.fibonacci.executable, 'bench.js')
  t.notOk(server.workloads.attacker)
  t.equal(Object.isFrozen(server.workloads), true)
  t.equal(Object.isFrozen(server.workloads.fibonacci), true)
  t.end()
})

test('MCP facade uses envelopes and session-bound capabilities', async t => {
  const runner = {
    start: async () => ({ status: 'completed', runId: 'runner-1' })
  }
  const server = new ProfileMcpServer({
    workloads: { smoke: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1, memory_mb: 1 } } },
    runner
  })
  const response = await server.call('start_profile_run', { workload: 'smoke' }, 'req-1')
  t.equal(response.ok, true)
  t.equal(response.data.status, 'completed')
  t.type(response.data.run_capability, 'string')
  const denied = await server.call('get_profile_status', { run_id: response.data.run_id, run_capability: 'wrong' }, 'req-2')
  t.equal(denied.ok, false)
  t.equal(denied.error.code, 'not_found')
  t.end()
})

test('rejects invalid workload parameters before queueing a profile run', async t => {
  let starts = 0
  const server = new ProfileMcpServer({
    workloads: {
      fibonacci: {
        profilers: ['clinic-flame'],
        parameters: { iterations: { type: 'integer', min: 1, max: 10 } },
        limits: { wall_clock_ms: 1000, memory_mb: 64 }
      }
    },
    runner: { start: async () => { starts++; return { status: 'queued' } } }
  })

  const missing = await server.call('start_profile_run', { workload: 'fibonacci' })
  const outOfRange = await server.call('start_profile_run', { workload: 'fibonacci', parameters: { iterations: 11 } })
  const unknown = await server.call('start_profile_run', { workload: 'fibonacci', parameters: { iterations: 2, command: 'rm -rf .' } })

  t.equal(missing.error.code, 'invalid_parameters')
  t.equal(outOfRange.error.code, 'invalid_parameters')
  t.equal(unknown.error.code, 'invalid_parameters')
  t.equal(starts, 0)
  t.equal(server.runs.size, 0)
  t.end()
})

test('findings pages stay bounded and advance after compacting an oversized finding', async t => {
  const server = new ProfileMcpServer({
    workloads: { smoke: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1, memory_mb: 1 } } },
    runner: { start: async () => ({ status: 'completed', runId: 'runner-paged' }) }
  })
  const started = await server.call('start_profile_run', { workload: 'smoke' }, 'req-page-start')
  const report = {
    run: { id: started.data.run_id },
    findings: Array.from({ length: 3 }, (_, index) => ({
      id: `finding-${index + 1}`,
      severity: 'medium',
      category: 'cpu',
      title: `finding ${index + 1} ${'x'.repeat(5000)}`,
      observation: { metric: 'total_cpu_time_pct', values: { total_time_pct: 90 - index } }
    }))
  }
  server.reports.set(started.data.run_id, report)
  const first = await server.call('get_profile_findings', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    page_size: 1,
    max_output_chars: 1024
  }, 'req-page-1')
  t.equal(first.ok, true)
  t.equal(first.data.items[0].truncated, true)
  t.equal(first.data.has_more, true)
  t.ok(JSON.stringify(first.data).length <= 1024)

  const second = await server.call('get_profile_findings', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    page_size: 1,
    max_output_chars: 1024,
    cursor: first.data.next_cursor
  }, 'req-page-2')
  t.equal(second.ok, true)
  t.not(second.data.items[0].id, first.data.items[0].id)
  t.end()
})
