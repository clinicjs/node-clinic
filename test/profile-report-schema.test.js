'use strict'

const test = require('tap').test
const Ajv2020 = require('ajv/dist/2020')
const addFormats = require('ajv-formats')
const schema = require('../docs/schemas/performance-report.schema.json')
const workloadSchema = require('../docs/schemas/profile-workload-entry.schema.json')
const { analyzeClinicFlame, analyzeClinicDiagnostics, compareReports } = require('../lib/profile-analyzer')
const { validateReportSemantics } = require('../lib/profile-semantic-validator')

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const validate = ajv.compile(schema)

test('schema accepts explicit unavailable metadata without fabricated values', t => {
  const report = analyzeClinicFlame({ nodes: [{ name: 'work', self_time_pct: 2, total_time_pct: 10 }] }, { workload: 'fibonacci' })
  t.equal(report.run.commit, null)
  t.equal(report.run.compatibility, null)
  t.equal(report.usage, null)
  t.notOk(Object.hasOwn(report.findings[0].evidence, 'sample_count'))
  t.equal(validate(report), true, JSON.stringify(validate.errors))
  t.end()
})

test('all Clinic adapters produce evidence-backed confidence accepted by the report schema', t => {
  const profiles = {
    'clinic-doctor': { issues: { delay: 'performance' } },
    'clinic-bubbleprof': { nodes: [{ nodes: [{ name: 'asyncTask', sources: [{ init: 1, before: [20] }] }] }] },
    'clinic-flame': { nodes: [{ name: 'work', total_time_pct: 20 }] },
    'clinic-heapprofiler': { total_retained_bytes: 100, data: { name: 'allocation', selfValue: 10 } }
  }
  const expectedConfidence = {
    'clinic-doctor': 'medium',
    'clinic-bubbleprof': 'low',
    'clinic-flame': 'low',
    'clinic-heapprofiler': 'medium'
  }
  for (const [profiler, profile] of Object.entries(profiles)) {
    const report = analyzeClinicDiagnostics(profiler, profile, { workload: 'fibonacci' })
    t.equal(report.findings[0].confidence, expectedConfidence[profiler], `${profiler} confidence`)
    t.type(report.findings[0].evidence.confidence_basis, 'string')
    t.same(validate(report), true, `${profiler} schema: ${JSON.stringify(validate.errors)}`)
    t.same(validateReportSemantics(report), [])
  }
  t.end()
})

test('schema accepts complete measured identity and real sample counts', t => {
  const report = analyzeClinicFlame({ nodes: [{ name: 'work', self_time_pct: 2, total_time_pct: 10 }] }, {
    workload: 'fibonacci',
    commit: 'a'.repeat(40),
    repository: 'sha256-' + 'b'.repeat(64),
    manifest_hash: 'sha256-' + 'c'.repeat(64),
    runtime: { node_version: `node-${process.version}`, clinic_version: '13.0.0', os_version: 'linux-6.0', toolchain_digest: 'sha256-' + 'd'.repeat(64) },
    isolation: { provider: 'direct-host', version: '1', limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 10, network: 'disabled' } },
    command: { executable: 'node', working_directory: '.', argument_count: 2 },
    parameters: { iterations: 10 },
    sample_count: 23
  }, { sample_count: 23 })
  t.equal(report.findings[0].evidence.sample_count, 23)
  t.same(report.run.command, { executable: 'node', working_directory: '.', argument_count: 2 })
  t.same(report.run.parameters, { iterations: 10 })
  t.equal(validate(report), true, JSON.stringify(validate.errors))
  t.end()
})

test('schema accepts bounded repeated throughput measurement data', t => {
  const report = analyzeClinicFlame({ nodes: [] }, {
    workload: 'fibonacci',
    measurement: {
      samples: [10, 12, 11],
      warmup_count: 3,
      value_field: 'throughput',
      max_wall_clock_ms: 30000,
      elapsed_ms: 1000,
      unit: 'iterations_per_second',
      definition: 'completed iterations divided by measured wall-clock seconds'
    }
  })
  t.equal(report.summary.throughput.value, 11)
  t.equal(validate(report), true, JSON.stringify(validate.errors))
  t.same(validateReportSemantics(report), [])
  t.end()
})

