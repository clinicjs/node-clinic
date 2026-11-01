'use strict'

const t = require('tap')
const { analyzeClinicFlame, normalizeNodes } = require('../lib/profile-analyzer')

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
    runtime: { node_version: 'node-v24.21.0', toolchain_digest: 'sha256-' + 'a'.repeat(64) },
    architecture: 'linux-x64',
    repository: 'clinicjs/node-clinic',
    artifact_ref: 'artifact_' + 'a'.repeat(22)
  })
  t.equal(report.schema_version, 1)
  t.equal(report.findings.length, 20)
  t.equal(report.findings[0].severity, 'high')
  t.equal(report.summary.throughput.unit, 'ops_per_second')
  t.equal(report.usage.truncated, true)
  t.equal(report.run.compatibility.repository.revision, report.run.commit)
  t.end()
})
