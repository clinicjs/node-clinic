'use strict'

const t = require('tap')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { analyzeClinicFlame, normalizeNodes, compareReports, findingDetail } = require('../lib/profile-analyzer')
const { validateReportSemantics } = require('../lib/profile-semantic-validator')

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
  t.equal(report.summary.findings_truncated, true)
  t.equal(report.findings[0].severity, 'high')
  t.equal(report.summary.throughput.unit, 'ops_per_second')
  t.equal(report.usage, null)
  t.notOk(Object.prototype.hasOwnProperty.call(report.findings[0].evidence, 'sample_count'))
  t.equal(report.run.compatibility.repository.revision, report.run.commit)
  t.equal(report.run.exit_code, null)
  t.equal(report.run.termination_reason, 'completed')
  t.end()
})

t.test('records the exit code and termination reason supplied by the runner', t => {
  const report = analyzeClinicFlame({ nodes: [] }, {
    workload: 'demo',
    exit_code: 7,
    termination_reason: 'process_failed'
  })
  t.equal(report.run.exit_code, 7)
  t.equal(report.run.termination_reason, 'process_failed')
  t.end()
})

t.test('includes sample count only when collector provides a real count', t => {
  const profile = { nodes: [{ name: 'cpuWork', self_time_pct: 20, total_time_pct: 40 }] }
  const withoutSamples = analyzeClinicFlame(profile, { workload: 'demo' })
  const withSamples = analyzeClinicFlame({ ...profile, sample_count: 17 }, { workload: 'demo', sample_count: 17 })
  t.notOk(Object.prototype.hasOwnProperty.call(withoutSamples.findings[0].evidence, 'sample_count'))
  t.equal(withoutSamples.findings[0].confidence, 'low')
  t.equal(withoutSamples.findings[0].evidence.confidence_basis, 'profiler_sample_count_unavailable')
  t.equal(withSamples.findings[0].evidence.sample_count, 17)
  t.equal(withSamples.findings[0].confidence, 'medium')
  t.equal(withSamples.findings[0].evidence.confidence_basis, 'profiler_sample_count')
  const fromProfile = analyzeClinicFlame({ ...profile, sample_count: 17 }, { workload: 'demo' })
  t.equal(fromProfile.findings[0].evidence.sample_count, 17)
  t.equal(fromProfile.findings[0].confidence, 'medium')
  const highConfidence = analyzeClinicFlame(profile, { workload: 'demo', sample_count: 100 })
  t.equal(highConfidence.findings[0].confidence, 'high')
  t.equal(highConfidence.summary.confidence, 'high')
  t.end()
})

t.test('reports measured throughput as the median of explicit samples', t => {
  const report = analyzeClinicFlame({ nodes: [] }, {
    workload: 'demo',
    measurement: {
      samples: [12, 30, 18, 22],
      warmup_count: 3,
      value_field: 'throughput',
      max_wall_clock_ms: 30000,
      elapsed_ms: 500,
      unit: 'ops_per_second',
      definition: 'completed operations divided by measured seconds'
    }
  })
  t.equal(report.summary.throughput.value, 20)
  t.same(report.summary.measurement.samples, [12, 30, 18, 22])
  t.equal(report.summary.measurement.sample_count, 4)
  t.same(validateReportSemantics(report), [])
  report.summary.throughput.value = 19
  t.same(validateReportSemantics(report).map(error => error.code), ['measurement_median_mismatch'])
  t.end()
})

t.test('does not invent compatibility identity when metadata is missing', t => {
  const report = analyzeClinicFlame({ nodes: [] }, { workload: 'demo' })
  t.equal(report.run.commit, null)
  t.equal(report.run.compatibility, null)
  t.end()
})

