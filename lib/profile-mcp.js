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

function encodeFindingCursor (runId, offset, severity) {
  return Buffer.from(JSON.stringify({ runId, offset, severity })).toString('base64url')
}

function decodeFindingCursor (cursor, runId, severity) {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (value.runId !== runId || value.severity !== severity || !Number.isSafeInteger(value.offset) || value.offset < 0) return null
    return value.offset
  } catch {
    return null
  }
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
    this.now = options.now || (() => Date.now())
    this.ttlMs = options.ttlMs || 24 * 60 * 60 * 1000
    this.approvalTtlMs = options.approvalTtlMs || 10 * 60 * 1000
    this.pageLimit = options.pageLimit || 20
  }

  _capability () {
    return randomToken('cap')
  }

  _owns (run, capability) {
    return run && run.sessionId === this.sessionId && run.capability === capability && run.expiresAt > this.now()
  }

  _getRun (input, requestId) {
    const run = this.runs.get(input && input.run_id)
    if (!run || !this._owns(run, input.run_capability)) return { error: failure(requestId, 'not_found', 'run not found or capability is invalid') }
    return { run }
  }

  async call (tool, input = {}, requestId) {
    try {
      switch (tool) {
        case 'list_profile_workloads': return this.listProfileWorkloads(input, requestId)
        case 'start_profile_run': return await this.startProfileRun(input, requestId)
        case 'approve_profile_run': return this.approveProfileRun(input, requestId)
        case 'get_profile_status': return await this.getProfileStatus(input, requestId)
        case 'get_profile_findings': return await this.getProfileFindings(input, requestId)
        case 'compare_profile_runs': return await this.compareProfileRuns(input, requestId)
        case 'get_finding_detail': return await this.getFindingDetail(input, requestId)
        case 'cancel_profile_run': return await this.cancelProfileRun(input, requestId)
        default: return failure(requestId, 'unknown_tool', `unknown tool: ${tool}`)
      }
    } catch (err) {
      return failure(requestId, 'internal_error', err.message || 'internal error', true)
    }
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
      if (result && result.report) this.reports.set(run.id, result.report)
    } catch (err) {
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
      if (status) Object.assign(run, status)
    }
    if (['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)) {
      const report = this.reports.get(run.id)
      if (report) return envelope(requestId, true, report)
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
    const cursor = input.cursor ? decodeFindingCursor(input.cursor, found.run.id, input.min_severity || 'low') : 0
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
    const base = { run_id: found.run.id, snapshot_id: report.run && report.run.id, sort: 'impact_desc', expires_at: new Date(found.run.expiresAt).toISOString() }
    const items = []
    let index = start
    while (index < ranked.length && items.length < pageSize) {
      const candidate = [...items, ranked[index]]
      const nextIndex = index + 1
      const hasMore = nextIndex < ranked.length
      const data = { ...base, items: candidate, next_cursor: hasMore ? encodeFindingCursor(found.run.id, nextIndex, input.min_severity || 'low') : null, has_more: hasMore, truncated: false, low_information: candidate.length === 0 }
      if (JSON.stringify(data).length > maxChars) break
      items.push(ranked[index++])
    }
    const hasMore = index < ranked.length
    const data = {
      ...base,
      items,
      next_cursor: hasMore ? encodeFindingCursor(found.run.id, index, input.min_severity || 'low') : null,
      has_more: hasMore,
      truncated: hasMore,
      low_information: items.length === 0
    }
    return envelope(requestId, true, data)
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
    if (this.runner && typeof this.runner.cancel === 'function') await this.runner.cancel(run.runnerId || run.id)
    run.status = 'cancelled'
    return envelope(requestId, true, { run_id: run.id, status: run.status })
  }
}

module.exports = { ProfileMcpServer, envelope, failure }
