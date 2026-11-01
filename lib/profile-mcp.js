'use strict'

const crypto = require('crypto')
const { validateComparison } = require('./profile-semantic-validator')

function randomToken (prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('base64url')}`
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
  const value = cursors.get(cursor)
  if (!value || value.sessionId !== expected.sessionId || value.runId !== expected.runId || value.snapshotId !== expected.snapshotId || value.sort !== expected.sort || value.severity !== expected.severity || value.expiresAt <= expected.now || value.expiresAt > expected.runExpiresAt || !Number.isSafeInteger(value.offset) || value.offset < 0) return null
  return value.offset
}

function snapshotId (report) {
  return crypto.createHash('sha256').update(JSON.stringify(report.findings)).digest('base64url')
}

function estimateTokens (text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

class ProfileMcpServer {
  constructor (options = {}) {
    this.workloads = options.workloads || {}
    this.runner = options.runner
    this.isolationProvider = options.isolationProvider
    this.strictIsolation = options.strictIsolation !== false
    this.analyzer = options.analyzer
    this.reports = options.reports || new Map()
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
      maxProcessInputTokens: 200000,
      maxProcessOutputTokens: 200000,
      maxWindowInputTokens: 30000,
      maxWindowOutputTokens: 30000,
      windowMs: 60 * 60 * 1000,
      ...(options.budgets || {})
    }
    this.usage = { windowStartedAt: this.now(), windowInputTokens: 0, windowOutputTokens: 0, sessionInputTokens: 0, sessionOutputTokens: 0, processInputTokens: 0, processOutputTokens: 0 }
  }

  _pruneExpired () {
    const now = this.now()
    for (const [runId, run] of this.runs) {
      if (run.expiresAt <= now) {
        this.runs.delete(runId)
        this.reports.delete(runId)
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
    return run && run.sessionId === this.sessionId && run.capability === capability && run.expiresAt > this.now()
  }

  _getRun (input, requestId) {
    this._pruneExpired()
    const run = this.runs.get(input && input.run_id)
    if (!run || !this._owns(run, input.run_capability)) return { error: failure(requestId, 'not_found', 'run not found or capability is invalid') }
    return { run }
  }

  async call (tool, input = {}, requestId) {
    const requestText = JSON.stringify({ tool, input })
    const inputChars = requestText.length
    const inputTokens = estimateTokens(requestText)
    this._resetUsageWindow()
    if (inputChars > this.budgets.maxInputCharsPerCall) return this._budgetFailure(requestId, 'request_too_large', 'tool input exceeds the per-call character limit')
    if (this.usage.sessionInputTokens + inputTokens > this.budgets.maxSessionInputTokens || this.usage.windowInputTokens + inputTokens > this.budgets.maxWindowInputTokens || this.usage.processInputTokens + inputTokens > this.budgets.maxProcessInputTokens) return this._budgetFailure(requestId, 'input_budget_exceeded', 'input token budget is exhausted')
    this.usage.sessionInputTokens += inputTokens
    this.usage.windowInputTokens += inputTokens
    this.usage.processInputTokens += inputTokens
    let response
    try {
      switch (tool) {
        case 'list_profile_workloads': response = this.listProfileWorkloads(input, requestId); break
        case 'start_profile_run': response = await this.startProfileRun(input, requestId); break
        case 'approve_profile_run': response = this.approveProfileRun(input, requestId); break
        case 'get_profile_status': response = await this.getProfileStatus(input, requestId); break
        case 'get_profile_findings': response = await this.getProfileFindings(input, requestId); break
        case 'compare_profile_runs': response = await this.compareProfileRuns(input, requestId); break
        case 'get_finding_detail': response = await this.getFindingDetail(input, requestId); break
        case 'cancel_profile_run': response = await this.cancelProfileRun(input, requestId); break
        default: response = failure(requestId, 'unknown_tool', `unknown tool: ${tool}`)
      }
    } catch (err) {
      response = failure(requestId, 'internal_error', err.message || 'internal error', true)
    }
    const outputText = JSON.stringify(response.ok ? response.data : response.error)
    const outputChars = outputText.length
    const outputTokens = estimateTokens(outputText)
    if (outputChars > this.budgets.maxOutputCharsPerCall) response = failure(requestId, 'response_too_large', 'tool output exceeds the per-call character limit; request a smaller page or detail level', true)
    else if (this.usage.sessionOutputTokens + outputTokens > this.budgets.maxSessionOutputTokens || this.usage.windowOutputTokens + outputTokens > this.budgets.maxWindowOutputTokens || this.usage.processOutputTokens + outputTokens > this.budgets.maxProcessOutputTokens) response = failure(requestId, 'output_budget_exceeded', 'output token budget is exhausted', true)
    this.usage.sessionOutputTokens += outputTokens
    this.usage.windowOutputTokens += outputTokens
    this.usage.processOutputTokens += outputTokens
    response.usage = {
      estimated_input_tokens: inputTokens,
      estimated_output_tokens: outputTokens,
      token_counts_are_estimates: true,
      session_input_tokens_remaining: Math.max(0, this.budgets.maxSessionInputTokens - this.usage.sessionInputTokens),
      session_output_tokens_remaining: Math.max(0, this.budgets.maxSessionOutputTokens - this.usage.sessionOutputTokens),
      window_input_tokens_remaining: Math.max(0, this.budgets.maxWindowInputTokens - this.usage.windowInputTokens),
      window_output_tokens_remaining: Math.max(0, this.budgets.maxWindowOutputTokens - this.usage.windowOutputTokens),
      process_input_tokens_remaining: Math.max(0, this.budgets.maxProcessInputTokens - this.usage.processInputTokens),
      process_output_tokens_remaining: Math.max(0, this.budgets.maxProcessOutputTokens - this.usage.processOutputTokens)
    }
    return response
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
      session_input_tokens_remaining: Math.max(0, this.budgets.maxSessionInputTokens - this.usage.sessionInputTokens),
      session_output_tokens_remaining: Math.max(0, this.budgets.maxSessionOutputTokens - this.usage.sessionOutputTokens),
      window_input_tokens_remaining: Math.max(0, this.budgets.maxWindowInputTokens - this.usage.windowInputTokens),
      window_output_tokens_remaining: Math.max(0, this.budgets.maxWindowOutputTokens - this.usage.windowOutputTokens),
      process_input_tokens_remaining: Math.max(0, this.budgets.maxProcessInputTokens - this.usage.processInputTokens),
      process_output_tokens_remaining: Math.max(0, this.budgets.maxProcessOutputTokens - this.usage.processOutputTokens)
    })
  }

  listProfileWorkloads (input, requestId) {
    const items = Object.keys(this.workloads).sort().map(id => ({ id, profilers: this.workloads[id].profilers || ['clinic-flame'] }))
    return envelope(requestId, true, { items })
  }

  approveProfileRun (input, requestId) {
    if (!input.approval_token || !this.approvals.has(input.approval_token)) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    const approval = this.approvals.get(input.approval_token)
    if (approval.expiresAt <= this.now() || approval.used) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
    approval.approved = true
    return envelope(requestId, true, { approved: true, approval_token: input.approval_token })
  }

  async startProfileRun (input, requestId) {
    this._pruneExpired()
    // Accept both the documented `workload` field and `workloadId`, which MCP
    // clients commonly derive from the manifest's workload identifier.
    const workloadId = input.workload || input.workloadId
    const workload = this.workloads[workloadId]
    if (!workload) return failure(requestId, 'unknown_workload', `workload is not registered${workloadId ? `: ${workloadId}` : ''}`)
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
      this.approvals.set(token, {
        workload: workloadId,
        profiler,
        parameters: JSON.stringify(input.parameters || {}),
        expiresAt: this.now() + this.approvalTtlMs,
        used: false
      })
      return envelope(requestId, false, null, { code: 'approval_required', message: 'human or policy approval is required', retryable: false, approval_token: token })
    }
    if (input.approval_token) {
      const approval = this.approvals.get(input.approval_token)
      if (!approval || !approval.approved || approval.used || approval.expiresAt <= this.now() || approval.workload !== workloadId || approval.profiler !== profiler || approval.parameters !== JSON.stringify(input.parameters || {})) return failure(requestId, 'invalid_approval', 'approval token is invalid or expired')
      approval.used = true
    }
    const runId = `run_${this.now()}_${crypto.randomBytes(6).toString('hex')}`
    const capability = this._capability()
    const run = { id: runId, capability, sessionId: this.sessionId, workload: workloadId, status: 'queued', createdAt: this.now(), expiresAt: this.now() + this.ttlMs }
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
      const report = this.reports.get(run.id)
      if (report) return envelope(requestId, true, report)
      if (run.error) return failure(requestId, run.error.code || 'profile_failed', run.error.message || 'profile run failed', run.error.retryable === true)
      return failure(requestId, 'report_unavailable', 'terminal run report is unavailable', true)
    }
    return envelope(requestId, true, { run_id: run.id, status: run.status, created_at: new Date(run.createdAt).toISOString(), started_at: run.startedAt ? new Date(run.startedAt).toISOString() : undefined, progress_pct: run.progress_pct })
  }

  async getProfileFindings (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const report = this.reports.get(found.run.id)
    if (!report || report.findings == null) return failure(requestId, 'analysis_unavailable', 'analysis is unavailable for this run')
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
    this.cursors.set(token, { ...context, offset, expiresAt })
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

  async cancelProfileRun (input, requestId) {
    const found = this._getRun(input, requestId)
    if (found.error) return found.error
    const run = found.run
    if (this.runner && typeof this.runner.cancel === 'function') {
      const status = await this.runner.cancel(run.runnerId || run.id)
      if (status) Object.assign(run, status)
      else run.status = 'cancelled'
    } else run.status = 'cancelled'
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
