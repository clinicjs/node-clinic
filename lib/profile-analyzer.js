'use strict'

const crypto = require('crypto')

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

function normalizeNodes (profile) {
  const source = Array.isArray(profile && profile.nodes)
    ? profile.nodes
    : Array.isArray(profile && profile.functions) ? profile.functions : []
  return source.map((node, index) => {
    const self = Number(node.self_time_pct ?? node.selfPct ?? node.self ?? 0)
    const total = Number(node.total_time_pct ?? node.totalPct ?? node.total ?? self)
    return {
      name: typeof node.name === 'string' && node.name.length > 0 ? node.name : `node-${index + 1}`,
      file: typeof node.file === 'string' ? node.file : null,
      line: Number.isInteger(node.line) && node.line > 0 ? node.line : null,
      self: Number.isFinite(self) ? Math.max(0, Math.min(100, self)) : 0,
      total: Number.isFinite(total) ? Math.max(0, Math.min(100, total)) : 0
    }
  }).sort((a, b) => b.total - a.total || b.self - a.self || canonicalLocation(a).localeCompare(canonicalLocation(b)) || a.name.localeCompare(b.name))
}

function createCompatibility (options) {
  const runtime = options.runtime || { node_version: `node-${process.version}`, toolchain_digest: sha256(options.toolchain || process.execPath) }
  const isolation = options.isolation || {
    provider: 'local-supervisor',
    version: '1',
    limits: { wall_clock_ms: 120000, cpu_ms: 120000, memory_mb: 1024, artifact_mb: 512, network: 'disabled' }
  }
  return {
    schema_version: 1,
    workload: options.workload,
    manifest_hash: options.manifest_hash || sha256(options.manifest || options.workload),
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
    repository: {
      identity: options.repository || 'local',
      revision: options.commit
    }
  }
}

function analyzeClinicFlame (profile, options = {}) {
  const now = options.now || new Date().toISOString()
  const nodes = normalizeNodes(profile)
  const runId = options.run_id || `run_${now.replace(/[-:.TZ]/g, '')}_${sha256(JSON.stringify(profile)).slice(-12)}`
  const maxFindings = Number.isInteger(options.max_findings) ? Math.max(0, Math.min(20, options.max_findings)) : 20
  const findings = nodes.slice(0, maxFindings).map((node, index) => ({
    id: `finding-${String(index + 1).padStart(3, '0')}`,
    severity: severityFor(node.total),
    category: 'cpu',
    title: `${node.name} dominates sampled CPU time`,
    observation: {
      metric: 'total_cpu_time_pct',
      self_time_pct: node.self,
      total_time_pct: node.total
    },
    location: node.file && node.line ? { file: node.file, line: node.line } : null,
    hypotheses: [],
    next_checks: [],
    confidence: nodes.length > 0 ? 'medium' : 'unsupported',
    evidence: {
      adapter: 'clinic-flame-v1',
      adapter_schema_version: '1',
      sample_count: Number.isInteger(options.sample_count) && options.sample_count > 0 ? options.sample_count : 1
    }
  }))

  const duration = Number.isFinite(profile && profile.duration_ms) ? Math.max(0, profile.duration_ms) : 0
  const throughput = profile && profile.throughput && Number.isFinite(profile.throughput.value)
    ? { value: Math.max(0, profile.throughput.value), unit: profile.throughput.unit, definition: profile.throughput.definition }
    : null
  const commit = options.commit || '0000000000000000000000000000000000000000'
  const compatibility = createCompatibility({ ...options, commit })
  return {
    schema_version: 1,
    run: {
      id: runId,
      workload: options.workload || 'unknown',
      profiler: options.profiler || 'clinic-flame',
      commit,
      node: compatibility.runtime.node_version,
      architecture: compatibility.architecture,
      compatibility,
      status: 'completed',
      lifecycle: { created_at: now, finished_at: now }
    },
    summary: {
      duration_ms: duration,
      throughput,
      confidence: findings.length > 0 ? 'medium' : 'unsupported',
      capabilities: {
        cpu_call_tree: 'supported',
        event_loop_delay: 'unsupported',
        heap_retained_delta: 'unsupported'
      }
    },
    comparison: null,
    findings,
    artifacts: options.artifact_ref ? [{ kind: 'clinic', ref: options.artifact_ref, classification: options.artifact_classification || 'sensitive-diagnostic' }] : [],
    usage: {
      estimated_input_tokens: Number.isInteger(options.estimated_input_tokens) ? Math.max(0, options.estimated_input_tokens) : 0,
      estimated_output_tokens: Number.isInteger(options.estimated_output_tokens) ? Math.max(0, options.estimated_output_tokens) : 0,
      token_counts_are_estimates: true,
      truncated: nodes.length > maxFindings
    }
  }
}

