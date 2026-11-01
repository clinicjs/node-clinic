'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const packageInfo = require('../package.json')
const callTreesByReport = new WeakMap()

function sha256 (value) {
  return `sha256-${crypto.createHash('sha256').update(String(value)).digest('hex')}`
}

function canonicalLocation (node) {
  const file = typeof node.file === 'string' ? node.file : ''
  const line = Number.isInteger(node.line) && node.line > 0 ? node.line : 0
  return `${file}:${String(line).padStart(10, '0')}`
}

function severityFor (total) {
  if (total >= 40) return 'high'
  if (total >= 15) return 'medium'
  return 'low'
}

function confidenceForSamples (sampleCount) {
  if (!Number.isInteger(sampleCount) || sampleCount < 2) return 'low'
  return sampleCount >= 100 ? 'high' : 'medium'
}

function aggregateConfidence (findings) {
  if (findings.length === 0) return 'unsupported'
  const rank = { low: 0, medium: 1, high: 2 }
  return findings.reduce((lowest, finding) => rank[finding.confidence] < rank[lowest] ? finding.confidence : lowest, 'high')
}

function normalizeSourceLocation (file, line, sourceRoot) {
  if (typeof file !== 'string' || !Number.isInteger(line) || line < 1) return null
  if (path.win32.isAbsolute(file) && !path.isAbsolute(file)) return null
  const entries = sourceRootEntries(sourceRoot)
  if (file.split(/[\\/]/).some(segment => segment === '.' || segment === '..')) return null
  if (!entries.length) {
    if (path.isAbsolute(file) || path.win32.isAbsolute(file)) return null
    return { file: file.replaceAll('\\', '/').slice(0, 240), line }
  }
  try {
    for (const entry of entries) {
      const mapping = mapSourcePath(file, entry)
      if (!mapping) continue
      if (!isCanonicalSourceFile(mapping.root, mapping.relative)) continue
      const reportPath = [entry.reportPrefix, mapping.relative].filter(Boolean).join('/')
      return { file: reportPath.slice(0, 240), line }
    }
    return null
  } catch {
    return null
  }
}

function sourceRootEntries (sourceRoot) {
  if (!sourceRoot) return []
  if (typeof sourceRoot === 'string') return [{ root: sourceRoot, virtualRoot: '/workspace', reportPrefix: '' }]
  if (Array.isArray(sourceRoot)) return sourceRoot.filter(entry => entry && typeof entry.root === 'string')
  return []
}

function mapSourcePath (file, entry) {
  const virtualRoot = entry.virtualRoot || '/workspace'
  let relative
  if (path.isAbsolute(file)) {
    if (file === virtualRoot || file.startsWith(`${virtualRoot}/`)) {
      relative = file === virtualRoot ? '' : file.slice(virtualRoot.length + 1)
    } else {
      const requestedRoot = path.resolve(entry.root)
      const requestedRootStat = fs.lstatSync(requestedRoot)
      if (requestedRootStat.isSymbolicLink()) return null
      const root = fs.realpathSync(requestedRoot)
      const candidate = path.resolve(file)
      const fromRoot = path.relative(root, candidate)
      if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null
      return { root, relative: fromRoot.split(path.sep).join('/') }
    }
  } else {
    if (entry.relativePaths === false || virtualRoot !== '/workspace') return null
    relative = file
  }
  if (relative.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..')) {
    if (relative !== '') return null
  }
  const requestedRoot = path.resolve(entry.root)
  const requestedRootStat = fs.lstatSync(requestedRoot)
  if (requestedRootStat.isSymbolicLink()) return null
  const root = fs.realpathSync(requestedRoot)
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink()) return null
  const candidate = relative ? path.resolve(root, ...relative.split('/')) : root
  const fromRoot = path.relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null
  return { root, relative: fromRoot.split(path.sep).join('/') }
}

