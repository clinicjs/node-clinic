'use strict'

const path = require('node:path')

function validateWorkloadBindings (workload) {
  const errors = []
  const issue = (code, path, message) => errors.push({ code, path, message })
  if (!workload || typeof workload !== 'object') return [{ code: 'invalid_workload', path: '', message: 'workload must be an object' }]
  if (typeof workload.cwd !== 'string' || !/^\/workspace(?:\/[A-Za-z0-9_-]+)*$/.test(workload.cwd) || path.posix.normalize(workload.cwd) !== workload.cwd) issue('invalid_cwd', 'cwd', 'cwd must be a canonical path under /workspace')
  if (workload.parameters != null && (typeof workload.parameters !== 'object' || Array.isArray(workload.parameters))) issue('invalid_parameters', 'parameters', 'parameters must be an object')
  for (const mount of Array.isArray(workload.input_mounts) ? workload.input_mounts : []) {
    const sourceValid = mount && typeof mount === 'object' && ['workspace', 'declared-input'].includes(mount.source_root) && typeof mount.source === 'string' && path.posix.normalize(mount.source) === mount.source && !path.posix.isAbsolute(mount.source) && !mount.source.split('/').includes('.') && !mount.source.split('/').includes('..')
    const targetValid = mount && typeof mount === 'object' && typeof mount.target === 'string' && mount.target.startsWith('/inputs/') && path.posix.normalize(mount.target) === mount.target && mount.target.split('/').every(segment => segment !== '.' && segment !== '..')
    if (!sourceValid || !targetValid) issue('invalid_input_mount', 'input_mounts', 'input mount must use a canonical relative approved source and /inputs target')
  }
  for (const name of Array.isArray(workload.env_allowlist) ? workload.env_allowlist : []) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) issue('invalid_environment_name', 'env_allowlist', `${name}: invalid environment name`)
  }
  if (!Array.isArray(workload.argv) || workload.argv.length === 0) issue('empty_argv', 'argv', 'argv must not be empty')
  const placeholders = new Map()

  for (const argument of Array.isArray(workload.argv) ? workload.argv : []) {
    if (typeof argument !== 'string') { issue('invalid_argv_entry', 'argv', 'argv entries must be strings'); continue }
    const matches = argument.match(/^\$\{([A-Za-z0-9_]+)\}$/)
    if (matches) {
      placeholders.set(matches[1], (placeholders.get(matches[1]) || 0) + 1)
    }
  }

  const parameterDefinitions = workload.parameters && typeof workload.parameters === 'object' && !Array.isArray(workload.parameters) ? workload.parameters : {}
  for (const [name, definition] of Object.entries(parameterDefinitions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) issue('invalid_parameter_name', `parameters.${name}`, 'parameter name is not valid')
    if (!definition || typeof definition !== 'object') { issue('invalid_parameter', `parameters.${name}`, 'parameter definition must be an object'); continue }
    if (definition.type !== 'integer') issue('invalid_parameter_type', `parameters.${name}.type`, 'parameter type must be integer')
    if (!Number.isSafeInteger(definition.min) || !Number.isSafeInteger(definition.max)) issue('invalid_parameter_bounds', `parameters.${name}`, 'min and max must be safe integers')
    else if (definition.min > definition.max) issue('invalid_parameter_bounds', `parameters.${name}`, 'min must not exceed max')
    if (Object.keys(definition).some(key => !['type', 'min', 'max', 'binding'].includes(key))) issue('invalid_parameter_property', `parameters.${name}`, 'parameter definition contains an unsupported property')
    const binding = definition.binding
    if (!binding || binding.kind !== 'argv' || !Number.isInteger(binding.index)) {
      issue('invalid_binding', `parameters.${name}.binding`, 'binding must target an argv index')
      continue
    }
    if (Object.keys(binding).some(key => !['kind', 'index'].includes(key))) issue('invalid_binding_property', `parameters.${name}.binding`, 'binding contains an unsupported property')
    if (binding.index < 0 || binding.index >= workload.argv.length) {
      issue('binding_out_of_range', `parameters.${name}.binding.index`, 'binding index outside argv')
      continue
    }
    if (workload.argv[binding.index] !== '${' + name + '}') {
      issue('binding_placeholder_mismatch', `parameters.${name}.binding`, 'binding placeholder mismatch')
    }
    if (placeholders.get(name) !== 1) issue('placeholder_count', `parameters.${name}`, 'placeholder count is not one')
  }

  for (const [name, count] of placeholders) {
    if (!workload.parameters || !workload.parameters[name] || count !== 1) issue('unbound_placeholder', `argv.${name}`, 'unbound or duplicate placeholder')
  }
  return errors
}

