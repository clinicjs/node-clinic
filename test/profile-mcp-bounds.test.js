'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

async function setup (t) {
  let now = 1000
  const server = new ProfileMcpServer({
    workloads: { smoke: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1, memory_mb: 1 } } },
    runner: { start: async () => ({ status: 'completed', runId: 'runner-bounds' }) },
    pageLimit: 2,
    maxCursors: 2,
    now: () => now,
    cursorTtlMs: 100
  })
  const started = await server.call('start_profile_run', { workload: 'smoke' })
  t.equal(started.ok, true)
  server.reports.set(started.data.run_id, {
    run: { id: started.data.run_id },
    findings: [
      { id: 'low-big', severity: 'low', observation: { values: { total_time_pct: 99 } } },
      { id: 'medium-small', severity: 'medium', observation: { values: { total_time_pct: 2 } } },
      { id: 'high-small', severity: 'high', observation: { values: { total_time_pct: 1 } } },
      { id: 'high-big', severity: 'high', observation: { values: { total_time_pct: 50 } } }
    ]
  })
  return { server, advanceTime: ms => { now += ms }, ...started.data }
}

test('findings default to impact sorting, and page size/output are clamped', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  const result = await server.call('get_profile_findings', {
    run_id: runId,
    run_capability: runCapability,
    page_size: 1000,
    max_output_chars: 100000
  })

  t.equal(result.ok, true)
  t.equal(result.data.classification, 'sensitive-diagnostic')
  t.equal(result.data.sort, 'impact_desc')
  t.same(result.data.items.map(item => item.id), ['low-big', 'high-big'])
  t.equal(result.data.items.length, 2)
  t.equal(result.data.has_more, true)
  t.equal(result.data.truncated, false)
  t.equal(result.usage.truncated, false)
  t.ok(JSON.stringify(result.data).length <= 20000)
  t.end()
})

test('finding sort is allowlisted and cursor-bound', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  const args = { run_id: runId, run_capability: runCapability, page_size: 1 }
  const impactPage = await server.call('get_profile_findings', args)
  t.equal(impactPage.data.sort, 'impact_desc')
  t.equal(impactPage.data.items[0].id, 'low-big')

  const wrongSort = await server.call('get_profile_findings', { ...args, cursor: impactPage.data.next_cursor, sort_by: 'severity' })
  t.equal(wrongSort.error.code, 'invalid_cursor')

  const severityPage = await server.call('get_profile_findings', { ...args, sort_by: 'severity' })
  t.equal(severityPage.data.sort, 'severity_desc')
  t.equal(severityPage.data.items[0].id, 'high-big')

  const invalidSort = await server.call('get_profile_findings', { ...args, sort_by: 'title' })
  t.equal(invalidSort.error.code, 'invalid_sort')
  t.end()
})

test('findings reject invalid severity and cursors from another run or filter', async t => {
  const { server, advanceTime, run_id: runId, run_capability: runCapability } = await setup(t)
  const args = { run_id: runId, run_capability: runCapability, page_size: 1 }
  const first = await server.call('get_profile_findings', args)
  t.equal(first.ok, true)
  t.ok(first.data.next_cursor)
  t.notOk(first.data.next_cursor.includes(runId))

  const invalidSeverity = await server.call('get_profile_findings', { ...args, min_severity: 'critical' })
  t.equal(invalidSeverity.error.code, 'invalid_severity')

  const wrongFilter = await server.call('get_profile_findings', { ...args, min_severity: 'medium', cursor: first.data.next_cursor })
  t.equal(wrongFilter.error.code, 'invalid_cursor')

  const wrongRunCursor = Buffer.from(JSON.stringify({ runId: 'another-run', offset: 1, severity: 'low' })).toString('base64url')
  const wrongRun = await server.call('get_profile_findings', { ...args, cursor: wrongRunCursor })
  t.equal(wrongRun.error.code, 'invalid_cursor')

  const malformed = await server.call('get_profile_findings', { ...args, cursor: 'not-json' })
  t.equal(malformed.error.code, 'invalid_cursor')

  advanceTime(101)
  const expired = await server.call('get_profile_findings', { ...args, cursor: first.data.next_cursor })
  t.equal(expired.error.code, 'invalid_cursor')

  server.reports.get(runId).findings[0].observation.values.total_time_pct++
  const changedSnapshot = await server.call('get_profile_findings', { ...args, cursor: first.data.next_cursor })
  t.equal(changedSnapshot.error.code, 'invalid_cursor')
  t.end()
})

