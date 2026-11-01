'use strict'

const test = require('tap').test
const { validateWorkloadBindings, validateReportSemantics, validateComparison, validateManifestSelection } = require('../lib/profile-semantic-validator')

const workload = {
  cwd: '/workspace',
  input_mounts: [],
  argv: ['bench.js', '--iterations', '$' + '{iterations}'],
  parameters: {
    iterations: { min: 1, max: 10, binding: { kind: 'argv', index: 2 } }
  }
}

test('workload bindings are executable and unambiguous', t => {
  t.same(validateWorkloadBindings(workload), [])
  t.same(validateWorkloadBindings({ ...workload, argv: ['bench.js', '$' + '{iterations}', '$' + '{iterations}'] }).map(error => error.code), ['placeholder_count', 'unbound_placeholder'])
  t.same(validateWorkloadBindings({ ...workload, parameters: { iterations: { min: 10, max: 1, binding: { kind: 'argv', index: 2 } } } }).map(error => error.code), ['invalid_parameter_bounds'])
  t.same(validateWorkloadBindings({ ...workload, parameters: { iterations: { min: 1, max: 10, binding: { kind: 'argv', index: 9 } } } }).map(error => error.code), ['binding_out_of_range'])
  t.same(validateWorkloadBindings({ ...workload, argv: [], env_allowlist: ['BAD-NAME'] }).map(error => error.code), ['invalid_environment_name', 'empty_argv', 'binding_out_of_range'])
  t.same(validateWorkloadBindings({ ...workload, parameters: { 'warm-up': { min: 1, max: 2, binding: { kind: 'argv', index: 2 } } } }).map(error => error.code), ['invalid_parameter_name', 'binding_placeholder_mismatch', 'placeholder_count', 'unbound_placeholder'])
  t.same(validateWorkloadBindings({ ...workload, cwd: '/workspace/../etc' }).map(error => error.code), ['invalid_cwd'])
  t.same(validateWorkloadBindings({ ...workload, input_mounts: [{ source_root: 'workspace', source: '/etc/passwd', target: '/inputs/data', digest: 'sha256-' + 'a'.repeat(64) }] }).map(error => error.code), ['invalid_input_mount'])
  t.same(validateWorkloadBindings({ ...workload, input_mounts: [{ source_root: 'workspace', source: 'data', target: '/inputs/../workspace', digest: 'sha256-' + 'a'.repeat(64) }] }).map(error => error.code), ['invalid_input_mount'])
  t.end()
})

test('report percentages and uncertainty are physically valid', t => {
  const report = { findings: [{ id: 'f', observation: { self_time_pct: 20, total_time_pct: 10 } }] }
  t.same(validateReportSemantics(report).map(error => error.code), ['self_exceeds_total'])
  t.same(validateReportSemantics({ findings: [{ id: 'f', observation: { self_time_pct: 101, total_time_pct: 101 } }] }).map(error => error.code), ['percentage_out_of_range', 'percentage_out_of_range'])
  t.same(validateReportSemantics({ findings: [{ id: 'f', observation: { self_time_pct: 1, total_time_pct: 2 } }, { id: 'f', observation: { self_time_pct: 1, total_time_pct: 2 } }], artifacts: [{ ref: 'artifact_a' }, { ref: 'artifact_a' }] }).map(error => error.code), ['duplicate_finding_id', 'duplicate_artifact_ref'])
  t.same(validateReportSemantics({ findings: [], comparison: { compatibility: 'incompatible', candidate_uncertainty: { low_pct: 1, high_pct: 2 }, baseline_uncertainty: { low_pct: 1, high_pct: 2 }, delta_pct: 1 } }).map(error => error.code), ['missing_compatibility', 'incompatible_delta'])
  t.same(validateReportSemantics({ findings: [{ id: 'f', observation: null }] }).map(error => error.code), ['missing_observation'])
  t.same(validateReportSemantics({ findings: [null] }).map(error => error.code), ['invalid_finding'])
  t.same(validateReportSemantics({ findings: [], comparison: { candidate_uncertainty: null, baseline_uncertainty: {} } }).map(error => error.code), ['missing_compatibility', 'invalid_uncertainty', 'invalid_uncertainty'])
  t.same(validateReportSemantics({ run: { status: 'completed', workload: 'w', profiler: 'clinic-flame', commit: 'c', node: 'node-v1.0.0', architecture: 'x' }, comparison: { compatibility: 'compatible' } }).map(error => error.code), ['missing_compatibility', 'missing_compatibility', 'invalid_uncertainty', 'invalid_uncertainty'])
  t.end()
})

test('comparison requires a completed baseline with matching metadata', t => {
  const compatibility = {
    workload: 'tokenizer',
    profiler: { name: 'clinic-flame' },
    repository: { revision: 'a'.repeat(40) },
    runtime: { node_version: 'node-v24.0.0' },
    architecture: 'linux-x64'
  }
  const candidate = { run: { status: 'completed', compatibility } }
  t.same(validateComparison(candidate, null).map(error => error.code), ['invalid_baseline'])
  t.same(validateComparison(candidate, { run: { status: 'running', compatibility } }).map(error => error.code), ['invalid_baseline'])
  t.same(validateComparison(candidate, { run: { status: 'completed' } }).map(error => error.code), ['missing_baseline_compatibility'])
  const reordered = { architecture: 'linux-x64', runtime: compatibility.runtime, repository: compatibility.repository, profiler: compatibility.profiler, workload: 'tokenizer' }
  t.same(validateComparison(candidate, { run: { status: 'completed', compatibility: reordered } }), [])
  t.same(validateComparison(candidate, { run: { status: 'completed', compatibility: { ...compatibility, workload: 'other' } } }).map(error => error.code), ['incompatible_baseline'])
  t.end()
})

test('manifest selection is tied to the manifest key', t => {
  const manifest = { profile_workloads: { tokenizer: { cwd: '/workspace' } } }
  t.same(validateManifestSelection(manifest, 'tokenizer', { run: { workload: 'tokenizer' } }), [])
  t.same(validateManifestSelection(manifest, 'missing', { run: { workload: 'missing' } }).map(error => error.code), ['unknown_workload'])
  t.same(validateManifestSelection(manifest, 'tokenizer', { run: { workload: 'other' } }).map(error => error.code), ['workload_mismatch'])
  t.end()
})
