'use strict'

const crypto = require('crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateComparison, validateWorkloadParameters } = require('./profile-semantic-validator')

function randomToken (prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('base64url')}`
}

function tokenHash (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
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
    return { descriptor, size: opened.size }
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

function snapshotId (report) {
  return crypto.createHash('sha256').update(JSON.stringify(report.findings)).digest('base64url')
}

function estimateTokens (text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
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
      node: `node-${process.version}`,
      architecture: `${process.platform}-${process.arch}`,
      status: run.status,
      lifecycle: {
        created_at: new Date(run.createdAt).toISOString(),
        finished_at: finishedAt
      },
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
    artifacts: null,
    usage: null
  }
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
    this.strictIsolation = options.strictIsolation !== false
    this.analyzer = options.analyzer
    this.reports = options.reports || new Map()
    this.artifactReferences = new Map()
    this.maxArtifactReferences = options.maxArtifactReferences || options.maxRuns || 100
    this.runs = new Map()
    this.approvals = new Map()
    this.sessionId = options.sessionId || randomToken('session')
    this.cursors = new Map()
    this.now = options.now || (() => Date.now())
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000
    this.cursorTtlMs = options.cursorTtlMs || 15 * 60 * 1000
    this.approvalTtlMs = options.approvalTtlMs || 10 * 60 * 1000
    this.pageLimit = options.pageLimit || 20
    this.maxRuns = options.maxRuns || 100
    this.maxCursors = options.maxCursors || 1000
    this.budgets = {
      maxInputCharsPerCall: 20000,
      maxOutputCharsPerCall: 20000,
      maxSessionInputTokens: 100000,
      maxSessionOutputTokens: 100000,
      maxRunInputTokens: 30000,
      maxRunOutputTokens: 30000,
      maxProcessInputTokens: 200000,
      maxProcessOutputTokens: 200000,
      maxWindowInputTokens: 30000,
      maxWindowOutputTokens: 30000,
      windowMs: 60 * 60 * 1000,
      ...(options.budgets || {})
    }
    this.usage = { windowStartedAt: this.now(), windowInputTokens: 0, windowOutputTokens: 0, sessionInputTokens: 0, sessionOutputTokens: 0, processInputTokens: 0, processOutputTokens: 0 }
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
    if (runIds.some(runId => (this.runUsage.get(runId)?.inputTokens || 0) + inputTokens > this.budgets.maxRunInputTokens)) return this._budgetFailure(requestId, 'run_budget_exceeded', 'run input token budget is exhausted')
    if (this.usage.sessionInputTokens + inputTokens > this.budgets.maxSessionInputTokens || this.usage.windowInputTokens + inputTokens > this.budgets.maxWindowInputTokens || this.usage.processInputTokens + inputTokens > this.budgets.maxProcessInputTokens) return this._budgetFailure(requestId, 'input_budget_exceeded', 'input token budget is exhausted')
    if (runIds.some(runId => (this.runUsage.get(runId)?.outputTokens || 0) >= this.budgets.maxRunOutputTokens)) return this._budgetFailure(requestId, 'run_budget_exceeded', 'run output token budget is exhausted')
    if (this.usage.sessionOutputTokens >= this.budgets.maxSessionOutputTokens || this.usage.windowOutputTokens >= this.budgets.maxWindowOutputTokens || this.usage.processOutputTokens >= this.budgets.maxProcessOutputTokens) return this._budgetFailure(requestId, 'output_budget_exceeded', 'output token budget is exhausted')
    this.usage.sessionInputTokens += inputTokens
    this.usage.windowInputTokens += inputTokens
    this.usage.processInputTokens += inputTokens
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
    const outputRunIds = [...new Set([...runIds, ...(response.ok && response.data && typeof response.data.run_id === 'string' ? [response.data.run_id] : [])])]
    let projectedOutputTokens = this._estimateOutputTokens(response, inputTokens, outputRunIds)
    let outputProjection = { ...response, usage: this._responseUsage(inputTokens, projectedOutputTokens, outputRunIds) }
    let outputText = JSON.stringify(outputProjection)
    let outputChars = outputText.length
    for (const runId of outputRunIds) if (!runIds.includes(runId)) this._addRunUsage(runId, 'inputTokens', inputTokens)
    if (outputChars > this.budgets.maxOutputCharsPerCall) response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit; request a smaller page or detail level', true)
    else if (outputRunIds.some(runId => (this.runUsage.get(runId)?.outputTokens || 0) + projectedOutputTokens > this.budgets.maxRunOutputTokens)) response = failure(requestId, 'run_budget_exceeded', 'run output token budget is exhausted', true)
    else if (this.usage.sessionOutputTokens + projectedOutputTokens > this.budgets.maxSessionOutputTokens || this.usage.windowOutputTokens + projectedOutputTokens > this.budgets.maxWindowOutputTokens || this.usage.processOutputTokens + projectedOutputTokens > this.budgets.maxProcessOutputTokens) response = failure(requestId, 'output_budget_exceeded', 'output token budget is exhausted', true)
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
    for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', outputTokens)
    response.usage = this._responseUsage(inputTokens, outputTokens, outputRunIds)
    if (JSON.stringify(response).length > this.budgets.maxOutputCharsPerCall) {
      this.usage.sessionOutputTokens -= outputTokens
      this.usage.windowOutputTokens -= outputTokens
      this.usage.processOutputTokens -= outputTokens
      for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', -outputTokens)
      response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit; request a smaller page or detail level', true)
      outputTokens = estimateTokens(JSON.stringify(response))
      this.usage.sessionOutputTokens += outputTokens
      this.usage.windowOutputTokens += outputTokens
      this.usage.processOutputTokens += outputTokens
      for (const runId of outputRunIds) this._addRunUsage(runId, 'outputTokens', outputTokens)
      response.usage = this._responseUsage(inputTokens, outputTokens, outputRunIds)
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

  _responseUsage (inputTokens, outputTokens, runIds = []) {
    const singleRun = runIds.length === 1 ? this.runUsage.get(runIds[0]) : null
    return {
      estimated_input_tokens: inputTokens,
      estimated_output_tokens: outputTokens,
      token_counts_are_estimates: true,
      truncated: false,
      scope: 'response',
      session_input_tokens_remaining: Math.max(0, this.budgets.maxSessionInputTokens - this.usage.sessionInputTokens),
      session_output_tokens_remaining: Math.max(0, this.budgets.maxSessionOutputTokens - this.usage.sessionOutputTokens),
      window_input_tokens_remaining: Math.max(0, this.budgets.maxWindowInputTokens - this.usage.windowInputTokens),
      window_output_tokens_remaining: Math.max(0, this.budgets.maxWindowOutputTokens - this.usage.windowOutputTokens),
      process_input_tokens_remaining: Math.max(0, this.budgets.maxProcessInputTokens - this.usage.processInputTokens),
      process_output_tokens_remaining: Math.max(0, this.budgets.maxProcessOutputTokens - this.usage.processOutputTokens),
      run_input_tokens_remaining: singleRun ? Math.max(0, this.budgets.maxRunInputTokens - singleRun.inputTokens) : null,
      run_output_tokens_remaining: singleRun ? Math.max(0, this.budgets.maxRunOutputTokens - singleRun.outputTokens) : null
    }
  }

  _resetUsageWindow () {
    const now = this.now()
    if (now - this.usage.windowStartedAt >= this.budgets.windowMs) {
      this.usage.windowStartedAt = now
      this.usage.windowInputTokens = 0
      this.usage.windowOutputTokens = 0
    }
  }

  _budgetFailure (requestId, code, message) {
    return envelope(requestId, false, null, { code, message, retryable: code.endsWith('budget_exceeded') }, {
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      token_counts_are_estimates: true,
      truncated: false,
      scope: 'response',
      session_input_tokens_remaining: Math.max(0, this.budgets.maxSessionInputTokens - this.usage.sessionInputTokens),
      session_output_tokens_remaining: Math.max(0, this.budgets.maxSessionOutputTokens - this.usage.sessionOutputTokens),
      window_input_tokens_remaining: Math.max(0, this.budgets.maxWindowInputTokens - this.usage.windowInputTokens),
      window_output_tokens_remaining: Math.max(0, this.budgets.maxWindowOutputTokens - this.usage.windowOutputTokens),
      process_input_tokens_remaining: Math.max(0, this.budgets.maxProcessInputTokens - this.usage.processInputTokens),
      process_output_tokens_remaining: Math.max(0, this.budgets.maxProcessOutputTokens - this.usage.processOutputTokens),
      run_input_tokens_remaining: null,
      run_output_tokens_remaining: null
    })
  }

  listProfileWorkloads (input, requestId) {
    const workloadIds = Object.keys(this.workloads).sort()
    const pageSize = Math.max(1, Math.min(Number.isInteger(input.page_size) ? input.page_size : 50, 100))
    const offset = Math.max(0, Math.min(Number.isInteger(input.offset) ? input.offset : 0, workloadIds.length))
    const pageIds = workloadIds.slice(offset, offset + pageSize)
    const items = pageIds.map(id => ({ id, profilers: this.workloads[id].profilers || ['clinic-flame'] }))
    const hasMore = offset + items.length < workloadIds.length
    return envelope(requestId, true, { items, total: workloadIds.length, has_more: hasMore, next_offset: hasMore ? offset + items.length : null })
  }

  approveProfileRun (input, requestId) {
    const approvalKey = tokenHash(input.approval_token)
    if (!input.approval_token || !this.approvals.has(approvalKey)) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    const approval = this.approvals.get(approvalKey)
    if (approval.expiresAt <= this.now() || approval.used) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    approval.approved = true
    return envelope(requestId, true, { approved: true, approval_token: input.approval_token })
  }

  async startProfileRun (input, requestId, inputTokens = 0) {
    this._pruneExpired()
    // Accept both the documented `workload` field and `workloadId`, which MCP
    // clients commonly derive from the manifest's workload identifier.
    const workloadId = input.workload || input.workloadId
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
      this.approvals.set(tokenHash(token), {
        workload: workloadId,
        profiler,
        parameters: JSON.stringify(input.parameters || {}),
        manifestHash: this.manifestHash,
        expiresAt: this.now() + this.approvalTtlMs,
        used: false
      })
      return envelope(requestId, false, null, { code: 'approval_required', message: 'human or policy approval is required', retryable: false, approval_token: token })
    }
    if (input.approval_token) {
      const approval = this.approvals.get(tokenHash(input.approval_token))
      if (!approval || !approval.approved || approval.used || approval.expiresAt <= this.now() || approval.workload !== workloadId || approval.profiler !== profiler || approval.manifestHash !== this.manifestHash || approval.parameters !== JSON.stringify(input.parameters || {})) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
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
    if (previewTokens > this.budgets.maxRunOutputTokens || this.usage.sessionOutputTokens + previewTokens > this.budgets.maxSessionOutputTokens || this.usage.windowOutputTokens + previewTokens > this.budgets.maxWindowOutputTokens || this.usage.processOutputTokens + previewTokens > this.budgets.maxProcessOutputTokens) return this._budgetFailure(requestId, 'output_budget_exceeded', 'output token budget is exhausted before starting the run')
    const run = { id: runId, capabilityHash: tokenHash(capability), sessionId: this.sessionId, workload: workloadId, profiler, status: 'queued', createdAt, expiresAt: createdAt + this.ttlMs }
    this.runs.set(runId, run)
    try {
      const result = await this.runner.start({ ...input, workload: workloadId, profiler, runId, strict: this.strictIsolation, isolationProvider: this.isolationProvider })
      run.status = result && result.status ? result.status : 'running'
      run.runnerId = result && (result.runnerId || result.runId)
      if (result && result.error) run.error = result.error
      if (result && result.report) this.reports.set(run.id, result.report)
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
        Object.assign(run, status)
        if (status.report) this.reports.set(run.id, status.report)
      }
    }
    if (['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)) {
      const report = this.reports.get(run.id) || (run.status === 'completed' ? null : terminalErrorReport(run))
      if (report) return envelope(requestId, true, report)
      if (run.error) return failure(requestId, run.error.code || 'profile_failed', run.error.message || 'profile run failed', run.error.retryable === true)
      return failure(requestId, 'report_unavailable', 'terminal run report is unavailable', true)
    }
    return envelope(requestId, true, { run_id: run.id, status: run.status, created_at: new Date(run.createdAt).toISOString(), started_at: run.startedAt ? new Date(run.startedAt).toISOString() : undefined, progress_pct: run.progress_pct })
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
    const sort = 'severity_impact_desc'
    const cursorContext = { sessionId: this.sessionId, runId: found.run.id, snapshotId: currentSnapshot, sort, severity: input.min_severity || 'low', runExpiresAt: found.run.expiresAt, now: this.now() }
    const cursor = input.cursor ? decodeFindingCursor(input.cursor, cursorContext, this.cursors) : 0
    if (cursor == null) return failure(requestId, 'invalid_cursor', 'cursor is invalid for this run or severity filter')
    const impact = finding => {
      const values = finding.observation && finding.observation.values
      const direct = finding.observation || {}
      return Number((values && (values.total_time_pct ?? values.share_pct ?? values.max_duration_ms ?? values.self_retained_bytes)) ?? direct.total_time_pct ?? direct.self_time_pct ?? 0) || 0
    }
    const ranked = report.findings
      .filter(f => severity[f.severity] >= min)
      .sort((a, b) => severity[b.severity] - severity[a.severity] || impact(b) - impact(a) || a.id.localeCompare(b.id))
    const start = cursor
    const pageSize = Math.max(1, Math.min(Number.isInteger(input.page_size) ? input.page_size : 10, this.pageLimit))
    const maxChars = Math.max(1024, Math.min(Number.isInteger(input.max_output_chars) ? input.max_output_chars : 8000, 20000))
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
    const data = {
      ...base,
      items,
      next_cursor: hasMore ? this._findingCursor(cursorContext, index) : null,
      has_more: hasMore,
      truncated: hasMore || itemTruncated,
      low_information: items.length === 0
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

  async compareProfileRuns (input, requestId) {
    const candidate = this._getRun({ run_id: input.candidate_run_id, run_capability: input.candidate_run_capability }, requestId)
    if (candidate.error) return candidate.error
    const baseline = this._getRun({ run_id: input.baseline_run_id, run_capability: input.baseline_run_capability }, requestId)
    if (baseline.error) return baseline.error
    const candidateReport = this.reports.get(candidate.run.id)
    const baselineReport = this.reports.get(baseline.run.id)
    if (!candidateReport || !baselineReport) return failure(requestId, 'report_unavailable', 'both reports must be available')
    const comparisonErrors = validateComparison(candidateReport, baselineReport)
    if (comparisonErrors.length) return failure(requestId, 'incompatible_baseline', comparisonErrors.map(error => error.message).join('; '))
    if (this.analyzer && typeof this.analyzer.compare === 'function') return envelope(requestId, true, await this.analyzer.compare(candidateReport, baselineReport))
    return envelope(requestId, true, { compatibility: 'incompatible', baseline_run_id: baseline.run.id })
  }

  async getFindingDetail (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const report = this.reports.get(found.run.id)
    const finding = report && (report.findings || []).find(item => item.id === input.finding_id)
    if (!finding) return failure(requestId, 'not_found', 'finding not found')
    if (this.analyzer && typeof this.analyzer.detail === 'function') return envelope(requestId, true, await this.analyzer.detail(report, finding, input))
    return envelope(requestId, true, { finding })
  }

  _registerArtifactReference (run) {
    const ref = run && run.artifactRef
    const files = run && run.artifact && run.artifact.files
    if (!this.artifactRoot || !run || run.status !== 'completed' || !Array.isArray(files) || typeof ref !== 'string' || !/^artifact_[A-Za-z0-9_-]{22}$/.test(ref)) return false
    const report = this.reports.get(run.id)
    if (!(report && (report.artifacts || []).some(artifact => artifact && artifact.kind === 'clinic' && tokenHash(artifact.ref) === tokenHash(ref)))) return false
    const key = tokenHash(ref)
    const existing = this.artifactReferences.get(key)
    if (existing && existing.runId === run.id && existing.sessionId === this.sessionId && existing.expiresAt > this.now()) return true
    const fileMap = new Map()
    for (const entry of files) {
      if (!entry || !safeArtifactPath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) continue
      fileMap.set(entry.path, { size: entry.size, hash: entry.hash })
    }
    if (fileMap.size === 0) return false
    this.artifactReferences.set(key, {
      runId: run.id,
      sessionId: this.sessionId,
      expiresAt: Math.min(run.expiresAt, run.createdAt + 24 * 60 * 60 * 1000),
      files: fileMap
    })
    while (this.artifactReferences.size > this.maxArtifactReferences) this.artifactReferences.delete(this.artifactReferences.keys().next().value)
    return true
  }

  async getProfileArtifact (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const run = found.run
    if (this.runner && typeof this.runner.status === 'function') {
      const status = await this.runner.status(run.runnerId || run.id)
      if (status) {
        Object.assign(run, status)
        if (status.report) this.reports.set(run.id, status.report)
      }
    }
    if (!isTerminalProfileResponse({ data: { status: run.status } })) return failure(requestId, 'artifact_not_ready', 'profile artifacts are available after the run completes', true)
    this._registerArtifactReference(run)
    const reference = this.artifactReferences.get(tokenHash(input.artifact_ref))
    if (!reference || reference.runId !== run.id || reference.sessionId !== this.sessionId || reference.expiresAt <= this.now()) return failure(requestId, 'not_found', 'artifact not found')
    const artifactPath = input.path
    if (artifactPath == null) {
      const offset = input.offset == null ? 0 : input.offset
      const pageSize = input.page_size == null ? 20 : input.page_size
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return failure(requestId, 'invalid_range', 'offset must be non-negative and page_size must be between 1 and 50')
      const files = [...reference.files].sort(([a], [b]) => a.localeCompare(b))
      const page = files.slice(offset, offset + pageSize)
      const nextOffset = offset + page.length
      const hasMore = nextOffset < files.length
      return envelope(requestId, true, {
        run_id: run.id,
        artifact_ref: input.artifact_ref,
        files: page.map(([filePath, entry]) => ({ path: filePath, size: entry.size, sha256: entry.hash || null })),
        total: files.length,
        has_more: hasMore,
        next_offset: hasMore ? nextOffset : null
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
    if (!opened || opened.size !== file.size || offset > opened.size) {
      if (opened) fs.closeSync(opened.descriptor)
      return failure(requestId, 'not_found', 'artifact not found')
    }
    try {
      const length = Math.min(maxBytes, opened.size - offset)
      const buffer = Buffer.alloc(length)
      const bytesRead = length ? fs.readSync(opened.descriptor, buffer, 0, length, offset) : 0
      const nextOffset = offset + bytesRead
      return envelope(requestId, true, {
        run_id: run.id,
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
      if (status) Object.assign(run, status)
      return failure(requestId, 'cancellation_unconfirmed', 'profile runner did not confirm that the run stopped', true)
    }
    Object.assign(run, status)
    if (run.status === 'cancelled') {
      for (const [hash, reference] of this.artifactReferences) if (reference.runId === run.id) this.artifactReferences.delete(hash)
    }
    return envelope(requestId, true, { run_id: run.id, status: run.status, error: run.error || undefined })
  }
}

function compactFinding (finding) {
  return {
    id: String(finding.id || '').slice(0, 80),
    severity: finding.severity,
    category: String(finding.category || '').slice(0, 80),
    title: String(finding.title || '').slice(0, 240),
    observation: { metric: String((finding.observation && finding.observation.metric) || 'omitted'), summary: 'Evidence omitted to fit the response limit; request this finding’s detail.' },
    truncated: true
  }
}

module.exports = { ProfileMcpServer, envelope, failure }