function validateWorkloadParameters (workload, parameters) {
  const errors = []
  const issue = (code, path, message) => errors.push({ code, path, message })
  if (!workload || typeof workload !== 'object') return [{ code: 'invalid_workload', path: '', message: 'workload must be an object' }]
  if (parameters == null) parameters = {}
  if (typeof parameters !== 'object' || Array.isArray(parameters)) return [{ code: 'invalid_parameters', path: 'parameters', message: 'parameters must be an object' }]

  const definitions = workload.parameters || {}
  for (const name of Object.keys(parameters)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) issue('unknown_parameter', `parameters.${name}`, 'parameter is not declared by this workload')
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
      issue('missing_parameter', `parameters.${name}`, 'parameter is required by this workload')
      continue
    }
    const value = parameters[name]
    if (definition.type === 'integer' && !Number.isSafeInteger(value)) {
      issue('invalid_parameter_type', `parameters.${name}`, 'parameter must be a safe integer')
      continue
    }
    if (Number.isFinite(definition.min) && value < definition.min) issue('parameter_below_minimum', `parameters.${name}`, `parameter must be at least ${definition.min}`)
    if (Number.isFinite(definition.max) && value > definition.max) issue('parameter_above_maximum', `parameters.${name}`, `parameter must be at most ${definition.max}`)
  }
  return errors
}

function validateReportSemantics (report) {
  const errors = []
  const issue = (code, path, message) => errors.push({ code, path, message })
  if (!report || typeof report !== 'object') return [{ code: 'invalid_report', path: '', message: 'report must be an object' }]
  const measurements = report.summary && report.summary.measurement
  if (measurements) {
    const samples = measurements.samples
    if (!Array.isArray(samples) || samples.length < 2 || samples.length > 30 || samples.some(value => !Number.isFinite(value) || value < 0)) {
      issue('invalid_measurement_samples', 'summary.measurement.samples', 'measurement samples must contain 2 to 30 finite non-negative numbers')
    } else {
      if (measurements.sample_count !== samples.length) issue('measurement_sample_count_mismatch', 'summary.measurement.sample_count', 'sample_count must match the samples array')
      const sorted = samples.slice().sort((a, b) => a - b)
      const middle = Math.floor(sorted.length / 2)
      const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
      const throughput = report.summary.throughput
      if (!throughput || !Number.isFinite(throughput.value) || Math.abs(throughput.value - median) > Math.max(1, Math.abs(median)) * Number.EPSILON * 4) issue('measurement_median_mismatch', 'summary.throughput.value', 'throughput.value must equal the median of measured samples')
    }
  }
  const run = report.run
  const compatibility = run && run.compatibility
  if (report.comparison && (!compatibility || typeof compatibility !== 'object')) issue('missing_compatibility', 'run.compatibility', 'comparison requires candidate compatibility metadata')
  if (run && compatibility) {
    if (compatibility.workload !== run.workload) issue('compatibility_mismatch', 'run.compatibility.workload', 'workload identity does not match run')
    if (!compatibility.profiler || compatibility.profiler.name !== run.profiler) issue('compatibility_mismatch', 'run.compatibility.profiler', 'profiler identity does not match run')
    if (!compatibility.repository || compatibility.repository.revision !== run.commit) issue('compatibility_mismatch', 'run.compatibility.repository.revision', 'repository revision does not match run')
    if (!compatibility.runtime || compatibility.runtime.node_version !== run.node) issue('compatibility_mismatch', 'run.compatibility.runtime.node_version', 'runtime does not match run')
    if (compatibility.architecture !== run.architecture) issue('compatibility_mismatch', 'run.compatibility.architecture', 'architecture does not match run')
  }
  const findingIds = new Set()
  const artifactRefs = new Set()
  for (const finding of report.findings || []) {
    if (!finding || typeof finding !== 'object') { issue('invalid_finding', 'findings', 'finding must be an object'); continue }
    if (findingIds.has(finding.id)) issue('duplicate_finding_id', `findings.${finding.id}`, 'duplicate finding id')
    findingIds.add(finding.id)
    const observation = finding.observation
    if (!observation || typeof observation !== 'object') { issue('missing_observation', `findings.${finding.id}.observation`, 'observation must be an object'); continue }
    if ('self_time_pct' in observation || 'total_time_pct' in observation) {
      if (!Number.isFinite(observation.self_time_pct) || observation.self_time_pct < 0 || observation.self_time_pct > 100) issue('percentage_out_of_range', `findings.${finding.id}.observation.self_time_pct`, 'self percentage out of range')
      if (!Number.isFinite(observation.total_time_pct) || observation.total_time_pct < 0 || observation.total_time_pct > 100) issue('percentage_out_of_range', `findings.${finding.id}.observation.total_time_pct`, 'total percentage out of range')
      if (observation.self_time_pct > observation.total_time_pct) issue('self_exceeds_total', `findings.${finding.id}.observation`, 'self exceeds total')
    }
  }
  for (const artifact of report.artifacts || []) {
    if (!artifact || typeof artifact !== 'object') { issue('invalid_artifact', 'artifacts', 'artifact must be an object'); continue }
    if (artifactRefs.has(artifact.ref)) issue('duplicate_artifact_ref', `artifacts.${artifact.ref}`, 'duplicate artifact ref')
    artifactRefs.add(artifact.ref)
  }
  const comparison = report.comparison
  if (comparison) {
    for (const uncertainty of [comparison.candidate_uncertainty, comparison.baseline_uncertainty, comparison.delta_uncertainty]) {
      if (uncertainty === undefined && comparison.compatibility !== 'compatible') continue
      if (!uncertainty || typeof uncertainty !== 'object') { issue('invalid_uncertainty', 'comparison', 'uncertainty must be an object'); continue }
      if (uncertainty.method === 'unsupported') {
        const validReasons = ['single_run_measurement', 'repeated_samples_unavailable']
        if (!validReasons.includes(uncertainty.reason) || Object.keys(uncertainty).some(key => !['method', 'reason'].includes(key))) issue('invalid_uncertainty', 'comparison', 'unsupported uncertainty must include a valid reason and no interval')
      } else if (uncertainty.method === 'bootstrap_95_ci') {
        if (!Number.isFinite(uncertainty.low_pct) || !Number.isFinite(uncertainty.high_pct) || uncertainty.low_pct > uncertainty.high_pct) issue('invalid_uncertainty', 'comparison', 'invalid uncertainty interval')
      } else {
        issue('invalid_uncertainty', 'comparison', 'uncertainty method is unsupported')
      }
    }
    if (comparison.compatibility === 'incompatible' && ('delta_pct' in comparison || 'delta_uncertainty' in comparison)) issue('incompatible_delta', 'comparison.delta_pct', 'incompatible comparison has delta')
    if ('delta_pct' in comparison && !Number.isFinite(comparison.delta_pct)) issue('invalid_delta', 'comparison.delta_pct', 'delta must be finite')
  }
  return errors
}