test('finding cursors remain opaque and are bounded server-side', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  const args = { run_id: runId, run_capability: runCapability, page_size: 1 }
  const first = await server.call('get_profile_findings', args)
  t.ok(first.data.next_cursor)
  t.notOk(server.cursors.has(first.data.next_cursor))
  t.match([...server.cursors.keys()][0], /^[a-f0-9]{64}$/)

  await server.call('get_profile_findings', args)
  await server.call('get_profile_findings', args)
  t.equal(server.cursors.size, 2)
  t.end()
})

test('summary detail mode avoids returning findings', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  const response = await server.call('get_profile_findings', { run_id: runId, run_capability: runCapability, detail_level: 'summary' })
  t.equal(response.ok, true)
  t.equal(response.data.classification, 'sensitive-diagnostic')
  t.equal(response.data.total_findings, 4)
  t.same(response.data.severity_counts, { high: 2, medium: 1, low: 1 })
  t.notOk(Object.prototype.hasOwnProperty.call(response.data, 'items'))
  t.end()
})

test('finding detail truncates trees and source lines within the response budget', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  server.analyzer = {
    detail: async () => ({
      finding: { id: 'low-big', title: 'hot path', location: { line: 40 } },
      call_tree: {
        root: {
          name: 'hot path',
          children: Array.from({ length: 80 }, (_, index) => ({
            name: `child-${index}-${'x'.repeat(120)}`,
            children: []
          }))
        },
        truncated: false,
        node_count: 81,
        max_nodes: 500
      },
      source_context: {
        available: true,
        lines: Array.from({ length: 80 }, (_, index) => ({ line: index + 1, text: 'y'.repeat(1000) }))
      },
      detail_limits: { top_k: 20, max_depth: 20, source_context_lines: 80 }
    })
  }
  const response = await server.call('get_finding_detail', { run_id: runId, run_capability: runCapability, finding_id: 'low-big' })
  t.equal(response.ok, true)
  t.equal(response.data.classification, 'sensitive-diagnostic')
  t.equal(response.data.truncated, true)
  t.equal(response.usage.truncated, true)
  t.ok(JSON.stringify(response).length <= 12000)
  t.equal(response.data.call_tree.truncated, true)
  t.equal(response.data.source_context.lines.some(line => line.line === 40), true)
  t.end()
})

test('marks a next page low-information when its findings lack repeated quantified evidence', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  server.reports.set(runId, {
    findings: [
      { id: 'measured', severity: 'high', observation: { metric: 'total_cpu_time_pct', total_time_pct: 80 }, evidence: { sample_count: 2 } },
      { id: 'single-sample', severity: 'high', observation: { metric: 'total_cpu_time_pct', total_time_pct: 40 }, evidence: { sample_count: 1 } }
    ]
  })
  const args = { run_id: runId, run_capability: runCapability, page_size: 1 }
  const first = await server.call('get_profile_findings', args)
  t.equal(first.data.items[0].id, 'measured')
  t.equal(first.data.low_information, true)

  const last = await server.call('get_profile_findings', { ...args, cursor: first.data.next_cursor })
  t.equal(last.data.items[0].id, 'single-sample')
  t.equal(last.data.has_more, false)
  t.equal(last.data.low_information, false)
  t.end()
})