function isCanonicalSourceFile (root, relative) {
  if (!relative) {
    const stat = fs.lstatSync(root)
    return stat.isFile() && !stat.isSymbolicLink()
  }
  let current = root
  for (const segment of relative.split('/')) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) return false
  }
  const canonical = fs.realpathSync(current)
  const rootRelative = path.relative(root, canonical)
  const stat = fs.lstatSync(canonical)
  return stat.isFile() && canonical === current && rootRelative !== '..' && !rootRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(rootRelative)
}

function normalizeNodes (profile) {
  const source = Array.isArray(profile && profile.nodes)
    ? profile.nodes
    : Array.isArray(profile && profile.functions) ? profile.functions : []
  return source.map((node, index) => {
    const self = Number(node.self_time_pct ?? node.selfPct ?? node.self ?? 0)
    const total = Number(node.total_time_pct ?? node.totalPct ?? node.total ?? self)
    return {
      name: typeof node.name === 'string' && node.name.length > 0 ? node.name.slice(0, 120) : `node-${index + 1}`,
      node_id: typeof node.node_id === 'string' ? node.node_id : null,
      file: typeof node.file === 'string' ? node.file.slice(0, 240) : null,
      line: Number.isInteger(node.line) && node.line > 0 ? node.line : null,
      self: Number.isFinite(self) ? Math.max(0, Math.min(100, self)) : 0,
      total: Number.isFinite(total) ? Math.max(0, Math.min(100, total)) : 0
    }
  }).sort((a, b) => b.total - a.total || b.self - a.self || canonicalLocation(a).localeCompare(canonicalLocation(b)) || a.name.localeCompare(b.name))
}

function createCompatibility (options) {
  const runtime = {
    ...(options.runtime || { node_version: `node-${process.version}`, toolchain_digest: null }),
    clinic_version: options.clinic_version || (options.runtime && options.runtime.clinic_version) || packageInfo.version,
    os_version: options.os_version || (options.runtime && options.runtime.os_version) || `${os.platform()}-${os.release()}`
  }
  const isolation = options.isolation || null
  const manifestHash = options.manifest_hash || null
  const repository = {
    identity: options.repository || null,
    revision: options.commit || null
  }
  if (!manifestHash || !isolation || !runtime.toolchain_digest || !repository.identity || !repository.revision) return null
  return {
    schema_version: 1,
    workload: options.workload,
    manifest_hash: manifestHash,
    profiler: {
      name: options.profiler || 'clinic-flame',
      adapter_version: String(options.adapter_version || 1),
      configuration_digest: options.configuration_digest || sha256(options.profiler_configuration || '{}'),
      canonicalization_version: String(options.canonicalization_version || 1)
    },
    input_digest: options.input_digest || sha256(options.input || ''),
    isolation,
    runtime,
    architecture: options.architecture || `${process.platform}-${process.arch}`,
    repository
  }
}

function summarizeMeasurement (measurement) {
  if (!measurement || !Array.isArray(measurement.samples) || measurement.samples.length < 1 || measurement.samples.length > 30 || measurement.samples.some(value => !Number.isFinite(value) || value < 0)) return null
  if (!Number.isSafeInteger(measurement.warmup_count) || measurement.warmup_count < 0 || typeof measurement.unit !== 'string' || typeof measurement.definition !== 'string') return null
  const sorted = measurement.samples.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  return {
    throughput: { value, unit: measurement.unit, definition: measurement.definition },
    summary: {
      samples: measurement.samples.slice(),
      sample_count: measurement.samples.length,
      warmup_count: measurement.warmup_count,
      value_field: measurement.value_field,
      max_wall_clock_ms: measurement.max_wall_clock_ms,
      elapsed_ms: measurement.elapsed_ms
    }
  }
}