function comparableCompatibility (value) {
  if (!value || typeof value !== 'object') return null
  return {
    ...value,
    repository: value.repository && { identity: value.repository.identity }
  }
}

function validateComparison (candidate, baseline) {
  const errors = []
  if (!baseline || typeof baseline !== 'object' || baseline.run?.status !== 'completed') errors.push({ code: 'invalid_baseline', path: 'baseline', message: 'baseline must be a completed report' })
  if (baseline && (!baseline.run || !baseline.run.compatibility)) errors.push({ code: 'missing_baseline_compatibility', path: 'baseline.run.compatibility', message: 'baseline compatibility metadata is required' })
  if (!candidate || typeof candidate !== 'object' || !candidate.run?.compatibility) errors.push({ code: 'missing_compatibility', path: 'candidate.run.compatibility', message: 'candidate compatibility metadata is required' })
  const hasComparisonIdentity = report => {
    const value = report && report.run && report.run.compatibility
    return value && value.manifest_hash && value.runtime && value.runtime.toolchain_digest && value.isolation && value.repository && value.repository.identity && value.repository.revision
  }
  if (baseline && baseline.run?.compatibility && !hasComparisonIdentity(baseline)) errors.push({ code: 'incomplete_baseline_compatibility', path: 'baseline.run.compatibility', message: 'baseline is missing identity, runtime, or isolation metadata required for comparison' })
  if (candidate && candidate.run?.compatibility && !hasComparisonIdentity(candidate)) errors.push({ code: 'incomplete_compatibility', path: 'candidate.run.compatibility', message: 'candidate is missing identity, runtime, or isolation metadata required for comparison' })
  if (baseline && candidate && baseline.run?.compatibility && candidate.run?.compatibility && stableStringify(comparableCompatibility(baseline.run.compatibility)) !== stableStringify(comparableCompatibility(candidate.run.compatibility))) errors.push({ code: 'incompatible_baseline', path: 'comparison', message: 'baseline compatibility metadata differs' })
  return errors
}

function stableStringify (value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validateManifestSelection (manifest, workloadKey, report) {
  const errors = []
  const entry = manifest && manifest.profile_workloads && manifest.profile_workloads[workloadKey]
  if (!entry) errors.push({ code: 'unknown_workload', path: `profile_workloads.${workloadKey}`, message: 'workload key is not present in manifest' })
  if (report && report.run && report.run.workload !== workloadKey) errors.push({ code: 'workload_mismatch', path: 'run.workload', message: 'report workload does not match selected manifest key' })
  return errors
}

module.exports = { validateWorkloadBindings, validateWorkloadParameters, validateReportSemantics, validateComparison, validateManifestSelection }
