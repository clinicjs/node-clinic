'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('approval is bound to workload, profiler, parameters, and manifest identity', async t => {
  let starts = 0
  const server = new ProfileMcpServer({
    manifestHash: 'sha256-original',
    workloads: {
      fibonacci: {
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 40000, memory_mb: 64 },
        parameters: { iterations: { type: 'integer', min: 1, max: 5 } }
      }
    },
    runner: { start: async () => { starts++; return { status: 'queued', runId: 'approved-run' } } }
  })
  const request = { workload: 'fibonacci', profiler: 'clinic-flame', parameters: { iterations: 2 } }
  const pending = await server.call('start_profile_run', request)
  t.equal(pending.error.code, 'approval_required')
  const token = pending.error.approval_token
  t.ok(token)

  const approved = await server.call('approve_profile_run', { approval_token: token })
  t.equal(approved.ok, true)
  server.manifestHash = 'sha256-changed'
  const changedManifest = await server.call('start_profile_run', { ...request, approval_token: token })
  t.equal(changedManifest.error.code, 'invalid_approval')
  t.equal(starts, 0)

  server.manifestHash = 'sha256-original'
  const started = await server.call('start_profile_run', { ...request, approval_token: token })
  t.equal(started.ok, true)
  t.equal(started.data.status, 'queued')
  t.equal(starts, 1)
  const reused = await server.call('start_profile_run', { ...request, approval_token: token })
  t.equal(reused.error.code, 'invalid_approval')
  t.end()
})