t.test('truncates profiler-derived labels and paths to bound report size', t => {
  const report = analyzeClinicFlame({ nodes: [{ name: 'x'.repeat(10000), file: 'src/' + 'y'.repeat(10000), line: 1, self_time_pct: 1, total_time_pct: 10 }] }, { workload: 'demo' })
  t.ok(report.findings[0].title.length <= 240)
  t.ok(report.findings[0].location.file.length <= 240)
  t.ok(JSON.stringify(report).length < 2000)
  const absolutePath = analyzeClinicFlame({ nodes: [{ name: 'outside', file: '/home/user/project.js', line: 1, total_time_pct: 1 }] }, { workload: 'demo' })
  t.equal(absolutePath.findings[0].location, null)
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
    run: {
      id: value === 100 ? 'candidate' : 'baseline',
      compatibility: {
        ...compatibility,
        repository: { ...compatibility.repository, revision: value === 110 ? 'a'.repeat(40) : 'b'.repeat(40) }
      }
    },
    summary: { throughput: { value, unit: 'ops_per_second', definition: 'completed operations / measured seconds' } }
  })
  const comparison = compareReports(report(110), report(100))
  t.equal(comparison.compatibility, 'compatible')
  t.equal(comparison.delta_pct, 10)
  t.same(comparison.candidate_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.same(comparison.baseline_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.same(comparison.delta_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.not(comparison.candidate_uncertainty.method, 'bootstrap_95_ci')
  t.end()
})

t.test('bootstraps repeated throughput measurements with a deterministic delta interval', t => {
  const compatibility = {
    workload: 'demo',
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    profiler: { name: 'clinic-flame', adapter_version: '1', configuration_digest: 'sha256-' + 'b'.repeat(64), canonicalization_version: '1' },
    input_digest: 'sha256-' + 'c'.repeat(64),
    isolation: { provider: 'local', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 1, network: 'disabled' } },
    runtime: { node_version: 'node-v24.21.0', toolchain_digest: 'sha256-' + 'd'.repeat(64) },
    architecture: 'linux-x64',
    repository: { identity: 'clinicjs/node-clinic', revision: 'a'.repeat(40) }
  }
  const report = (id, revision, samples) => {
    const sorted = samples.slice().sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    return {
      run: { id, compatibility: { ...compatibility, repository: { ...compatibility.repository, revision } } },
      summary: {
        throughput: { value, unit: 'ops_per_second', definition: 'completed operations / measured seconds' },
        measurement: { samples, sample_count: samples.length, warmup_count: 3 }
      }
    }
  }
  const candidate = report('candidate', 'b'.repeat(40), [108, 112, 110, 114, 106])
  const baseline = report('baseline', 'a'.repeat(40), [98, 102, 100, 104, 96])
  const comparison = compareReports(candidate, baseline)
  const repeated = compareReports(candidate, baseline)
  t.equal(comparison.compatibility, 'compatible')
  t.equal(comparison.candidate_sample_count, 5)
  t.equal(comparison.baseline_sample_count, 5)
  t.equal(comparison.delta_pct, 10)
  t.equal(comparison.candidate_uncertainty.method, 'bootstrap_95_ci')
  t.equal(comparison.delta_uncertainty.method, 'bootstrap_95_ci')
  t.equal(comparison.delta_uncertainty.low_pct <= comparison.delta_pct, true)
  t.equal(comparison.delta_uncertainty.high_pct >= comparison.delta_pct, true)
  t.same(repeated, comparison)

  const slowerCandidate = report('slower-candidate', 'c'.repeat(40), [88, 92, 90, 94, 86])
  const regression = compareReports(slowerCandidate, baseline)
  t.equal(regression.delta_pct, -10)
  t.equal(regression.delta_uncertainty.high_pct < 0, true)
  t.end()
})

t.test('compares bounded finding deltas alongside throughput changes', t => {
  const options = revision => ({
    workload: 'fibonacci',
    commit: revision,
    repository: 'sha256-' + 'e'.repeat(64),
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    runtime: { node_version: 'node-v24.21.0', toolchain_digest: 'sha256-' + 'b'.repeat(64) },
    isolation: { provider: 'direct-host', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 1, network: 'disabled' } }
  })
  const report = (revision, names) => analyzeClinicFlame({
    nodes: names.map(([name, total]) => ({ name, file: `src/${name}.js`, line: 1, self_time_pct: total / 2, total_time_pct: total })),
    throughput: { value: revision === 'a'.repeat(40) ? 100 : 110, unit: 'ops_per_second', definition: 'completed operations / measured seconds' }
  }, options(revision))
  const baseline = report('a'.repeat(40), [['hot', 10], ['removed', 8]])
  const candidate = report('b'.repeat(40), [['hot', 20], ['added', 12]])
  const comparison = compareReports(candidate, baseline)
  t.equal(comparison.compatibility, 'compatible')
  t.equal(comparison.finding_changes.complete, true)
  t.same(comparison.finding_changes.items.map(change => change.kind).sort(), ['baseline_only', 'candidate_only', 'changed'])
  t.equal(comparison.finding_changes.total, 3)
  t.end()
})