function median (values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function analyzeClinicFlame (profile, options = {}) {
  const now = options.now || new Date().toISOString()
  const nodes = normalizeNodes(profile)
  const runId = options.run_id || `run_${now.replace(/[-:.TZ]/g, '')}_${sha256(JSON.stringify(profile)).slice(-12)}`
  const maxFindings = Number.isInteger(options.max_findings) ? Math.max(0, Math.min(20, options.max_findings)) : 20
  const suppliedSampleCount = Number.isInteger(options.sample_count) && options.sample_count > 0
    ? options.sample_count
    : Number.isInteger(profile && profile.sample_count) && profile.sample_count > 0 ? profile.sample_count : null
  const sampleCount = suppliedSampleCount
  const flameConfidence = confidenceForSamples(sampleCount)
  const findings = nodes.slice(0, maxFindings).map((node, index) => {
    const evidence = {
      adapter: 'clinic-flame-v1',
      adapter_schema_version: '1',
      confidence_basis: sampleCount ? 'profiler_sample_count' : 'profiler_sample_count_unavailable'
    }
    if (sampleCount) evidence.sample_count = sampleCount
    return {
      id: `finding-${String(index + 1).padStart(3, '0')}`,
      severity: severityFor(node.total),
      category: 'cpu',
      title: `${node.name} dominates sampled CPU time`,
      observation: {
        metric: 'total_cpu_time_pct',
        self_time_pct: node.self,
        total_time_pct: node.total
      },
      location: normalizeSourceLocation(node.file, node.line, options.source_roots || options.source_root),
      hypotheses: [],
      next_checks: [],
      confidence: flameConfidence,
      evidence
    }
  })

  const duration = Number.isFinite(profile && profile.duration_ms) ? Math.max(0, profile.duration_ms) : 0
  const measurement = summarizeMeasurement(options.measurement)
  const throughput = (measurement && measurement.throughput) || (profile && profile.throughput && Number.isFinite(profile.throughput.value)
    ? { value: Math.max(0, profile.throughput.value), unit: profile.throughput.unit, definition: profile.throughput.definition }
    : null)
  const commit = options.commit || null
  const compatibility = createCompatibility({ ...options, commit })
  const report = {
    schema_version: 1,
    run: {
      id: runId,
      workload: options.workload || 'unknown',
      profiler: options.profiler || 'clinic-flame',
      commit,
      clinic_version: options.clinic_version || packageInfo.version,
      os_version: options.os_version || `${os.platform()}-${os.release()}`,
      node: compatibility ? compatibility.runtime.node_version : `node-${process.version}`,
      architecture: compatibility ? compatibility.architecture : `${process.platform}-${process.arch}`,
      compatibility,
      status: 'completed',
      exit_code: Number.isInteger(options.exit_code) ? options.exit_code : null,
      termination_reason: options.termination_reason || 'completed',
      lifecycle: { created_at: now, finished_at: now }
    },
    summary: {
      duration_ms: duration,
      throughput,
      measurement: measurement ? measurement.summary : null,
      findings_truncated: nodes.length > maxFindings,
      confidence: aggregateConfidence(findings),
      capabilities: {
        cpu_call_tree: 'supported',
        event_loop_delay: 'unsupported',
        heap_retained_delta: 'unsupported'
      }
    },
    comparison: null,
    findings,
    artifacts: options.artifact_ref ? [{ kind: 'clinic', ref: options.artifact_ref, classification: options.artifact_classification || 'sensitive-diagnostic' }] : [],
    usage: null
  }
  if (options.measurement_environment) report.summary.measurement_environment = options.measurement_environment
  if (options.command) report.run.command = options.command
  if (options.parameters) report.run.parameters = options.parameters
  if (profile && profile.call_tree && typeof profile.call_tree === 'object') {
    const nodesById = new Map()
    const stack = [profile.call_tree]
    while (stack.length) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      if (typeof node.node_id === 'string') nodesById.set(node.node_id, node)
      for (const child of node.children || []) stack.push(child)
    }
    const selected = new Map()
    for (const [index, node] of nodes.slice(0, maxFindings).entries()) {
      const sourceNode = node.node_id && nodesById.get(node.node_id)
      if (sourceNode) selected.set(`finding-${String(index + 1).padStart(3, '0')}`, sourceNode)
    }
    callTreesByReport.set(report, selected)
  }
  return report
}