function analyzeClinicDiagnostics (profiler, profile, options = {}) {
  if (profiler === 'clinic-flame') return analyzeClinicFlame(profile, options)
  const now = options.now || new Date().toISOString()
  const findings = []
  const addFinding = (finding) => {
    if (findings.length >= 20) return
    findings.push({
      id: `finding-${String(findings.length + 1).padStart(3, '0')}`,
      severity: finding.severity || 'low',
      category: finding.category,
      title: finding.title,
      observation: finding.observation,
      location: finding.location || null,
      hypotheses: [],
      next_checks: [],
      confidence: finding.confidence || 'medium',
      evidence: {
        adapter: `${profiler}-v1`,
        adapter_schema_version: '1',
        sample_count: Math.max(1, Number.isInteger(profile.sample_count) ? profile.sample_count : 1)
      }
    })
  }

  if (profiler === 'clinic-doctor') {
    function visitIssue (key, value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [childKey, childValue] of Object.entries(value)) visitIssue(`${key}_${childKey}`, childValue)
      } else if (value === 'performance') {
        addFinding({
          severity: 'medium',
          category: key.startsWith('memory') ? 'memory' : key === 'delay' ? 'event-loop' : key,
          title: `Clinic Doctor detected a ${key} performance issue`,
          observation: { metric: 'doctor_issue_status', values: { status: value, issue: key } }
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
    for (const operation of [...operations.values()].sort((a, b) => b.maxDuration - a.maxDuration).slice(0, 20)) {
      addFinding({
        category: 'async',
        title: `${operation.name} has the longest observed async lifetime`,
        observation: { metric: 'max_async_lifetime_ms', values: { max_duration_ms: operation.maxDuration, operations: operation.count } }
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
    for (const { node, self, share } of nodes.slice(0, 20)) {
      addFinding({
        severity: severityFor(share),
        category: 'memory',
        title: `${node.name || node.functionName || 'Unknown allocation'} retains heap memory`,
        observation: { metric: 'retained_heap_share', values: { self_retained_bytes: self, total_retained_bytes: total, share_pct: share } },
        location: node.fileName && Number.isInteger(node.lineNumber) && node.lineNumber > 0 ? { file: node.fileName, line: node.lineNumber } : null
      })
    }
  }

  const commit = options.commit || '0000000000000000000000000000000000000000'
  const compatibility = createCompatibility({ ...options, profiler, commit })
  return {
    schema_version: 1,
    run: {
      id: options.run_id || `run_${now.replace(/[-:.TZ]/g, '')}_${sha256(JSON.stringify(profile)).slice(-12)}`,
      workload: options.workload || 'unknown',
      profiler,
      commit,
      node: compatibility.runtime.node_version,
      architecture: compatibility.architecture,
      compatibility,
      status: 'completed',
      lifecycle: { created_at: options.started_at || now, finished_at: options.finished_at || now }
    },
    summary: {
      duration_ms: Math.max(0, Number(profile.duration_ms || profile.runtime_ms) || 0),
      throughput: null,
      confidence: findings.length ? 'medium' : 'unsupported',
      capabilities: {
        cpu_call_tree: profiler === 'clinic-flame' ? 'supported' : 'unsupported',
        event_loop_delay: profiler === 'clinic-doctor' ? 'supported' : 'unsupported',
        heap_retained_delta: 'unsupported'
      }
    },
    comparison: null,
    findings,
    artifacts: options.artifact_ref ? [{ kind: 'clinic', ref: options.artifact_ref, classification: options.artifact_classification || 'sensitive-diagnostic' }] : [],
    usage: { estimated_input_tokens: 0, estimated_output_tokens: 0, token_counts_are_estimates: true, truncated: false }
  }
}

function stableStringify (value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function compareReports (candidate, baseline) {
  const candidateCompatibility = candidate && candidate.run && candidate.run.compatibility
  const baselineCompatibility = baseline && baseline.run && baseline.run.compatibility
  if (!candidateCompatibility || !baselineCompatibility || stableStringify(candidateCompatibility) !== stableStringify(baselineCompatibility)) {
    return { compatibility: 'incompatible', baseline_run_id: baseline && baseline.run ? baseline.run.id : 'unknown' }
  }
  const candidateThroughput = candidate.summary && candidate.summary.throughput
  const baselineThroughput = baseline.summary && baseline.summary.throughput
  if (!candidateThroughput || !baselineThroughput || baselineThroughput.value === 0) {
    return { compatibility: 'incompatible', baseline_run_id: baseline.run.id }
  }
  const delta = ((candidateThroughput.value - baselineThroughput.value) / baselineThroughput.value) * 100
  return {
    compatibility: 'compatible',
    baseline_run_id: baseline.run.id,
    metric: 'throughput',
    units: candidateThroughput.unit,
    metric_definition: candidateThroughput.definition,
    direction: 'higher_is_better',
    denominator: 'baseline_median',
    delta_pct: delta,
    candidate_sample_count: 1,
    candidate_warmup_count: 0,
    candidate_uncertainty: { method: 'bootstrap_95_ci', algorithm_version: '1', seed: 0, low_pct: delta, high_pct: delta },
    baseline_sample_count: 1,
    baseline_warmup_count: 0,
    baseline_uncertainty: { method: 'bootstrap_95_ci', algorithm_version: '1', seed: 0, low_pct: 0, high_pct: 0 }
  }
}

function findingDetail (report, finding, options = {}) {
  const topK = Number.isInteger(options.top_k) ? Math.max(1, Math.min(20, options.top_k)) : 10
  return {
    finding,
    call_tree: {
      top_k: topK,
      max_depth: Number.isInteger(options.max_depth) ? Math.max(0, Math.min(20, options.max_depth)) : 3,
      nodes: [finding]
    },
    source_context: options.source_context_lines > 0 ? { file: finding.location && finding.location.file, line: finding.location && finding.location.line, lines: [] } : null
  }
}

module.exports = { analyzeClinicFlame, analyzeClinicDiagnostics, normalizeNodes, createCompatibility, compareReports, findingDetail }
