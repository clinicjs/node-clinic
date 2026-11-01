'use strict'

const t = require('tap')
const { analyzeClinicFlame, normalizeNodes, compareReports } = require('../lib/profile-analyzer')

t.test('normalizes and deterministically ranks flame nodes', t => {
  const nodes = normalizeNodes({
    nodes: [
      { name: 'slow', self_time_pct: 5, total_time_pct: 60, file: 'a.js', line: 2 },
      { name: 'fast', self_time_pct: 4, total_time_pct: 10, file: 'b.js', line: 1 }
    ]
  })
  t.equal(nodes[0].name, 'slow')
  t.equal(nodes[0].total, 60)
  t.end()
})

t.test('emits bounded profiler-neutral report', t => {
  const report = analyzeClinicFlame({
    duration_ms: 100,
    nodes: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, total_time_pct: i === 24 ? 60 : i, self_time_pct: i / 2 })),
    throughput: { value: 12, unit: 'ops_per_second', definition: 'completed operations / measured seconds' }
  }, {
    now: '2026-01-01T00:00:00.000Z',
    workload: 'demo',
    commit: '0123456789abcdef0123456789abcdef01234567',
    manifest_hash: 'sha256-' + 'f'.repeat(64),
    runtime: { node_version: 'node-v24.21.0', toolchain_digest: 'sha256-' + 'a'.repeat(64) },
    isolation: { provider: 'direct-host', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 1, network: 'disabled' } },
    architecture: 'linux-x64',
    repository: 'clinicjs/node-clinic',
    artifact_ref: 'artifact_' + 'a'.repeat(22)
  })
  t.equal(report.schema_version, 1)
  t.equal(report.findings.length, 20)
  t.equal(report.findings[0].severity, 'high')
  t.equal(report.summary.throughput.unit, 'ops_per_second')
  t.equal(report.usage.truncated, true)
  t.notOk(Object.prototype.hasOwnProperty.call(report.findings[0].evidence, 'sample_count'))
  t.equal(report.run.compatibility.repository.revision, report.run.commit)
  t.end()
})

t.test('includes sample count only when collector provides a real count', t => {
  const profile = { nodes: [{ name: 'cpuWork', self_time_pct: 20, total_time_pct: 40 }] }
  const withoutSamples = analyzeClinicFlame(profile, { workload: 'demo' })
  const withSamples = analyzeClinicFlame({ ...profile, sample_count: 17 }, { workload: 'demo', sample_count: 17 })
  t.notOk(Object.prototype.hasOwnProperty.call(withoutSamples.findings[0].evidence, 'sample_count'))
  t.equal(withSamples.findings[0].evidence.sample_count, 17)
  t.end()
})

t.test('does not invent compatibility identity when metadata is missing', t => {
  const report = analyzeClinicFlame({ nodes: [] }, { workload: 'demo' })
  t.equal(report.run.commit, null)
  t.equal(report.run.compatibility, null)
  t.end()
})

t.test('reports descriptive single-run delta without inventing a confidence interval', t => {
  const compatibility = {
    workload: 'demo',
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    profiler: { name: 'clinic-flame', adapter_version: '1', configuration_digest: 'sha256-' + 'b'.repeat(64), canonicalization_version: '1' },
    input_digest: 'sha256-' + 'c'.repeat(64),
    isolation: { provider: 'local', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 1, network: 'disabled' } },
    runtime: { node_version: 'node-v24.21.0', toolchain_digest: 'sha256-' + 'd'.repeat(64) },
    architecture: 'linux-x64',
    repository: { identity: 'clinicjs/node-clinic', revision: '0123456789abcdef0123456789abcdef01234567' }
  }
  const report = value => ({
    run: { id: value === 100 ? 'candidate' : 'baseline', compatibility },
    summary: { throughput: { value, unit: 'ops_per_second', definition: 'completed operations / measured seconds' } }
  })
  const comparison = compareReports(report(110), report(100))
  t.equal(comparison.compatibility, 'compatible')
  t.equal(comparison.delta_pct, 10)
  t.same(comparison.candidate_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.same(comparison.baseline_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.not(comparison.candidate_uncertainty.method, 'bootstrap_95_ci')
  t.end()
})