test('schema accepts a descriptive single throughput sample with unsupported uncertainty', t => {
  const common = {
    workload: 'fibonacci',
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    repository: 'clinicjs/node-clinic',
    runtime: { node_version: `node-${process.version}`, toolchain_digest: 'sha256-' + 'b'.repeat(64) },
    isolation: { provider: 'direct-host', version: '1', limits: { wall_clock_ms: 120000, cpu_ms: 120000, memory_mb: 1024, artifact_mb: 512, network: 'disabled' } }
  }
  const singleSample = {
    measurement: {
      samples: [11],
      warmup_count: 0,
      value_field: 'throughput',
      max_wall_clock_ms: 30000,
      elapsed_ms: 800,
      unit: 'iterations_per_second',
      definition: 'completed iterations divided by measured wall-clock seconds'
    }
  }
  const candidate = analyzeClinicFlame({ nodes: [] }, { ...common, ...singleSample, run_id: 'candidate', commit: 'a'.repeat(40) })
  const baseline = analyzeClinicFlame({ nodes: [] }, {
    ...common,
    run_id: 'baseline',
    commit: 'b'.repeat(40),
    measurement: { ...singleSample.measurement, samples: [10] }
  })
  const comparison = compareReports(candidate, baseline)
  candidate.comparison = comparison
  t.equal(comparison.compatibility, 'compatible')
  t.equal(comparison.delta_pct, 10)
  t.same(comparison.delta_uncertainty, { method: 'unsupported', reason: 'single_run_measurement' })
  t.equal(validate(candidate), true, JSON.stringify(validate.errors))
  t.same(validateReportSemantics(candidate), [])
  t.end()
})

test('schema accepts a repeated-sample comparison across code revisions', t => {
  const common = {
    workload: 'fibonacci',
    manifest_hash: 'sha256-' + 'a'.repeat(64),
    os_version: 'linux-6.0',
    clinic_version: '13.0.0',
    runtime: { node_version: `node-${process.version}`, clinic_version: '13.0.0', os_version: 'linux-6.0', toolchain_digest: 'sha256-' + 'b'.repeat(64) },
    isolation: { provider: 'direct-host', version: '1', limits: { wall_clock_ms: 120000, cpu_ms: 120000, memory_mb: 1024, artifact_mb: 512, network: 'disabled' } },
    repository: 'clinicjs/node-clinic'
  }
  const makeReport = (id, revision, samples) => analyzeClinicFlame({ nodes: [] }, {
    ...common,
    run_id: id,
    commit: revision,
    measurement: {
      samples,
      warmup_count: 3,
      value_field: 'throughput',
      max_wall_clock_ms: 30000,
      elapsed_ms: 1200,
      unit: 'iterations_per_second',
      definition: 'completed iterations divided by measured wall-clock seconds'
    }
  })
  const candidate = makeReport('candidate', 'a'.repeat(40), [108, 112, 110, 114, 106])
  const baseline = makeReport('baseline', 'b'.repeat(40), [98, 102, 100, 104, 96])
  candidate.comparison = compareReports(candidate, baseline)
  t.equal(candidate.comparison.compatibility, 'compatible')
  t.equal(candidate.comparison.delta_pct, 10)
  t.equal(candidate.comparison.delta_uncertainty.method, 'bootstrap_95_ci')
  t.equal(validate(candidate), true, JSON.stringify(validate.errors))
  t.same(validateReportSemantics(candidate), [])
  t.end()
})

test('workload schema allows each supported Clinic profiler', t => {
  const workload = {
    executable: 'node',
    argv: ['/workspace/bench/profile-fibonacci.js', '$' + '{iterations}'],
    cwd: '/workspace',
    env_allowlist: [],
    profilers: ['clinic-doctor', 'clinic-bubbleprof', 'clinic-flame', 'clinic-heapprofiler'],
    limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 128, artifact_mb: 10 },
    network: 'disabled',
    input_mounts: [],
    parameters: { iterations: { type: 'integer', min: 1, max: 10, binding: { kind: 'argv', index: 1 } } },
    throughput: { unit: 'iterations_per_second', definition: 'completed iterations / measured seconds' },
    measurement: { warmup_runs: 3, measured_runs: 10, max_wall_clock_ms: 1000, value_field: 'throughput' }
  }
  const validateWorkload = new Ajv2020({ allErrors: true, strict: false }).compile(workloadSchema)
  t.equal(validateWorkload(workload), true, JSON.stringify(validateWorkload.errors))
  delete workload.measurement
  t.equal(validateWorkload(workload), false, 'descriptive single-sample workloads require a declared value field')
  workload.throughput.value_field = 'throughput'
  t.equal(validateWorkload(workload), true, JSON.stringify(validateWorkload.errors))
  workload.throughput = null
  t.equal(validateWorkload(workload), true, 'workloads without a throughput metric can declare null')
  workload.profilers.push('not-a-clinic-profiler')
  t.equal(validateWorkload(workload), false)
  t.end()
})
