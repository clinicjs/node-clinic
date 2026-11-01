'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')
const { validateToolResponse } = require('../lib/profile-runtime-schemas')
const { analyzeClinicFlame, compareReports, findingDetail } = require('../lib/profile-analyzer')

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

test('workload list pagination uses session-bound opaque cursors', async t => {
  const workloads = Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`workload-${index}`, { profilers: ['clinic-flame'] }]))
  const server = new ProfileMcpServer({ workloads, sessionId: 'session-a' })
  const otherSession = new ProfileMcpServer({ workloads, sessionId: 'session-b' })
  const first = await server.call('list_profile_workloads', { page_size: 1 })
  t.equal(first.data.items[0].id, 'workload-0')
  t.equal(first.data.has_more, true)
  t.type(first.data.next_cursor, 'string')
  const second = await server.call('list_profile_workloads', { page_size: 1, cursor: first.data.next_cursor })
  t.equal(second.data.items[0].id, 'workload-1')
  t.equal(second.data.has_more, true)
  const forged = await server.call('list_profile_workloads', { page_size: 1, cursor: 'forged-cursor-value-1234567890' })
  t.equal(forged.error.code, 'invalid_cursor')
  const crossSession = await otherSession.call('list_profile_workloads', { page_size: 1, cursor: first.data.next_cursor })
  t.equal(crossSession.error.code, 'invalid_cursor')
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

test('incompatible comparisons return reasons without a regression delta', async t => {
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1000, memory_mb: 64 } } },
    analyzer: { compare: compareReports },
    runner: { start: async () => ({ status: 'completed' }) }
  })
  const candidate = await server.call('start_profile_run', { workload: 'fibonacci' })
  const baseline = await server.call('start_profile_run', { workload: 'fibonacci' })
  const shared = {
    workload: 'fibonacci',
    profiler: 'clinic-flame',
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    runtime: { node_version: 'node-v24.0.0', toolchain_digest: 'sha256-' + 'b'.repeat(64) },
    isolation: { provider: 'systemd-bubblewrap', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 64, artifact_mb: 1, network: 'disabled' } },
    repository: 'example/project',
    measurement: { samples: [10, 12, 11], warmup_count: 1, value_field: 'throughput', max_wall_clock_ms: 1000, elapsed_ms: 300, unit: 'ops_per_second', definition: 'completed operations per second' }
  }
  server.reports.set(candidate.data.run_id, analyzeClinicFlame({ nodes: [], sample_count: 100 }, { ...shared, run_id: candidate.data.run_id, commit: 'a'.repeat(40), input_digest: 'sha256-' + 'c'.repeat(64) }))
  server.reports.set(baseline.data.run_id, analyzeClinicFlame({ nodes: [], sample_count: 100 }, { ...shared, run_id: baseline.data.run_id, commit: 'b'.repeat(40), input_digest: 'sha256-' + 'd'.repeat(64) }))
  const response = await server.call('compare_profile_runs', {
    candidate_run_id: candidate.data.run_id,
    candidate_run_capability: candidate.data.run_capability,
    baseline_run_id: baseline.data.run_id,
    baseline_run_capability: baseline.data.run_capability
  })
  t.equal(response.ok, true)
  t.equal(response.data.compatibility, 'incompatible')
  t.ok(response.data.reasons.includes('incompatible_baseline'))
  t.notOk(Object.prototype.hasOwnProperty.call(response.data, 'delta_pct'))
  t.notOk(Object.prototype.hasOwnProperty.call(response.data, 'finding_changes'))
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
  t.same(validateToolResponse('get_profile_findings', first), [])
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
  t.same(validateToolResponse('get_profile_findings', second), [])
  t.end()
})

test('MCP finding detail returns the selected Flame subtree', async t => {
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1000, memory_mb: 64 } } },
    runner: { start: async () => ({ status: 'completed', runId: 'runner-tree' }) },
    analyzer: { detail: findingDetail }
  })
  const started = await server.call('start_profile_run', { workload: 'fibonacci' })
  const report = analyzeClinicFlame({
    nodes: [{ node_id: 'hot-node', name: 'hotFunction', self_time_pct: 20, total_time_pct: 60 }],
    call_tree: {
      node_id: 'root',
      name: '(root)',
      self_time_pct: 0,
      total_time_pct: 100,
      children: [{ node_id: 'hot-node', name: 'hotFunction', self_time_pct: 20, total_time_pct: 60, children: [] }]
    }
  }, { run_id: started.data.run_id, workload: 'fibonacci' })
  server.reports.set(started.data.run_id, report)
  const response = await server.call('get_finding_detail', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    finding_id: report.findings[0].id
  })
  t.equal(response.ok, true)
  t.equal(response.data.classification, 'sensitive-diagnostic')
  t.equal(response.data.call_tree.root.name, 'hotFunction')
  t.equal(response.data.call_tree.node_count, 1)
  t.end()
})

test('MCP sanitizes untrusted report strings before returning them', async t => {
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    runner: { start: async () => ({ status: 'completed' }) },
    analyzer: {
      detail: async () => ({
        finding: { id: 'finding-1', title: 'token=private-value from /home/user/project' },
        call_tree: null,
        source_context: { available: true, lines: [{ line: 1, text: '\u001b[31mpassword=secret-value\u001b[0m' }] },
        detail_limits: { source_context_lines: 1 }
      })
    }
  })
  const started = await server.call('start_profile_run', { workload: 'fibonacci' })
  server.reports.set(started.data.run_id, { findings: [{ id: 'finding-1', severity: 'low' }], artifacts: [] })
  const response = await server.call('get_finding_detail', {
    run_id: started.data.run_id,
    run_capability: started.data.run_capability,
    finding_id: 'finding-1'
  })
  const text = JSON.stringify(response)
  t.notMatch(text, /private-value|secret-value|\/home\/user|\u001b/) // eslint-disable-line no-control-regex
  t.match(text, /\[REDACTED\]|\[PATH\]/)
  t.equal(response.data.classification, 'sensitive-diagnostic')
  t.end()
})
