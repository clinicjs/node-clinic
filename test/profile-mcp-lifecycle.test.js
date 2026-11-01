'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

function createServer (runner) {
  return new ProfileMcpServer({
    workloads: {
      smoke: {
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 1000, memory_mb: 64 }
      }
    },
    runner
  })
}

async function startRun (server) {
  return server.call('start_profile_run', {
    workload: 'smoke',
    profiler: 'clinic-flame'
  }, 'req-start')
}

test('start returns the queued state without waiting for run completion', async t => {
  let startCalled = false
  const server = createServer({
    start: async options => {
      startCalled = true
      t.equal(options.workload, 'smoke')
      t.equal(options.profiler, 'clinic-flame')
      return { runId: 'runner-queued', status: 'queued' }
    }
  })

  const response = await startRun(server)
  t.equal(startCalled, true)
  t.equal(response.ok, true)
  t.equal(response.data.status, 'queued')
  t.equal(response.data.run_id != null, true)
  t.end()
})

test('status propagates running progress and then returns the completed report', async t => {
  let state = { status: 'running', startedAt: Date.parse('2026-11-01T12:00:01Z'), progress_pct: 35 }
  let statusRunId
  const report = { run: { status: 'completed', id: 'report-run' }, findings: [] }
  const server = createServer({
    start: async () => ({ runId: 'runner-status', status: 'queued' }),
    status: async runId => {
      statusRunId = runId
      return state
    }
  })
  const started = await startRun(server)
  const auth = { run_id: started.data.run_id, run_capability: started.data.run_capability }

  const running = await server.call('get_profile_status', auth, 'req-running')
  t.equal(statusRunId, 'runner-status')
  t.equal(running.data.status, 'running')
  t.equal(running.data.progress_pct, 35)

  state = { status: 'completed', runId: 'runner-status', report }
  const completed = await server.call('get_profile_status', auth, 'req-completed')
  t.same(completed.data, report)
  t.end()
})

test('status returns the runner failure details instead of hiding them', async t => {
  const runError = { code: 'PROFILE_FAILED', message: 'Clinic collector crashed', retryable: false }
  const server = createServer({
    start: async () => ({ runId: 'runner-failed', status: 'queued' }),
    status: async () => ({ status: 'failed', error: runError })
  })
  const started = await startRun(server)
  const response = await server.call('get_profile_status', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability
  }, 'req-failed')

  t.equal(response.ok, false)
  t.same(response.error, runError)
  t.end()
})

test('cancel waits for and returns the runner cancellation state', async t => {
  let cancelRunId
  let releaseCancel
  const server = createServer({
    start: async () => ({ runId: 'runner-cancel', status: 'running' }),
    cancel: async runId => {
      cancelRunId = runId
      return new Promise(resolve => { releaseCancel = resolve })
    }
  })
  const started = await startRun(server)
  const auth = { run_id: started.data.run_id, run_capability: started.data.run_capability }
  const cancelPromise = server.call('cancel_profile_run', auth, 'req-cancel')
  await new Promise(resolve => setImmediate(resolve))
  t.equal(cancelRunId, 'runner-cancel')
  releaseCancel({ status: 'cancelled' })
  const cancelled = await cancelPromise
  t.equal(cancelled.data.status, 'cancelled')
  t.end()
})

test('cancel preserves a completed state when completion wins the race', async t => {
  const server = createServer({
    start: async () => ({ runId: 'runner-finished', status: 'running' }),
    cancel: async () => ({ status: 'completed' })
  })
  const started = await startRun(server)
  const response = await server.call('cancel_profile_run', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability
  }, 'req-cancel-race')

  t.equal(response.data.status, 'completed')
  t.end()
})
