'use strict'

const crypto = require('crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const packageInfo = require('../package.json')
const { validateComparison, validateWorkloadParameters } = require('./profile-semantic-validator')
const { sanitizeUntrustedStrings } = require('./profile-sanitize')
const { commandMetadata, parameterMetadata } = require('./profile-command')

function randomToken (prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('base64url')}`
}

const MAX_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_APPROVAL_TTL_MS = 10 * 60 * 1000

function tokenHash (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function artifactFileIdentity (stat) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key])).join(':')
}

async function hashArtifactDescriptor (descriptor) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(null, { fd: descriptor, autoClose: false })
  for await (const chunk of stream) hash.update(chunk)
  return `sha256-${hash.digest('hex')}`
}

function snapshotWorkloads (workloads) {
  const snapshot = JSON.parse(JSON.stringify(workloads || {}))
  function freeze (value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
    for (const child of Object.values(value)) freeze(child)
    return Object.freeze(value)
  }
  return freeze(snapshot)
}

function safeArtifactPath (value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return null
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.length > 255)) return null
  return segments
}

function safeArtifactFile (artifactRoot, runId, segments) {
  let descriptor
  try {
    const root = fs.realpathSync(artifactRoot)
    const runDir = path.join(root, runId)
    const artifactDir = path.join(runDir, 'artifacts')
    for (const directory of [runDir, artifactDir]) {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    }
    let candidate = artifactDir
    for (const [index, segment] of segments.entries()) {
      candidate = path.join(candidate, segment)
      const stat = fs.lstatSync(candidate)
      if (stat.isSymbolicLink()) return null
      if (index < segments.length - 1 && !stat.isDirectory()) return null
      if (index === segments.length - 1 && !stat.isFile()) return null
    }
    const resolved = fs.realpathSync(candidate)
    if (!resolved.startsWith(`${artifactDir}${path.sep}`)) return null
    const stat = fs.lstatSync(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
    const opened = fs.fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      fs.closeSync(descriptor)
      return null
    }
    return { descriptor, size: opened.size, identity: artifactFileIdentity(fs.fstatSync(descriptor, { bigint: true })) }
  } catch {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    return null
  }
}

function matchesSecret (storedHash, token) {
  const expected = Buffer.from(storedHash || '', 'hex')
  const actual = Buffer.from(tokenHash(token), 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function envelope (requestId, ok, data, error, usage) {
  return {
    request_id: requestId || randomToken('req'),
    ok,
    data: ok ? (data || {}) : null,
    error: ok ? null : error,
    usage: usage || null
  }
}

function failure (requestId, code, message, retryable = false) {
  return envelope(requestId, false, null, { code, message, retryable })
}

function decodeFindingCursor (cursor, expected, cursors) {
  const value = cursors.get(tokenHash(cursor))
  if (!value || value.sessionId !== expected.sessionId || value.runId !== expected.runId || value.snapshotId !== expected.snapshotId || value.sort !== expected.sort || value.severity !== expected.severity || value.expiresAt <= expected.now || value.expiresAt > expected.runExpiresAt || !Number.isSafeInteger(value.offset) || value.offset < 0) return null
  return value.offset
}

function cursorOffset (cursor, expected, cursors) {
  const value = cursors.get(tokenHash(cursor))
  if (!value || value.kind !== expected.kind || value.sessionId !== expected.sessionId || value.scope !== expected.scope || value.runId !== expected.runId || value.resourceHash !== expected.resourceHash || value.snapshotId !== expected.snapshotId || value.expiresAt <= expected.now || value.expiresAt > expected.expiresAt || !Number.isSafeInteger(value.offset) || value.offset < 0) return null
  return value.offset
}

function snapshotId (report) {
  return crypto.createHash('sha256').update(JSON.stringify(report.findings)).digest('base64url')
}

function findingImpact (finding) {
  const observation = finding.observation || {}
  const values = observation.values || observation
  const metric = String(observation.metric || '')
  const preferred = /heap|retained|alloc/i.test(metric)
    ? ['self_retained_bytes', 'retained_bytes', 'allocated_bytes']
    : /event|delay|wait|duration|latency/i.test(metric)
      ? ['max_duration_ms', 'event_loop_delay_ms', 'wait_time_ms', 'duration_ms', 'total_time_pct', 'share_pct', 'self_retained_bytes']
      : ['total_time_pct', 'share_pct', 'max_duration_ms', 'self_retained_bytes']
  for (const key of preferred) {
    if (Number.isFinite(values[key])) return values[key]
  }
  return 0
}

function findingSource (finding) {
  const location = finding.location || {}
  return {
    file: typeof location.file === 'string' ? location.file.replaceAll('\\', '/') : '',
    line: Number.isInteger(location.line) ? location.line : 0
  }
}

function compareFindingTieBreakers (a, b) {
  const category = String(a.category || '').localeCompare(String(b.category || ''))
  if (category) return category
  const left = findingSource(a)
  const right = findingSource(b)
  const file = left.file.localeCompare(right.file)
  if (file) return file
  const line = left.line - right.line
  if (line) return line
  return String(a.id || '').localeCompare(String(b.id || ''))
}

function findingInformationScore (finding) {
  const observation = finding.observation || {}
  const values = observation.values || observation
  const quantified = Object.entries(values).some(([key, value]) => key !== 'metric' && Number.isFinite(value))
  if (!quantified) return 0
  return 1 + (finding.evidence && Number.isInteger(finding.evidence.sample_count) && finding.evidence.sample_count >= 2 ? 1 : 0)
}

function estimateTokens (text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

function tokenTotal (usage, scope) {
  if (!usage) return 0
  const prefix = scope ? `${scope}` : ''
  const inputKey = scope ? `${prefix}InputTokens` : 'inputTokens'
  const outputKey = scope ? `${prefix}OutputTokens` : 'outputTokens'
  return (usage[inputKey] || 0) + (usage[outputKey] || 0)
}

function isTerminalProfileResponse (response) {
  const status = response.data && (response.data.status || (response.data.run && response.data.run.status))
  return ['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(status)
}

function terminalErrorReport (run) {
  const fallbackErrors = {
    failed: { code: 'PROFILE_FAILED', message: 'Profile run failed', retryable: false },
    timed_out: { code: 'PROFILE_TIMEOUT', message: 'Profile run exceeded its wall-clock limit', retryable: true },
    cancelled: { code: 'PROFILE_CANCELLED', message: 'Profile run was cancelled', retryable: false },
    partial: { code: 'PROFILE_PARTIAL', message: 'Profile run produced incomplete results', retryable: false }
  }
  const error = run.error || fallbackErrors[run.status]
  const finishedAt = run.finishedAt ? new Date(run.finishedAt).toISOString() : new Date().toISOString()
  return {
    schema_version: 1,
    run: {
      id: run.id,
      workload: run.workload,
      profiler: run.profiler || 'clinic-flame',
      commit: null,
      clinic_version: packageInfo.version,
      os_version: `${os.platform()}-${os.release()}`,
      node: `node-${process.version}`,
      architecture: `${process.platform}-${process.arch}`,
      status: run.status,
      exit_code: Number.isInteger(run.exitCode) ? run.exitCode : null,
      termination_reason: run.terminationReason || run.status,
      lifecycle: {
        created_at: new Date(run.createdAt).toISOString(),
        finished_at: finishedAt
      },
      ...(run.command ? { command: run.command } : {}),
      ...(run.parameters ? { parameters: run.parameters } : {}),
      error: {
        code: String(error.code || 'PROFILE_FAILED'),
        message: String(error.message || 'Profile run failed'),
        retryable: error.retryable === true
      },
      compatibility: null
    },
    summary: null,
    comparison: null,
    findings: null,
    artifacts: typeof run.artifactRefHash === 'string'
      ? [{ kind: 'clinic', ref_hash: run.artifactRefHash, classification: 'sensitive-diagnostic' }]
      : null,
    usage: null
  }
}

function resourceCostEstimate (workload) {
  const limits = workload && workload.limits
  if (!limits) return null
  return {
    basis: 'declared_limits',
    wall_clock_ms: limits.wall_clock_ms,
    cpu_ms: limits.cpu_ms,
    memory_mb: limits.memory_mb,
    artifact_mb: limits.artifact_mb
  }
}

function diagnosticClassification (report) {
  const rank = { 'public-diagnostic': 0, 'sensitive-diagnostic': 1, restricted: 2 }
  const classifications = (report && Array.isArray(report.artifacts) ? report.artifacts : [])
    .map(artifact => artifact && artifact.classification)
    .filter(value => Object.prototype.hasOwnProperty.call(rank, value))
  if (classifications.length === 0) return 'sensitive-diagnostic'
  return classifications.sort((a, b) => rank[b] - rank[a])[0]
}

function boundedJsonLength (value, limit) {
  let length = 0
  const active = new Set()
  function add (size) {
    length += size
    return length <= limit
  }
  function visit (item, depth) {
    if (depth > 64) return add(limit + 1)
    if (item === null) return add(4)
    if (typeof item === 'string') return item.length > limit ? add(limit + 1) : add(JSON.stringify(item).length)
    if (typeof item === 'number' || typeof item === 'boolean') return add(JSON.stringify(item).length)
    if (Array.isArray(item)) {
      if (active.has(item)) return add(limit + 1)
      active.add(item)
      let first = true
      if (!add(1)) return false
      for (const child of item) {
        if (!first && !add(1)) return false
        first = false
        if (!visit(child, depth + 1)) return false
      }
      active.delete(item)
      return add(1)
    }
    if (typeof item === 'object') {
      if (active.has(item)) return add(limit + 1)
      active.add(item)
      let first = true
      if (!add(1)) return false
      for (const key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key) || item[key] === undefined) continue
        if (!first && !add(1)) return false
        first = false
        if (key.length > limit || !add(JSON.stringify(key).length + 1) || !visit(item[key], depth + 1)) return false
      }
      active.delete(item)
      return add(1)
    }
    return add(4)
  }
  visit(value, 0)
  return length
}

function pruneFindingDetail (detail, maxChars) {
  let truncated = false
  const length = () => JSON.stringify(detail).length
  const treeNodeCount = node => 1 + (node.children || []).reduce((sum, child) => sum + treeNodeCount(child), 0)
  function removeLastLeaf (node) {
    if (!node || !Array.isArray(node.children) || node.children.length === 0) return false
    for (let index = node.children.length - 1; index >= 0; index--) {
      const child = node.children[index]
      if (removeLastLeaf(child)) return true
      if (!child.children || child.children.length === 0) {
        node.children.splice(index, 1)
        return true
      }
    }
    return false
  }

  while (length() > maxChars) {
    const tree = detail.call_tree
    if (tree && tree.root && tree.root.children && tree.root.children.length > 0) {
      if (!removeLastLeaf(tree.root)) tree.root.children.pop()
      tree.truncated = true
      tree.node_count = treeNodeCount(tree.root)
      truncated = true
      continue
    }
    const lines = detail.source_context && detail.source_context.lines
    if (Array.isArray(lines) && lines.length > 0) {
      const center = detail.finding && detail.finding.location && detail.finding.location.line
      let removeIndex = lines.length - 1
      if (Number.isInteger(center)) {
        for (let index = 0; index < lines.length; index++) {
          if (Math.abs(lines[index].line - center) > Math.abs(lines[removeIndex].line - center)) removeIndex = index
        }
      }
      lines.splice(removeIndex, 1)
      if (detail.detail_limits) detail.detail_limits.source_context_lines = lines.length
      truncated = true
      continue
    }
    if (detail.call_tree) {
      detail.call_tree = null
      truncated = true
      continue
    }
    break
  }
  if (truncated) {
    detail.truncated = true
    if (detail.detail_limits) detail.detail_limits.truncated = true
  }
  return truncated
}

class ProfileMcpServer {
  constructor (options = {}) {
    // Keep a private immutable snapshot for the lifetime of this MCP process.
    // Tool inputs and later changes to the caller's object cannot register or
    // alter executable workloads.
    this.workloads = snapshotWorkloads(options.workloads)
    this.runner = options.runner
    this.artifactRoot = options.artifactRoot ? path.resolve(options.artifactRoot) : null
    this.manifestHash = options.manifestHash || null
    this.isolationProvider = options.isolationProvider
    // The MCP facade never exposes direct-host execution. Manual profiling
    // without strict isolation belongs to the CLI entry point.
    Object.defineProperty(this, 'strictIsolation', { value: true, enumerable: true })
    this.analyzer = options.analyzer
    this.reports = new Map()
    for (const [runId, report] of options.reports || []) this._storeReport(runId, report)
    this.artifactReferences = new Map()
    Object.defineProperty(this, 'artifactRefKey', { value: crypto.randomBytes(32) })
    this.maxArtifactReferences = options.maxArtifactReferences || options.maxRuns || 100
    this.runs = new Map()
    this.approvals = new Map()
    this.sessionId = options.sessionId || randomToken('session')
    this.cursors = new Map()
    this.now = options.now || (() => Date.now())
    this.ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? Math.min(options.ttlMs, MAX_CAPABILITY_TTL_MS) : MAX_CAPABILITY_TTL_MS
    this.cursorTtlMs = options.cursorTtlMs || 15 * 60 * 1000
    this.approvalTtlMs = Number.isSafeInteger(options.approvalTtlMs) && options.approvalTtlMs > 0 ? Math.min(options.approvalTtlMs, MAX_APPROVAL_TTL_MS) : MAX_APPROVAL_TTL_MS
    this.pageLimit = options.pageLimit || 20
    this.minFindingInformationScore = Number.isInteger(options.minFindingInformationScore)
      ? Math.max(1, Math.min(2, options.minFindingInformationScore))
      : 2
    this.maxRuns = options.maxRuns || 100
    this.maxCursors = options.maxCursors || 1000
    const defaultBudgets = {
      maxInputCharsPerCall: 20000,
      maxOutputCharsPerCall: 12000,
      maxSessionTokens: 256000,
      maxRunTokens: 64000,
      maxProcessTokens: 2000000,
      maxWindowTokens: 1000000,
      windowMs: 24 * 60 * 60 * 1000
    }
    this.budgets = { ...defaultBudgets }
    for (const [key, value] of Object.entries(options.budgets || {})) {
      if (Object.prototype.hasOwnProperty.call(defaultBudgets, key) && Number.isSafeInteger(value) && value > 0) this.budgets[key] = Math.min(defaultBudgets[key], value)
    }
    this.usage = { windowStartedAt: this.now(), windowEvents: [], windowInputTokens: 0, windowOutputTokens: 0, sessionInputTokens: 0, sessionOutputTokens: 0, processInputTokens: 0, processOutputTokens: 0 }
    this.runUsage = new Map()
  }

  _pruneExpired () {
    const now = this.now()
    for (const [runId, run] of this.runs) {
      if (run.expiresAt <= now) {
        this.runs.delete(runId)
        this.reports.delete(runId)
        this.runUsage.delete(runId)
        for (const [hash, reference] of this.artifactReferences) if (reference.runId === runId) this.artifactReferences.delete(hash)
      }
    }
    for (const [token, approval] of this.approvals) {
      if (approval.expiresAt <= now || approval.used) this.approvals.delete(token)
    }
    for (const [token, cursor] of this.cursors) {
      if (cursor.expiresAt <= now) this.cursors.delete(token)
    }
  }

  _capability () {
    return randomToken('cap')
  }

  _storeReport (runId, report) {
    if (!report || typeof report !== 'object') return null
    const stored = JSON.parse(JSON.stringify(report))
    for (const artifact of stored.artifacts || []) {
      if (artifact && typeof artifact.ref === 'string') {
        artifact.ref_hash = tokenHash(artifact.ref)
        delete artifact.ref
      }
    }
    this.reports.set(runId, stored)
    return stored
  }

  _mergeRunnerStatus (run, status) {
    if (!status || typeof status !== 'object') return
    const { report, artifactRef, artifactRefHash, ...safeStatus } = status
    Object.assign(run, safeStatus)
    if (typeof artifactRef === 'string') run.artifactRefHash = tokenHash(artifactRef)
    else if (typeof artifactRefHash === 'string') run.artifactRefHash = artifactRefHash
    if (report) this._storeReport(run.id, report)
  }

  _exposeReport (run, report) {
    const exposed = JSON.parse(JSON.stringify(report))
    const files = run.artifact && run.artifact.files
    const validFiles = Array.isArray(files)
      ? files.filter(entry => entry && safeArtifactPath(entry.path) && Number.isSafeInteger(entry.size) && entry.size >= 0 && /^sha256-[a-f0-9]{64}$/.test(entry.hash || ''))
      : []
    const artifacts = []
    for (const artifact of exposed.artifacts || []) {
      if (!artifact || artifact.kind !== 'clinic' || typeof artifact.ref_hash !== 'string' || !validFiles.length || !this.artifactRoot) continue
      const ref = this._artifactHandle(run, artifact.ref_hash)
      const fileMap = new Map(validFiles.map(entry => [entry.path, { size: entry.size, hash: entry.hash, verifiedIdentity: null }]))
      this.artifactReferences.set(tokenHash(ref), {
        runId: run.id,
        sessionId: this.sessionId,
        expiresAt: Math.min(run.expiresAt, run.createdAt + MAX_CAPABILITY_TTL_MS),
        classification: ['public-diagnostic', 'sensitive-diagnostic', 'restricted'].includes(artifact.classification) ? artifact.classification : 'sensitive-diagnostic',
        files: fileMap
      })
      artifact.ref = ref
      delete artifact.ref_hash
      artifacts.push(artifact)
    }
    if (Array.isArray(exposed.artifacts)) exposed.artifacts = artifacts
    while (this.artifactReferences.size > this.maxArtifactReferences) this.artifactReferences.delete(this.artifactReferences.keys().next().value)
    return exposed
  }

  _artifactHandle (run, referenceHash) {
    const scope = `${this.sessionId}\0${run.id}\0${referenceHash}`
    const random = crypto.createHmac('sha256', this.artifactRefKey).update(scope).digest().subarray(0, 16)
    return `artifact_${random.toString('base64url')}`
  }

  _owns (run, capability) {
    return run && run.sessionId === this.sessionId && matchesSecret(run.capabilityHash, capability) && run.expiresAt > this.now()
  }

  _getRun (input, requestId) {
    this._pruneExpired()
    const run = this.runs.get(input && input.run_id)
    if (!run || !this._owns(run, input.run_capability)) return { error: failure(requestId, 'not_found', 'run not found or capability is invalid') }
    return { run }
  }

  async call (tool, input = {}, requestId) {
    if (input == null) input = {}
    if (typeof input !== 'object' || Array.isArray(input)) return this._budgetFailure(requestId, 'invalid_input', 'tool input must be an object')
    const inputChars = boundedJsonLength({ tool, input }, this.budgets.maxInputCharsPerCall)
    this._pruneExpired()
    this._resetUsageWindow()
    if (inputChars > this.budgets.maxInputCharsPerCall) return this._budgetFailure(requestId, 'request_too_large', 'tool input exceeds the per-call character limit')
    const inputTokens = estimateTokens(JSON.stringify({ tool, input }))
    const runScopes = [[input.run_id, input.run_capability], [input.candidate_run_id, input.candidate_run_capability], [input.baseline_run_id, input.baseline_run_capability]]
    const runIds = [...new Set(runScopes.filter(([runId, capability]) => this._owns(this.runs.get(runId), capability)).map(([runId]) => runId))]
    if (runIds.some(runId => tokenTotal(this.runUsage.get(runId)) + inputTokens > this.budgets.maxRunTokens)) return this._budgetFailure(requestId, 'run_budget_exceeded', 'run token budget is exhausted')
    if (tokenTotal(this.usage, 'session') + inputTokens > this.budgets.maxSessionTokens || tokenTotal(this.usage, 'window') + inputTokens > this.budgets.maxWindowTokens || tokenTotal(this.usage, 'process') + inputTokens > this.budgets.maxProcessTokens) return this._budgetFailure(requestId, 'input_budget_exceeded', 'token budget is exhausted')
    this.usage.sessionInputTokens += inputTokens
    this.usage.windowInputTokens += inputTokens
    this.usage.processInputTokens += inputTokens
    this.usage.windowEvents.push({ at: this.now(), inputTokens, outputTokens: 0 })
    for (const runId of runIds) this._addRunUsage(runId, 'inputTokens', inputTokens)
    let response
    try {
      switch (tool) {
        case 'list_profile_workloads': response = this.listProfileWorkloads(input, requestId); break
        case 'start_profile_run': response = await this.startProfileRun(input, requestId, inputTokens); break
        case 'approve_profile_run': response = this.approveProfileRun(input, requestId); break
        case 'get_profile_status': response = await this.getProfileStatus(input, requestId); break
        case 'wait_profile_run': response = await this.waitProfileRun(input, requestId); break
        case 'get_profile_findings': response = await this.getProfileFindings(input, requestId); break
        case 'compare_profile_runs': response = await this.compareProfileRuns(input, requestId); break
        case 'get_finding_detail': response = await this.getFindingDetail(input, requestId); break
        case 'get_profile_artifact': response = await this.getProfileArtifact(input, requestId); break
        case 'cancel_profile_run': response = await this.cancelProfileRun(input, requestId); break
        default: response = failure(requestId, 'unknown_tool', `unknown tool: ${tool}`)
      }
    } catch (err) {
      response = failure(requestId, 'internal_error', err.message || 'internal error', true)
    }
    response = sanitizeUntrustedStrings(response)
    this._resetUsageWindow()
    const outputRunIds = [...new Set([...runIds, ...(response.ok && response.data && typeof response.data.run_id === 'string' ? [response.data.run_id] : [])])]
    let projectedOutputTokens = this._estimateOutputTokens(response, inputTokens, outputRunIds)
    let outputProjection = { ...response, usage: this._responseUsage(inputTokens, projectedOutputTokens, outputRunIds) }
    let outputText = JSON.stringify(outputProjection)
    let outputChars = outputText.length
    if (outputChars > this.budgets.maxOutputCharsPerCall && response.ok && response.data && response.data.schema_version === 1 && Array.isArray(response.data.findings)) {
      let removedFindings = 0
      while (outputChars > this.budgets.maxOutputCharsPerCall && response.data.findings.length > 0) {
        response.data.findings.pop()
        removedFindings++
        response.data.usage = {
          estimated_input_tokens: inputTokens,
          estimated_output_tokens: estimateTokens(JSON.stringify(response.data)),
          token_counts_are_estimates: true,
          truncated: true
        }
        projectedOutputTokens = this._estimateOutputTokens(response, inputTokens, outputRunIds)
        outputProjection = { ...response, usage: this._responseUsage(inputTokens, projectedOutputTokens, outputRunIds) }
        outputText = JSON.stringify(outputProjection)
        outputChars = outputText.length
      }
      if (removedFindings) response.usage = { ...response.usage, truncated: true }
    }
    for (const runId of outputRunIds) if (!runIds.includes(runId)) this._addRunUsage(runId, 'inputTokens', inputTokens)
    if (outputChars > this.budgets.maxOutputCharsPerCall) response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit; request a smaller page or detail level', true)
    else if (outputRunIds.some(runId => tokenTotal(this.runUsage.get(runId)) + projectedOutputTokens > this.budgets.maxRunTokens)) response = failure(requestId, 'run_budget_exceeded', 'run token budget is exhausted', true)
    else if (tokenTotal(this.usage, 'session') + projectedOutputTokens > this.budgets.maxSessionTokens || tokenTotal(this.usage, 'window') + projectedOutputTokens > this.budgets.maxWindowTokens || tokenTotal(this.usage, 'process') + projectedOutputTokens > this.budgets.maxProcessTokens) response = failure(requestId, 'output_budget_exceeded', 'token budget is exhausted', true)
    if (!response.ok) {
      projectedOutputTokens = this._estimateOutputTokens(response, inputTokens, outputRunIds)
      outputProjection = { ...response, usage: this._responseUsage(inputTokens, projectedOutputTokens, outputRunIds) }
      outputText = JSON.stringify(outputProjection)
      outputChars = outputText.length
    }
    if (outputChars > this.budgets.maxOutputCharsPerCall) response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit', true)
    let outputTokens = projectedOutputTokens
    // Charge for the serialized envelope including usage metadata. Using the
    // projection keeps quota checks conservative and avoids undercounting the
    // fields returned to the caller.
    this.usage.sessionOutputTokens += outputTokens
    this.usage.windowOutputTokens += outputTokens
    this.usage.processOutputTokens += outputTokens
    let windowOutputEvent = { at: this.now(), inputTokens: 0, outputTokens }
    this.usage.windowEvents.push(windowOutputEvent)
    for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', outputTokens)
    response.usage = this._responseUsage(inputTokens, outputTokens, outputRunIds, true)
    response.usage.truncated = Boolean(response.ok && response.data && (response.data.truncated === true || (response.data.usage && response.data.usage.truncated === true)))
    if (JSON.stringify(response).length > this.budgets.maxOutputCharsPerCall) {
      this.usage.sessionOutputTokens -= outputTokens
      this.usage.windowOutputTokens -= outputTokens
      this.usage.processOutputTokens -= outputTokens
      windowOutputEvent.outputTokens = 0
      for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', -outputTokens)
      response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit; request a smaller page or detail level', true)
      outputTokens = estimateTokens(JSON.stringify(response))
      this.usage.sessionOutputTokens += outputTokens
      this.usage.windowOutputTokens += outputTokens
      this.usage.processOutputTokens += outputTokens
      windowOutputEvent = { at: this.now(), inputTokens: 0, outputTokens }
      this.usage.windowEvents.push(windowOutputEvent)
      for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', outputTokens)
      response.usage = this._responseUsage(inputTokens, outputTokens, outputRunIds, true)
    }
    return response
  }

  _addRunUsage (runId, key, amount) {
    const usage = this.runUsage.get(runId) || { inputTokens: 0, outputTokens: 0 }
    usage[key] = Math.max(0, usage[key] + amount)
    this.runUsage.set(runId, usage)
  }

  _estimateOutputTokens (response, inputTokens, runIds) {
    let estimate = estimateTokens(JSON.stringify(response))
    for (let iteration = 0; iteration < 4; iteration++) {
      estimate = estimateTokens(JSON.stringify({ ...response, usage: this._responseUsage(inputTokens, estimate, runIds) }))
    }
    return estimate
  }

  _responseUsage (inputTokens, outputTokens, runIds = [], outputCharged = false) {
    const singleRun = runIds.length === 1 ? this.runUsage.get(runIds[0]) : null
    const outputToSubtract = outputCharged ? 0 : outputTokens
    return {
      estimated_input_tokens: inputTokens,
      estimated_output_tokens: outputTokens,
      token_counts_are_estimates: true,
      truncated: false,
      scope: 'response',
      session_tokens_remaining: Math.max(0, this.budgets.maxSessionTokens - tokenTotal(this.usage, 'session') - outputToSubtract),
      window_tokens_remaining: Math.max(0, this.budgets.maxWindowTokens - tokenTotal(this.usage, 'window') - outputToSubtract),
      process_tokens_remaining: Math.max(0, this.budgets.maxProcessTokens - tokenTotal(this.usage, 'process') - outputToSubtract),
      run_tokens_remaining: singleRun ? Math.max(0, this.budgets.maxRunTokens - tokenTotal(singleRun) - outputToSubtract) : null
    }
  }

  _resetUsageWindow () {
    const now = this.now()
    const cutoff = now - this.budgets.windowMs
    this.usage.windowEvents = this.usage.windowEvents.filter(event => event.at > cutoff)
    this.usage.windowInputTokens = this.usage.windowEvents.reduce((total, event) => total + event.inputTokens, 0)
    this.usage.windowOutputTokens = this.usage.windowEvents.reduce((total, event) => total + event.outputTokens, 0)
    this.usage.windowStartedAt = this.usage.windowEvents.length ? Math.min(...this.usage.windowEvents.map(event => event.at)) : now
  }

  _budgetFailure (requestId, code, message) {
    return envelope(requestId, false, null, { code, message, retryable: code.endsWith('budget_exceeded') }, {
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      token_counts_are_estimates: true,
      truncated: false,
      scope: 'response',
      session_tokens_remaining: Math.max(0, this.budgets.maxSessionTokens - tokenTotal(this.usage, 'session')),
      window_tokens_remaining: Math.max(0, this.budgets.maxWindowTokens - tokenTotal(this.usage, 'window')),
      process_tokens_remaining: Math.max(0, this.budgets.maxProcessTokens - tokenTotal(this.usage, 'process')),
      run_tokens_remaining: null
    })
  }

  listProfileWorkloads (input, requestId) {
    const workloadIds = Object.keys(this.workloads).sort()
    const pageSize = Math.max(1, Math.min(Number.isInteger(input.page_size) ? input.page_size : 50, 100))
    const snapshot = crypto.createHash('sha256').update(JSON.stringify(workloadIds.map(id => [id, this.workloads[id].profilers || ['clinic-flame']]))).digest('base64url')
    const cursorContext = { kind: 'list', scope: 'workloads', sessionId: this.sessionId, runId: null, resourceHash: null, snapshotId: snapshot, now: this.now() }
    const offset = input.cursor ? cursorOffset(input.cursor, { ...cursorContext, expiresAt: Number.MAX_SAFE_INTEGER }, this.cursors) : 0
    if (offset == null) return failure(requestId, 'invalid_cursor', 'cursor is invalid for this workload list')
    const pageIds = workloadIds.slice(offset, offset + pageSize)
    const items = pageIds.map(id => ({ id, profilers: this.workloads[id].profilers || ['clinic-flame'] }))
    const hasMore = offset + items.length < workloadIds.length
    return envelope(requestId, true, { items, total: workloadIds.length, has_more: hasMore, next_cursor: hasMore ? this._opaqueCursor(cursorContext, offset + items.length, Number.MAX_SAFE_INTEGER) : null })
  }

  approveProfileRun (input, requestId) {
    const approvalKey = tokenHash(input.approval_token)
    if (!input.approval_token || !this.approvals.has(approvalKey)) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    const approval = this.approvals.get(approvalKey)
    if (approval.expiresAt <= this.now() || approval.used) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    if (approval.approved) return failure(requestId, 'approval_already_resolved', 'approval token has already been approved')
    approval.approved = true
    return envelope(requestId, true, { approved: true, approval_token: input.approval_token, resource_cost_estimate: approval.resourceCostEstimate })
  }

  getApprovalDetails (approvalToken) {
    const approval = this.approvals.get(tokenHash(approvalToken))
    if (!approval || approval.expiresAt <= this.now() || approval.used) return null
    return {
      workload: approval.workload,
      profiler: approval.profiler,
      parameters: JSON.parse(approval.parameters),
      resource_cost_estimate: approval.resourceCostEstimate
    }
  }

  async startProfileRun (input, requestId, inputTokens = 0) {
    this._pruneExpired()
    const workloadId = input.workload
    const workload = this.workloads[workloadId]
    if (!workload) return failure(requestId, 'unknown_workload', `workload is not registered${workloadId ? `: ${workloadId}` : ''}`)
    const parameterErrors = validateWorkloadParameters(workload, input.parameters)
    if (parameterErrors.length) return failure(requestId, 'invalid_parameters', parameterErrors.map(error => `${error.path}: ${error.message}`).join('; '))
    const allowedProfilers = Array.isArray(workload.profilers) ? workload.profilers : ['clinic-flame']
    const profiler = input.profiler || allowedProfilers[0]
    if (!allowedProfilers.includes(profiler)) {
      return failure(requestId, 'unsupported_profiler', `profiler is not enabled for workload ${workloadId}`)
    }
    if (!this.runner || typeof this.runner.start !== 'function') return failure(requestId, 'runner_unavailable', 'profile runner is not configured', true)
    if (this.runs.size >= this.maxRuns) return failure(requestId, 'run_limit', 'profile run retention limit reached for this MCP session')
    const expensive = (workload.limits && workload.limits.wall_clock_ms > 30000) || (workload.limits && workload.limits.memory_mb > 512)
    if (expensive && !input.approval_token) {
      const token = randomToken('approval')
      const resourceCost = resourceCostEstimate(workload)
      this.approvals.set(tokenHash(token), {
        workload: workloadId,
        profiler,
        parameters: JSON.stringify(input.parameters || {}),
        manifestHash: this.manifestHash,
        resourceCostEstimate: resourceCost,
        expiresAt: this.now() + this.approvalTtlMs,
        used: false
      })
      return envelope(requestId, false, null, { code: 'approval_required', message: 'human or policy approval is required', retryable: false, approval_token: token, resource_cost_estimate: resourceCost })
    }
    if (input.approval_token) {
      const approval = this.approvals.get(tokenHash(input.approval_token))
      const resourceCost = resourceCostEstimate(workload)
      if (!approval || !approval.approved || approval.used || approval.expiresAt <= this.now() || approval.workload !== workloadId || approval.profiler !== profiler || approval.manifestHash !== this.manifestHash || approval.parameters !== JSON.stringify(input.parameters || {}) || JSON.stringify(approval.resourceCostEstimate) !== JSON.stringify(resourceCost)) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
      approval.used = true
    }
    const runId = `run_${this.now()}_${crypto.randomBytes(6).toString('hex')}`
    const capability = this._capability()
    const createdAt = this.now()
    const startPreview = envelope(requestId, true, { run_id: runId, run_capability: capability, status: 'queued', created_at: new Date(createdAt).toISOString() })
    const previewTokens = this._estimateOutputTokens(startPreview, inputTokens, [runId])
    startPreview.usage = this._responseUsage(inputTokens, previewTokens, [runId])
    const previewText = JSON.stringify(startPreview)
    if (previewText.length > this.budgets.maxOutputCharsPerCall) return this._budgetFailure(requestId, 'response_too_large', 'start response exceeds the per-call character limit')
    if (inputTokens + previewTokens > this.budgets.maxRunTokens || tokenTotal(this.usage, 'session') + previewTokens > this.budgets.maxSessionTokens || tokenTotal(this.usage, 'window') + previewTokens > this.budgets.maxWindowTokens || tokenTotal(this.usage, 'process') + previewTokens > this.budgets.maxProcessTokens) return this._budgetFailure(requestId, 'output_budget_exceeded', 'token budget is exhausted before starting the run')
    const run = {
      id: runId,
      capabilityHash: tokenHash(capability),
      sessionId: this.sessionId,
      workload: workloadId,
      profiler,
      command: commandMetadata(workload),
      parameters: parameterMetadata(input.parameters),
      status: 'queued',
      createdAt,
      expiresAt: createdAt + this.ttlMs
    }
    this.runs.set(runId, run)
    try {
      const result = await this.runner.start({ ...input, workload: workloadId, profiler, runId, strict: this.strictIsolation, isolationProvider: this.isolationProvider, retentionMs: this.ttlMs })
      run.status = result && result.status ? result.status : 'running'
      run.runnerId = result && (result.runnerId || result.runId)
      if (result && result.error) run.error = result.error
      this._mergeRunnerStatus(run, result)
    } catch (err) {
      if (err.code === 'RUN_LIMIT') {
        this.runs.delete(runId)
        return failure(requestId, 'run_limit', err.message)
      }
      run.status = 'failed'
      run.error = { code: 'runner_failed', message: err.message, retryable: true }
    }
    return envelope(requestId, true, { run_id: runId, run_capability: capability, status: run.status, created_at: new Date(run.createdAt).toISOString() })
  }

  async getProfileStatus (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const run = found.run
    if (this.runner && typeof this.runner.status === 'function') {
      const status = await this.runner.status(run.runnerId || run.id)
      if (status) {
        this._mergeRunnerStatus(run, status)
      }
    }
    if (['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)) {
      const report = this.reports.get(run.id) || (run.status === 'completed' ? null : terminalErrorReport(run))
      if (report) {
        report.run.command = report.run.command || run.command
        report.run.parameters = report.run.parameters || run.parameters
        this._storeReport(run.id, report)
        return envelope(requestId, true, this._exposeReport(run, report))
      }
      if (run.error) return failure(requestId, run.error.code || 'profile_failed', run.error.message || 'profile run failed', run.error.retryable === true)
      return failure(requestId, 'report_unavailable', 'terminal run report is unavailable', true)
    }
    return envelope(requestId, true, { run_id: run.id, run_capability: input.run_capability, status: run.status, phase: run.phase, created_at: new Date(run.createdAt).toISOString(), started_at: run.startedAt ? new Date(run.startedAt).toISOString() : undefined, progress_pct: run.progress_pct })
  }

  async waitProfileRun (input, requestId) {
    const timeoutMs = input.timeout_ms == null ? 30000 : input.timeout_ms
    const pollIntervalMs = input.poll_interval_ms == null ? 250 : input.poll_interval_ms
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) return failure(requestId, 'invalid_timeout', 'timeout_ms must be an integer from 100 to 30000')
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 1000) return failure(requestId, 'invalid_poll_interval', 'poll_interval_ms must be an integer from 50 to 1000')
    const auth = { run_id: input.run_id, run_capability: input.run_capability }
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    while (true) {
      const response = await this.getProfileStatus(auth, requestId)
      if (!response.ok || isTerminalProfileResponse(response)) return response
      const now = Date.now()
      if (now >= deadline) {
        return envelope(requestId, true, {
          ...response.data,
          wait_timed_out: true,
          elapsed_ms: now - startedAt,
          next_poll_after_ms: pollIntervalMs
        })
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, deadline - now)))
    }
  }

  async getProfileFindings (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const report = this.reports.get(found.run.id)
    if (!report || report.findings == null) return failure(requestId, 'analysis_unavailable', 'analysis is unavailable for this run')
    if (input.detail_level && !['summary', 'findings'].includes(input.detail_level)) return failure(requestId, 'unsupported_detail_level', 'request call trees or source context with get_finding_detail')
    if (input.detail_level === 'summary') {
      const severityCounts = { high: 0, medium: 0, low: 0 }
      for (const finding of report.findings) if (Object.prototype.hasOwnProperty.call(severityCounts, finding.severity)) severityCounts[finding.severity]++
      return envelope(requestId, true, {
        run_id: found.run.id,
        classification: diagnosticClassification(report),
        snapshot_id: snapshotId(report),
        expires_at: new Date(found.run.expiresAt).toISOString(),
        total_findings: report.findings.length,
        severity_counts: severityCounts
      })
    }
    const severity = { low: 0, medium: 1, high: 2 }
    const min = severity[input.min_severity || 'low']
    if (min == null) return failure(requestId, 'invalid_severity', 'min_severity must be low, medium, or high')
    const currentSnapshot = snapshotId(report)
    const sortBy = input.sort_by || 'impact'
    const sortDirection = input.sort_direction || 'desc'
    if (!['impact', 'severity'].includes(sortBy)) return failure(requestId, 'invalid_sort', 'sort_by must be impact or severity')
    if (!['asc', 'desc'].includes(sortDirection)) return failure(requestId, 'invalid_sort', 'sort_direction must be asc or desc')
    const sort = `${sortBy}_${sortDirection}`
    const cursorContext = { sessionId: this.sessionId, runId: found.run.id, snapshotId: currentSnapshot, sort, severity: input.min_severity || 'low', runExpiresAt: found.run.expiresAt, now: this.now() }
    const cursor = input.cursor ? decodeFindingCursor(input.cursor, cursorContext, this.cursors) : 0
    if (cursor == null) return failure(requestId, 'invalid_cursor', 'cursor is invalid for this run or severity filter')
    const multiplier = sortDirection === 'asc' ? 1 : -1
    const ranked = report.findings
      .filter(f => severity[f.severity] >= min)
      .sort((a, b) => {
        const primary = sortBy === 'severity'
          ? (severity[a.severity] - severity[b.severity]) * multiplier
          : (findingImpact(a) - findingImpact(b)) * multiplier
        return primary || compareFindingTieBreakers(a, b)
      })
    const start = cursor
    const pageSize = Math.max(1, Math.min(Number.isInteger(input.page_size) ? input.page_size : 10, this.pageLimit))
    const responseBudget = Math.min(Number.isInteger(input.max_output_chars) ? input.max_output_chars : 8000, this.budgets.maxOutputCharsPerCall)
    const maxChars = Math.max(256, responseBudget - 256)
    const base = { run_id: found.run.id, snapshot_id: currentSnapshot, sort, expires_at: new Date(found.run.expiresAt).toISOString() }
    const items = []
    let index = start
    let itemTruncated = false
    while (index < ranked.length && items.length < pageSize) {
      let finding = ranked[index]
      const original = finding
      const nextIndex = index + 1
      const hasMore = nextIndex < ranked.length
      let candidate = [...items, finding]
      let data = { ...base, items: candidate, next_cursor: hasMore ? this._findingCursor(cursorContext, nextIndex) : null, has_more: hasMore, truncated: itemTruncated, low_information: false }
      if (JSON.stringify(data).length > maxChars) {
        finding = compactFinding(original)
        candidate = [...items, finding]
        data = { ...base, items: candidate, next_cursor: hasMore ? this._findingCursor(cursorContext, nextIndex) : null, has_more: hasMore, truncated: true, low_information: false }
        if (JSON.stringify(data).length > maxChars) break
        itemTruncated = true
      }
      items.push(finding)
      index++
    }
    const hasMore = index < ranked.length
    const nextPage = ranked.slice(index, index + pageSize)
    const data = {
      ...base,
      classification: diagnosticClassification(report),
      items,
      next_cursor: hasMore ? this._findingCursor(cursorContext, index) : null,
      has_more: hasMore,
      truncated: itemTruncated,
      low_information: hasMore && !nextPage.some(finding => findingInformationScore(finding) >= this.minFindingInformationScore)
    }
    return envelope(requestId, true, data)
  }

  _findingCursor (context, offset) {
    const token = randomToken('cursor')
    const expiresAt = Math.min(context.runExpiresAt, context.now + this.cursorTtlMs)
    this.cursors.set(tokenHash(token), { ...context, offset, expiresAt })
    while (this.cursors.size > this.maxCursors) this.cursors.delete(this.cursors.keys().next().value)
    return token
  }

  _opaqueCursor (context, offset, expiresAt) {
    const token = randomToken('cursor')
    this.cursors.set(tokenHash(token), { ...context, offset, expiresAt: Math.min(expiresAt, context.now + this.cursorTtlMs) })
    while (this.cursors.size > this.maxCursors) this.cursors.delete(this.cursors.keys().next().value)
    return token
  }

  async compareProfileRuns (input, requestId) {
    const candidate = this._getRun({ run_id: input.candidate_run_id, run_capability: input.candidate_run_capability }, requestId)
    if (candidate.error) return candidate.error
    const baseline = this._getRun({ run_id: input.baseline_run_id, run_capability: input.baseline_run_capability }, requestId)
    if (baseline.error) return baseline.error
    const candidateReport = this.reports.get(candidate.run.id)
    const baselineReport = this.reports.get(baseline.run.id)
    if (!candidateReport || !baselineReport) return failure(requestId, 'report_unavailable', 'both reports must be available')
    const comparisonErrors = validateComparison(candidateReport, baselineReport)
    const classification = [diagnosticClassification(candidateReport), diagnosticClassification(baselineReport)]
      .sort((a, b) => ({ 'public-diagnostic': 0, 'sensitive-diagnostic': 1, restricted: 2 }[b] - { 'public-diagnostic': 0, 'sensitive-diagnostic': 1, restricted: 2 }[a]))[0]
    if (comparisonErrors.length) {
      return envelope(requestId, true, {
        compatibility: 'incompatible',
        candidate_run_id: candidate.run.id,
        baseline_run_id: baseline.run.id,
        reasons: comparisonErrors.slice(0, 20).map(error => error.code),
        classification
      })
    }
    if (this.analyzer && typeof this.analyzer.compare === 'function') {
      const comparison = await this.analyzer.compare(candidateReport, baselineReport)
      return envelope(requestId, true, { ...comparison, classification })
    }
    return envelope(requestId, true, { compatibility: 'incompatible', baseline_run_id: baseline.run.id, classification })
  }

  async getFindingDetail (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const report = this.reports.get(found.run.id)
    const finding = report && (report.findings || []).find(item => item.id === input.finding_id)
    if (!finding) return failure(requestId, 'not_found', 'finding not found')
    if (this.analyzer && typeof this.analyzer.detail === 'function') {
      const detail = await this.analyzer.detail(report, finding, input)
      detail.classification = diagnosticClassification(report)
      pruneFindingDetail(detail, Math.floor(this.budgets.maxOutputCharsPerCall * 0.75))
      return envelope(requestId, true, detail)
    }
    return envelope(requestId, true, { finding, classification: diagnosticClassification(report) })
  }

  async getProfileArtifact (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const run = found.run
    if (this.runner && typeof this.runner.status === 'function') {
      const status = await this.runner.status(run.runnerId || run.id)
      if (status) {
        this._mergeRunnerStatus(run, status)
      }
    }
    if (!isTerminalProfileResponse({ data: { status: run.status } })) return failure(requestId, 'artifact_not_ready', 'profile artifacts are available after the run completes', true)
    const reference = this.artifactReferences.get(tokenHash(input.artifact_ref))
    if (!reference || reference.runId !== run.id || reference.sessionId !== this.sessionId || reference.expiresAt <= this.now()) return failure(requestId, 'not_found', 'artifact not found')
    const classification = reference.classification || 'sensitive-diagnostic'
    const artifactPath = input.path
    if (artifactPath == null) {
      const pageSize = input.page_size == null ? 20 : input.page_size
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return failure(requestId, 'invalid_range', 'page_size must be between 1 and 50')
      const files = [...reference.files].sort(([a], [b]) => a.localeCompare(b))
      const snapshot = crypto.createHash('sha256').update(JSON.stringify(files.map(([filePath, entry]) => [filePath, entry.size, entry.hash]))).digest('base64url')
      const cursorContext = { kind: 'list', scope: 'artifacts', sessionId: this.sessionId, runId: run.id, resourceHash: tokenHash(input.artifact_ref), snapshotId: snapshot, now: this.now() }
      const offset = input.cursor ? cursorOffset(input.cursor, { ...cursorContext, expiresAt: reference.expiresAt }, this.cursors) : 0
      if (offset == null) return failure(requestId, 'invalid_cursor', 'cursor is invalid for this artifact listing')
      const page = files.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      const hasMore = nextOffset < files.length
      return envelope(requestId, true, {
        run_id: run.id,
        artifact_ref: input.artifact_ref,
        classification,
        files: page.map(([filePath, entry]) => ({ path: filePath, size: entry.size, sha256: entry.hash || null })),
        total: files.length,
        has_more: hasMore,
        next_cursor: hasMore ? this._opaqueCursor(cursorContext, nextOffset, reference.expiresAt) : null
      })
    }
    const segments = safeArtifactPath(artifactPath)
    if (!segments) return failure(requestId, 'not_found', 'artifact not found')
    const file = reference.files.get(artifactPath)
    if (!file) return failure(requestId, 'not_found', 'artifact not found')
    const offset = input.offset == null ? 0 : input.offset
    const maxBytes = input.max_bytes == null ? 6000 : input.max_bytes
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8000) return failure(requestId, 'invalid_range', 'offset must be non-negative and max_bytes must be between 1 and 8000')
    if (!this.artifactRoot) return failure(requestId, 'artifact_unavailable', 'artifact storage is not configured')
    const opened = safeArtifactFile(this.artifactRoot, run.id, segments)
    if (!opened || opened.size !== file.size || offset > opened.size || (file.verifiedIdentity && opened.identity !== file.verifiedIdentity)) {
      if (opened) fs.closeSync(opened.descriptor)
      return failure(requestId, 'not_found', 'artifact not found')
    }
    try {
      if (!file.verifiedIdentity) {
        const digest = await hashArtifactDescriptor(opened.descriptor)
        const afterIdentity = artifactFileIdentity(fs.fstatSync(opened.descriptor, { bigint: true }))
        if (afterIdentity !== opened.identity || digest !== file.hash) return failure(requestId, 'not_found', 'artifact not found')
        file.verifiedIdentity = opened.identity
      }
      const length = Math.min(maxBytes, opened.size - offset)
      const buffer = Buffer.alloc(length)
      const bytesRead = length ? fs.readSync(opened.descriptor, buffer, 0, length, offset) : 0
      const nextOffset = offset + bytesRead
      return envelope(requestId, true, {
        run_id: run.id,
        classification,
        path: artifactPath,
        encoding: 'base64',
        data: buffer.subarray(0, bytesRead).toString('base64'),
        file_size: opened.size,
        offset,
        next_offset: nextOffset < opened.size ? nextOffset : null,
        complete: nextOffset >= opened.size,
        expected_sha256: file.hash || null
      })
    } catch {
      return failure(requestId, 'not_found', 'artifact not found')
    } finally {
      try { fs.closeSync(opened.descriptor) } catch {}
    }
  }

  async cancelProfileRun (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const run = found.run
    if (['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)) {
      return envelope(requestId, true, { run_id: run.id, status: run.status, error: run.error || undefined })
    }
    if (!this.runner || typeof this.runner.cancel !== 'function') {
      return failure(requestId, 'cancellation_unavailable', 'profile runner does not support cancellation', false)
    }
    const status = await this.runner.cancel(run.runnerId || run.id)
    if (!status || !['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(status.status)) {
      if (status) this._mergeRunnerStatus(run, status)
      return failure(requestId, 'cancellation_unconfirmed', 'profile runner did not confirm that the run stopped', true)
    }
    this._mergeRunnerStatus(run, status)
    if (run.status === 'cancelled') {
      for (const [hash, reference] of this.artifactReferences) if (reference.runId === run.id) this.artifactReferences.delete(hash)
    }
    return envelope(requestId, true, { run_id: run.id, status: run.status, error: run.error || undefined })
  }
}

function compactFinding (finding) {
  return {
    id: String(finding.id || 'finding'),
    severity: finding.severity,
    category: String(finding.category || 'other').slice(0, 80),
    title: String(finding.title || 'Finding').slice(0, 120),
    observation: { metric: String((finding.observation && finding.observation.metric) || 'omitted'), values: {} },
    location: null,
    hypotheses: [],
    next_checks: [],
    confidence: 'unsupported',
    evidence: {
      adapter: String((finding.evidence && finding.evidence.adapter) || 'unknown-v1'),
      adapter_schema_version: String((finding.evidence && finding.evidence.adapter_schema_version) || '1'),
      confidence_basis: 'compacted_unavailable'
    },
    truncated: true
  }
}

module.exports = { ProfileMcpServer, envelope, failure }