function analyzeClinicDiagnostics (profiler, profile, options = {}) {
  if (profiler === 'clinic-flame') return analyzeClinicFlame(profile, options)
  const now = options.now || new Date().toISOString()
  const findings = []
  let findingsTruncated = false
  const addFinding = (finding) => {
    if (findings.length >= 20) {
      findingsTruncated = true
      return
    }
    const category = String(finding.category || 'general').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 80) || 'general'
    const evidence = {
      adapter: `${profiler}-v1`,
      adapter_schema_version: '1',
      confidence_basis: finding.confidence_basis
    }
    if (Number.isInteger(profile.sample_count) && profile.sample_count > 0) evidence.sample_count = profile.sample_count
    findings.push({
      id: `finding-${String(findings.length + 1).padStart(3, '0')}`,
      severity: finding.severity || 'low',
      category,
      title: String(finding.title || 'Profile finding').slice(0, 240),
      observation: finding.observation,
      location: finding.location ? normalizeSourceLocation(finding.location.file, finding.location.line, options.source_roots || options.source_root) : null,
      hypotheses: [],
      next_checks: [],
      confidence: finding.confidence,
      evidence
    })
  }

  if (profiler === 'clinic-doctor') {
    function visitIssue (key, value) {
      key = key.slice(0, 80)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [childKey, childValue] of Object.entries(value)) visitIssue(`${key}_${childKey}`, childValue)
      } else if (value === 'performance') {
        addFinding({
          severity: 'medium',
          category: key.startsWith('memory') ? 'memory' : key === 'delay' ? 'event-loop' : key,
          title: `Clinic Doctor detected a ${key} performance issue`,
          observation: { metric: 'doctor_issue_status', values: { status: value, issue: key } },
          confidence_basis: 'doctor_issue_classification',
          confidence: 'medium'
        })
      }
    }
    for (const [key, value] of Object.entries(profile.issues || {})) visitIssue(key, value)
  } else if (profiler === 'clinic-bubbleprof') {
    const operations = new Map()
    for (const cluster of profile.nodes || []) {
      for (const node of cluster.nodes || []) {
        let maxDuration = 0
        for (const source of node.sources || []) {
          const start = Number(source.init)
          const times = [source.destroy, ...(source.before || []), ...(source.after || [])].map(Number).filter(Number.isFinite)
          if (Number.isFinite(start) && times.length) maxDuration = Math.max(maxDuration, Math.max(...times) - start)
        }
        if (maxDuration > 0) {
          const prior = operations.get(node.name) || { name: node.name, maxDuration: 0, count: 0 }
          prior.maxDuration = Math.max(prior.maxDuration, maxDuration)
          prior.count += (node.sources || []).length
          operations.set(node.name, prior)
        }
      }
    }
    const rankedOperations = [...operations.values()].sort((a, b) => b.maxDuration - a.maxDuration)
    if (rankedOperations.length > 20) findingsTruncated = true
    for (const operation of rankedOperations.slice(0, 20)) {
      addFinding({
        category: 'async',
        title: `${operation.name} has the longest observed async lifetime`,
        observation: { metric: 'max_async_lifetime_ms', values: { max_duration_ms: operation.maxDuration, operations: operation.count } },
        confidence_basis: 'bubbleprof_event_sources',
        confidence: operation.count >= 10 ? 'high' : operation.count >= 2 ? 'medium' : 'low'
      })
    }
  } else if (profiler === 'clinic-heapprofiler') {
    const total = Math.max(0, Number(profile.total_retained_bytes) || 0)
    const stack = profile.data ? [profile.data] : []
    const nodes = []
    while (stack.length) {
      const node = stack.pop()
      const self = Math.max(0, Number(node.selfValue) || 0)
      if (self > 0) nodes.push({ node, self, share: total > 0 ? (self / total) * 100 : 0 })
      for (const child of node.children || []) stack.push(child)
    }
    nodes.sort((a, b) => b.self - a.self)
    if (nodes.length > 20) findingsTruncated = true
    for (const { node, self, share } of nodes.slice(0, 20)) {
      addFinding({
        severity: severityFor(share),
        category: 'memory',
        title: `${node.name || node.functionName || 'Unknown allocation'} retains heap memory`,
        observation: { metric: 'retained_heap_share', values: { self_retained_bytes: self, total_retained_bytes: total, share_pct: share } },
        confidence_basis: 'heapprofiler_single_snapshot',
        confidence: 'medium',
        location: node.fileName && Number.isInteger(node.lineNumber) && node.lineNumber > 0 ? { file: node.fileName, line: node.lineNumber } : null
      })
    }
  }

  const measurement = summarizeMeasurement(options.measurement)
  const commit = options.commit || null
  const compatibility = createCompatibility({ ...options, profiler, commit })
  const report = {
    schema_version: 1,
    run: {
      id: options.run_id || `run_${now.replace(/[-:.TZ]/g, '')}_${sha256(JSON.stringify(profile)).slice(-12)}`,
      workload: options.workload || 'unknown',
      profiler,
      commit,
      clinic_version: options.clinic_version || packageInfo.version,
      os_version: options.os_version || `${os.platform()}-${os.release()}`,
      node: compatibility ? compatibility.runtime.node_version : `node-${process.version}`,
      architecture: compatibility ? compatibility.architecture : `${process.platform}-${process.arch}`,
      compatibility,
      status: 'completed',
      exit_code: Number.isInteger(options.exit_code) ? options.exit_code : null,
      termination_reason: options.termination_reason || 'completed',
      lifecycle: { created_at: options.started_at || now, finished_at: options.finished_at || now }
    },
    summary: {
      duration_ms: Math.max(0, Number(profile.duration_ms || profile.runtime_ms) || 0),
      throughput: (measurement && measurement.throughput) || null,
      measurement: measurement ? measurement.summary : null,
      findings_truncated: findingsTruncated,
      confidence: aggregateConfidence(findings),
      capabilities: {
        cpu_call_tree: profiler === 'clinic-flame' ? 'supported' : 'unsupported',
        event_loop_delay: profiler === 'clinic-doctor' ? 'supported' : 'unsupported',
        heap_retained_delta: 'unsupported'
      }
    },
    comparison: null,
    findings,
    artifacts: options.artifact_ref ? [{ kind: 'clinic', ref: options.artifact_ref, classification: options.artifact_classification || 'sensitive-diagnostic' }] : [],
    usage: null
  }
  if (options.measurement_environment) report.summary.measurement_environment = options.measurement_environment
  if (options.command) report.run.command = options.command
  if (options.parameters) report.run.parameters = options.parameters
  return report
}

