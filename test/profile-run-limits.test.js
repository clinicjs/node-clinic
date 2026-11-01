'use strict'

const test = require('tap').test
const { createRunManager } = require('../lib/profile-runner')
const { ProfileMcpServer } = require('../lib/profile-mcp')

function tick () {
  return new Promise(resolve => setImmediate(resolve))
}

async function waitForStatus (manager, runId, expected) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await manager.status(runId)
    if (status && status.status === expected) return status
    await tick()
  }
  throw new Error(`run ${runId} did not reach ${expected}`)
}

test('run manager rejects concurrent starts at the configured limit', async t => {
  let finishFirst
  const manager = createRunManager(() => new Promise(resolve => { finishFirst = resolve }), {
    maxConcurrent: 1,
    maxStoredRuns: 5
  })

  const first = await manager.start({ runId: 'concurrent-one' })
  t.equal(first.status, 'queued')
  await t.throws(() => manager.start({ runId: 'concurrent-two' }), { code: 'RUN_LIMIT' })

  await tick()
  finishFirst({ status: 'completed' })
  t.equal((await waitForStatus(manager, 'concurrent-one', 'completed')).status, 'completed')
  const afterCompletion = await manager.start({ runId: 'concurrent-two' })
  t.equal(afterCompletion.status, 'queued')
})

test('run manager enforces the stored-run limit until retention expires', async t => {
  const manager = createRunManager(async () => ({ status: 'completed' }), {
    maxConcurrent: 1,
    maxStoredRuns: 1,
    retentionMs: 60000
  })

  await manager.start({ runId: 'stored-one' })
  await waitForStatus(manager, 'stored-one', 'completed')
  await t.throws(() => manager.start({ runId: 'stored-two' }), { code: 'RUN_LIMIT' })
})

test('run manager prunes completed entries after the retention period', async t => {
  const manager = createRunManager(async () => ({ status: 'completed' }), {
    maxConcurrent: 1,
    maxStoredRuns: 1,
    retentionMs: 20
  })

  await manager.start({ runId: 'retained-one' })
  await waitForStatus(manager, 'retained-one', 'completed')
  await new Promise(resolve => setTimeout(resolve, 35))

  const next = await manager.start({ runId: 'retained-two' })
  t.equal(next.status, 'queued')
  t.equal(await manager.status('retained-one'), null)
})

test('MCP prunes expired runs, reports, and approvals on the next run-scoped request', async t => {
  let now = 1000
  const server = new ProfileMcpServer({
    now: () => now,
    ttlMs: 50,
    approvalTtlMs: 25,
    workloads: {
      small: {
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 1000, memory_mb: 64 }
      },
      expensive: {
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 40000, memory_mb: 64 }
      }
    },
    runner: {
      start: async () => ({
        runId: 'runner-small',
        status: 'completed',
        report: { run: { status: 'completed' }, findings: [] }
      })
    }
  })

  const run = await server.call('start_profile_run', { workload: 'small' }, 'req-small')
  const approval = await server.call('start_profile_run', { workload: 'expensive' }, 'req-expensive')
  t.type(approval.error.approval_token, 'string')
  t.ok(server.runs.has(run.data.run_id))
  t.ok(server.reports.has(run.data.run_id))
  t.equal(server.approvals.size, 1)

  now += 50
  const expired = await server.call('get_profile_status', {
    run_id: run.data.run_id,
    run_capability: run.data.run_capability
  }, 'req-expired')

  t.equal(expired.ok, false)
  t.equal(expired.error.code, 'not_found')
  t.notOk(server.runs.has(run.data.run_id))
  t.notOk(server.reports.has(run.data.run_id))
  t.equal(server.approvals.size, 0)
})
