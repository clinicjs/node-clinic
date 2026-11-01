'use strict'

const test = require('tap').test
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const { ProfileMcpServer } = require('../lib/profile-mcp')
const reportSchema = require('../docs/schemas/performance-report.schema.json')
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validateReport = ajv.compile(reportSchema)

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

test('wait polls the same run until it returns the completed report', async t => {
  let polls = 0
  const report = { run: { status: 'completed', id: 'wait-report' }, findings: [] }
  const server = createServer({
    start: async () => ({ runId: 'runner-wait', status: 'queued' }),
    status: async () => {
      polls++
      return polls < 2 ? { status: 'running', progress_pct: 50 } : { status: 'completed', report }
    }
  })
  const started = await startRun(server)
  const response = await server.call('wait_profile_run', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    timeout_ms: 1000,
    poll_interval_ms: 50
  }, 'req-wait')
  t.equal(polls, 2)
  t.same(response.data, report)
  t.end()
})

test('wait returns the same run state and a bounded next poll hint on timeout', async t => {
  let polls = 0
  const server = createServer({
    start: async () => ({ runId: 'runner-wait-timeout', status: 'running' }),
    status: async () => {
      polls++
      return { status: 'running', progress_pct: 15 }
    }
  })
  const started = await startRun(server)
  const response = await server.call('wait_profile_run', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    timeout_ms: 100,
    poll_interval_ms: 50
  }, 'req-wait-timeout')
  t.equal(response.ok, true)
  t.equal(response.data.run_id, started.data.run_id)
  t.equal(response.data.status, 'running')
  t.equal(response.data.wait_timed_out, true)
  t.equal(response.data.next_poll_after_ms, 50)
  t.ok(polls >= 1)
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

  t.equal(response.ok, true)
  t.equal(response.data.run.status, 'failed')
  t.same(response.data.run.error, runError)
  t.equal(response.data.summary, null)
  t.equal(response.data.findings, null)
  t.equal(validateReport(response.data), true, JSON.stringify(validateReport.errors))
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
  const status = await server.call('get_profile_status', auth, 'req-cancel-status')
  t.equal(status.ok, true)
  t.equal(status.data.run.status, 'cancelled')
  t.equal(status.data.run.error.code, 'PROFILE_CANCELLED')
  t.equal(validateReport(status.data), true, JSON.stringify(validateReport.errors))
  t.end()
})

test('cancel does not claim success when the runner cannot cancel', async t => {
  const server = createServer({
    start: async () => ({ runId: 'runner-no-cancel', status: 'running' }),
    status: async () => ({ status: 'running', progress_pct: 40 })
  })
  const started = await startRun(server)
  const auth = { run_id: started.data.run_id, run_capability: started.data.run_capability }

  const cancelled = await server.call('cancel_profile_run', auth, 'req-no-cancel')
  t.equal(cancelled.ok, false)
  t.equal(cancelled.error.code, 'cancellation_unavailable')

  const current = await server.call('get_profile_status', auth, 'req-still-running')
  t.equal(current.ok, true)
  t.equal(current.data.status, 'running')
  t.equal(current.data.progress_pct, 40)
  t.end()
})

test('cancel reports unconfirmed when the runner remains active', async t => {
  const server = createServer({
    start: async () => ({ runId: 'runner-cancel-pending', status: 'running' }),
    cancel: async () => ({ status: 'running', progress_pct: 55 }),
    status: async () => ({ status: 'running', progress_pct: 55 })
  })
  const started = await startRun(server)
  const auth = { run_id: started.data.run_id, run_capability: started.data.run_capability }

  const cancelled = await server.call('cancel_profile_run', auth, 'req-cancel-pending')
  t.equal(cancelled.ok, false)
  t.equal(cancelled.error.code, 'cancellation_unconfirmed')

  const current = await server.call('get_profile_status', auth, 'req-still-active')
  t.equal(current.ok, true)
  t.equal(current.data.status, 'running')
  t.equal(current.data.progress_pct, 55)
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