function stableStringify (value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function comparableCompatibility (value) {
  if (!value || typeof value !== 'object') return null
  return {
    ...value,
    repository: value.repository && { identity: value.repository.identity }
  }
}

function createRandom (seed) {
  let state = (seed >>> 0) || 0x6d2b79f5
  return function random () {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

function percentile (values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b)
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function bootstrapMedian (samples, random) {
  const resampled = []
  for (let index = 0; index < samples.length; index++) resampled.push(samples[Math.floor(random() * samples.length)])
  const sorted = resampled.sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function getThroughputSamples (report) {
  const measurement = report && report.summary && report.summary.measurement
  if (measurement && Array.isArray(measurement.samples) && measurement.samples.length > 0 && measurement.samples.length <= 30 && measurement.samples.every(value => Number.isFinite(value) && value >= 0)) return measurement.samples.slice()
  const value = report && report.summary && report.summary.throughput && report.summary.throughput.value
  return Number.isFinite(value) && value >= 0 ? [value] : null
}

function bootstrapRateInterval (samples, seed) {
  const estimate = median(samples)
  if (samples.length < 2 || estimate <= 0) return { method: 'unsupported', reason: samples.length < 2 ? 'single_run_measurement' : 'repeated_samples_unavailable' }
  const random = createRandom(seed)
  const relative = []
  for (let index = 0; index < 2000; index++) relative.push((bootstrapMedian(samples, random) / estimate) * 100)
  return {
    method: 'bootstrap_95_ci',
    algorithm_version: '1',
    seed,
    low_pct: percentile(relative, 0.025),
    high_pct: percentile(relative, 0.975)
  }
}

function bootstrapDeltaInterval (candidateSamples, baselineSamples, seed) {
  if (candidateSamples.length < 2 || baselineSamples.length < 2) return { method: 'unsupported', reason: candidateSamples.length < 2 || baselineSamples.length < 2 ? 'single_run_measurement' : 'repeated_samples_unavailable' }
  const random = createRandom(seed)
  const deltas = []
  for (let index = 0; index < 2000; index++) {
    const candidateValue = bootstrapMedian(candidateSamples, random)
    const baselineValue = bootstrapMedian(baselineSamples, random)
    if (baselineValue > 0) deltas.push(((candidateValue - baselineValue) / baselineValue) * 100)
  }
  if (deltas.length < 1000) return { method: 'unsupported', reason: 'repeated_samples_unavailable' }
  return {
    method: 'bootstrap_95_ci',
    algorithm_version: '1',
    seed,
    low_pct: percentile(deltas, 0.025),
    high_pct: percentile(deltas, 0.975)
  }
}

function compareReports (candidate, baseline) {
  const candidateCompatibility = candidate && candidate.run && candidate.run.compatibility
  const baselineCompatibility = baseline && baseline.run && baseline.run.compatibility
  if (!candidateCompatibility || !baselineCompatibility || stableStringify(comparableCompatibility(candidateCompatibility)) !== stableStringify(comparableCompatibility(baselineCompatibility))) {
    return { compatibility: 'incompatible', baseline_run_id: baseline && baseline.run ? baseline.run.id : 'unknown' }
  }
  const candidateThroughput = candidate.summary && candidate.summary.throughput
  const baselineThroughput = baseline.summary && baseline.summary.throughput
  const validThroughput = throughput => throughput && Number.isFinite(throughput.value) && throughput.value >= 0 && typeof throughput.unit === 'string' && typeof throughput.definition === 'string'
  if (!validThroughput(candidateThroughput) || !validThroughput(baselineThroughput) || baselineThroughput.value === 0 || candidateThroughput.unit !== baselineThroughput.unit || candidateThroughput.definition !== baselineThroughput.definition) {
    return { compatibility: 'incompatible', baseline_run_id: baseline.run.id }
  }
  const candidateSamples = getThroughputSamples(candidate)
  const baselineSamples = getThroughputSamples(baseline)
  if (!candidateSamples || !baselineSamples || median(candidateSamples) !== candidateThroughput.value || median(baselineSamples) !== baselineThroughput.value) {
    return { compatibility: 'incompatible', baseline_run_id: baseline.run.id }
  }
  const seed = 0
  const delta = ((candidateThroughput.value - baselineThroughput.value) / baselineThroughput.value) * 100
  const findingChanges = compareFindingSets(candidate, baseline)
  return {
    compatibility: 'compatible',
    baseline_run_id: baseline.run.id,
    metric: 'throughput',
    units: candidateThroughput.unit,
    metric_definition: candidateThroughput.definition,
    direction: 'higher_is_better',
    denominator: 'baseline_median',
    delta_pct: delta,
    candidate_sample_count: candidateSamples.length,
    candidate_warmup_count: candidate.summary.measurement ? candidate.summary.measurement.warmup_count : 0,
    candidate_uncertainty: bootstrapRateInterval(candidateSamples, seed),
    baseline_sample_count: baselineSamples.length,
    baseline_warmup_count: baseline.summary.measurement ? baseline.summary.measurement.warmup_count : 0,
    baseline_uncertainty: bootstrapRateInterval(baselineSamples, seed),
    delta_uncertainty: bootstrapDeltaInterval(candidateSamples, baselineSamples, seed),
    finding_changes: findingChanges
  }
}

function findingKey (finding) {
  const observation = finding.observation || {}
  const location = finding.location || {}
  return stableStringify({
    category: finding.category || '',
    title: finding.title || '',
    metric: observation.metric || '',
    file: location.file || ''
  })
}

function findingSummary (finding) {
  return {
    category: finding.category,
    title: finding.title,
    severity: finding.severity,
    location: finding.location || null,
    observation: finding.observation || null
  }
}

function findingImpact (finding) {
  const observation = (finding && finding.observation) || {}
  const values = observation.values || observation
  return Number(values.total_time_pct || values.share_pct || values.max_duration_ms || values.self_retained_bytes || 0)
}

function compareFindingSets (candidate, baseline) {
  const candidateFindings = Array.isArray(candidate.findings) ? candidate.findings : []
  const baselineFindings = Array.isArray(baseline.findings) ? baseline.findings : []
  function groupByKey (findings) {
    const grouped = new Map()
    for (const finding of findings) {
      const key = findingKey(finding)
      const entries = grouped.get(key) || []
      entries.push(finding)
      grouped.set(key, entries)
    }
    return grouped
  }
  const candidateByKey = groupByKey(candidateFindings)
  const baselineByKey = groupByKey(baselineFindings)
  const changes = []

  for (const [key, candidateGroup] of candidateByKey) {
    const baselineGroup = baselineByKey.get(key) || []
    for (let index = 0; index < Math.max(candidateGroup.length, baselineGroup.length); index++) {
      const candidateFinding = candidateGroup[index]
      const baselineFinding = baselineGroup[index]
      if (!baselineFinding) {
        changes.push({ kind: 'candidate_only', candidate: findingSummary(candidateFinding), impact: findingImpact(candidateFinding) })
      } else if (!candidateFinding) {
        changes.push({ kind: 'baseline_only', baseline: findingSummary(baselineFinding), impact: findingImpact(baselineFinding) })
      } else {
        const same = candidateFinding.severity === baselineFinding.severity && stableStringify(candidateFinding.observation) === stableStringify(baselineFinding.observation)
        if (!same) {
          changes.push({
            kind: 'changed',
            baseline: findingSummary(baselineFinding),
            candidate: findingSummary(candidateFinding),
            impact: Math.max(findingImpact(candidateFinding), findingImpact(baselineFinding))
          })
        }
      }
    }
  }
  for (const [key, baselineGroup] of baselineByKey) {
    if (candidateByKey.has(key)) continue
    for (const baselineFinding of baselineGroup) {
      changes.push({ kind: 'baseline_only', baseline: findingSummary(baselineFinding), impact: findingImpact(baselineFinding) })
    }
  }
  changes.sort((left, right) => right.impact - left.impact || left.kind.localeCompare(right.kind))
  return {
    scope: 'reported_findings',
    complete: candidate.summary.findings_truncated === false && baseline.summary.findings_truncated === false,
    items: changes.slice(0, 20).map(({ impact, ...change }) => change),
    total: changes.length,
    truncated: changes.length > 20
  }
}

function findingDetail (report, finding, options = {}) {
  const topK = Number.isInteger(options.top_k) ? Math.max(1, Math.min(20, options.top_k)) : 10
  const maxDepth = Number.isInteger(options.max_depth) ? Math.max(0, Math.min(20, options.max_depth)) : 3
  const sourceContextLines = Number.isInteger(options.source_context_lines) ? Math.max(0, Math.min(80, options.source_context_lines)) : 0
  const sourceNode = callTreesByReport.get(report) && callTreesByReport.get(report).get(finding && finding.id)
  const sourceRoots = options.source_roots || options.source_root
  const callTree = sourceNode ? boundedCallTree(sourceNode, topK, maxDepth, sourceRoots) : null
  return {
    finding,
    call_tree: callTree,
    source_context: sourceContextLines > 0 ? readSourceContext(sourceRoots, finding, sourceContextLines) : null,
    detail_limits: {
      top_k: topK,
      max_depth: maxDepth,
      source_context_lines: sourceContextLines
    }
  }
}

function boundedCallTree (sourceNode, topK, maxDepth, sourceRoot, maxNodes = 500) {
  let included = 0
  let truncated = false
  function copy (node, depth) {
    if (included >= maxNodes) {
      truncated = true
      return null
    }
    included++
    const result = {
      name: String(node.name || 'anonymous').slice(0, 120),
      self_time_pct: Number.isFinite(node.self_time_pct) ? Math.max(0, Math.min(100, node.self_time_pct)) : 0,
      total_time_pct: Number.isFinite(node.total_time_pct) ? Math.max(0, Math.min(100, node.total_time_pct)) : 0,
      location: normalizeSourceLocation(node.file, node.line, sourceRoot),
      children: []
    }
    if (depth >= maxDepth) {
      if (Array.isArray(node.children) && node.children.length) truncated = true
      return result
    }
    const children = (Array.isArray(node.children) ? node.children : []).slice().sort((a, b) => {
      const total = (Number(b.total_time_pct) || 0) - (Number(a.total_time_pct) || 0)
      const self = (Number(b.self_time_pct) || 0) - (Number(a.self_time_pct) || 0)
      return total || self || String(a.name || '').localeCompare(String(b.name || ''))
    })
    if (children.length > topK) truncated = true
    for (const child of children.slice(0, topK)) {
      const copied = copy(child, depth + 1)
      if (!copied) break
      result.children.push(copied)
    }
    return result
  }
  return { root: copy(sourceNode, 0), truncated, node_count: included, max_nodes: maxNodes }
}

function readSourceContext (sourceRoot, finding, requestedLines) {
  const file = finding.location && finding.location.file
  const line = finding.location && finding.location.line
  const entries = sourceRootEntries(sourceRoot)
  if (!entries.length || typeof file !== 'string' || !Number.isInteger(line) || line < 1) return { available: false, reason: 'source_location_unavailable', lines: [] }
  try {
    let candidate
    let reportFile
    for (const entry of entries) {
      const prefix = String(entry.reportPrefix || '').replace(/\/$/, '')
      let relative
      if (prefix) {
        if (file !== prefix && !file.startsWith(`${prefix}/`)) continue
        relative = file === prefix ? '' : file.slice(prefix.length + 1)
      } else {
        if (file.startsWith('inputs/')) continue
        relative = file
      }
      if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        if (relative !== '') continue
      }
      const mapping = mapSourcePath(relative, { ...entry, virtualRoot: '/workspace', relativePaths: true })
      if (!mapping) continue
      if (!isCanonicalSourceFile(mapping.root, mapping.relative)) continue
      candidate = mapping.relative ? path.resolve(mapping.root, ...mapping.relative.split('/')) : mapping.root
      reportFile = file
      break
    }
    if (!candidate) return { available: false, reason: 'source_outside_workspace', lines: [] }
    const stat = fs.lstatSync(candidate)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return { available: false, reason: 'source_file_unavailable', lines: [] }
    const resolved = fs.realpathSync(candidate)
    const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    let sourceText
    try {
      const finalStat = fs.fstatSync(descriptor)
      if (!finalStat.isFile() || finalStat.size > 1024 * 1024) return { available: false, reason: 'source_file_unavailable', lines: [] }
      sourceText = fs.readFileSync(descriptor, 'utf8')
    } finally {
      fs.closeSync(descriptor)
    }
    const source = sourceText.split(/\r?\n/)
    if (line > source.length) return { available: false, reason: 'source_line_unavailable', lines: [] }
    const start = Math.max(1, line - Math.floor(requestedLines / 2))
    const end = Math.min(source.length, start + requestedLines - 1)
    const actualStart = Math.max(1, end - requestedLines + 1)
    return {
      available: true,
      file: reportFile,
      line,
      lines: source.slice(actualStart - 1, end).map((text, index) => ({ line: actualStart + index, text: text.slice(0, 1000) }))
    }
  } catch {
    return { available: false, reason: 'source_file_unavailable', lines: [] }
  }
}

module.exports = { analyzeClinicFlame, analyzeClinicDiagnostics, normalizeNodes, createCompatibility, compareReports, findingDetail }