t.test('returns bounded source context only for paths inside the workspace', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-source-detail-'))
  const source = path.join(root, 'workload.js')
  fs.writeFileSync(source, 'one\ntwo\nthree\nfour\nfive\n')
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const finding = { id: 'finding-001', location: { file: 'workload.js', line: 3 } }
  const detail = findingDetail({}, finding, { source_root: root, source_context_lines: 3, top_k: 4, max_depth: 2 })
  t.equal(detail.call_tree, null)
  t.same(detail.source_context.lines, [{ line: 2, text: 'two' }, { line: 3, text: 'three' }, { line: 4, text: 'four' }])
  t.equal(detail.source_context.available, true)
  const outside = findingDetail({}, { ...finding, location: { file: '/etc/passwd', line: 1 } }, { source_root: root, source_context_lines: 3 })
  t.equal(outside.source_context.available, false)
  t.equal(outside.source_context.reason, 'source_outside_workspace')

  const normalized = analyzeClinicFlame({ nodes: [{ name: 'work', file: source, line: 2, total_time_pct: 50 }] }, { source_root: root })
  t.same(normalized.findings[0].location, { file: 'workload.js', line: 2 })
  const outsideProfile = analyzeClinicFlame({ nodes: [{ name: 'work', file: '/etc/passwd', line: 1, total_time_pct: 50 }] }, { source_root: root })
  t.equal(outsideProfile.findings[0].location, null)

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-source-outside-'))
  fs.writeFileSync(path.join(outsideDir, 'secret.js'), 'secret')
  fs.symlinkSync(outsideDir, path.join(root, 'linked'))
  const symlinkFinding = { ...finding, location: { file: 'linked/secret.js', line: 1 } }
  const symlinkDetail = findingDetail({}, symlinkFinding, { source_root: root, source_context_lines: 1 })
  t.equal(symlinkDetail.source_context.available, false)
  const symlinkProfile = analyzeClinicFlame({ nodes: [{ name: 'work', file: path.join(root, 'linked', 'secret.js'), line: 1, total_time_pct: 50 }] }, { source_root: root })
  t.equal(symlinkProfile.findings[0].location, null)
  fs.rmSync(outsideDir, { recursive: true, force: true })
  t.end()
})

t.test('resolves source context only inside declared input mounts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-declared-source-'))
  const inputRoot = path.join(root, 'corpus')
  fs.mkdirSync(inputRoot)
  fs.writeFileSync(path.join(inputRoot, 'case.js'), 'first\nsecond\nthird\n')
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceRoots = [
    { root, virtualRoot: '/workspace', reportPrefix: '' },
    { root: inputRoot, virtualRoot: '/inputs/corpus', reportPrefix: 'inputs/corpus' }
  ]
  const report = analyzeClinicFlame({ nodes: [{ name: 'inputWork', file: '/inputs/corpus/case.js', line: 2, total_time_pct: 40 }] }, {
    workload: 'fibonacci',
    source_roots: sourceRoots
  })
  t.same(report.findings[0].location, { file: 'inputs/corpus/case.js', line: 2 })
  const detail = findingDetail(report, report.findings[0], { source_roots: sourceRoots, source_context_lines: 2 })
  t.equal(detail.source_context.available, true)
  t.same(detail.source_context.lines, [{ line: 1, text: 'first' }, { line: 2, text: 'second' }])
  const undeclared = analyzeClinicFlame({ nodes: [{ name: 'secret', file: '/inputs/other/secret.js', line: 1, total_time_pct: 30 }] }, {
    workload: 'fibonacci',
    source_roots: sourceRoots
  })
  t.equal(undeclared.findings[0].location, null)
  t.end()
})

t.test('returns a bounded call-tree slice for the selected Flame finding', t => {
  const profile = {
    nodes: [
      { node_id: 'hot', name: 'hotFunction', total_time_pct: 60, self_time_pct: 20 },
      { node_id: 'other', name: 'otherFunction', total_time_pct: 10, self_time_pct: 5 }
    ],
    call_tree: {
      node_id: 'root',
      name: '(root)',
      total_time_pct: 100,
      self_time_pct: 0,
      children: [{
        node_id: 'hot',
        name: 'hotFunction',
        total_time_pct: 60,
        self_time_pct: 20,
        children: [
          { node_id: 'child-a', name: 'childA', total_time_pct: 30, self_time_pct: 10, children: [] },
          { node_id: 'child-b', name: 'childB', total_time_pct: 20, self_time_pct: 5, children: [] }
        ]
      }]
    }
  }
  const report = analyzeClinicFlame(profile)
  const detail = findingDetail(report, report.findings[0], { top_k: 1, max_depth: 1 })
  t.equal(detail.call_tree.root.name, 'hotFunction')
  t.equal(detail.call_tree.root.children[0].name, 'childA')
  t.equal(detail.call_tree.node_count, 2)
  t.equal(detail.call_tree.truncated, true)
  t.end()
})
