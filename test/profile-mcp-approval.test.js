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
        limits: { wall_clock_ms: 40000, cpu_ms: 40000, memory_mb: 64, artifact_mb: 10 },
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
  t.same(pending.error.resource_cost_estimate, { basis: 'declared_limits', wall_clock_ms: 40000, cpu_ms: 40000, memory_mb: 64, artifact_mb: 10 })

  const approved = await server.call('approve_profile_run', { approval_token: token })
  t.equal(approved.ok, true)
  t.same(approved.data.resource_cost_estimate, pending.error.resource_cost_estimate)
  const duplicateApproval = await server.call('approve_profile_run', { approval_token: token })
  t.equal(duplicateApproval.error.code, 'approval_already_resolved')
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

test('run capabilities and approval tokens cannot exceed RFC lifetime limits', async t => {
  const now = 1000
  const server = new ProfileMcpServer({
    now: () => now,
    ttlMs: 48 * 60 * 60 * 1000,
    approvalTtlMs: 60 * 60 * 1000,
    workloads: {
      long: {
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 40000, cpu_ms: 40000, memory_mb: 64, artifact_mb: 10 },
        parameters: {}
      }
    },
    runner: { start: async () => ({ status: 'queued' }) }
  })
  const pending = await server.call('start_profile_run', { workload: 'long' })
  t.equal(server.ttlMs, 24 * 60 * 60 * 1000)
  const approval = [...server.approvals.values()][0]
  t.equal(approval.expiresAt - now, 10 * 60 * 1000)
  const approved = await server.call('approve_profile_run', { approval_token: pending.error.approval_token })
  t.equal(approved.ok, true)
  const started = await server.call('start_profile_run', { workload: 'long', approval_token: pending.error.approval_token })
  t.equal(started.ok, true)
  t.equal(server.runs.get(started.data.run_id).expiresAt - now, 24 * 60 * 60 * 1000)
  t.end()
})
