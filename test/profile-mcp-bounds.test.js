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

test('findings are severity and impact sorted, and page size/output are clamped', async t => {
  const { server, run_id: runId, run_capability: runCapability } = await setup(t)
  const result = await server.call('get_profile_findings', {
    run_id: runId,
    run_capability: runCapability,
    page_size: 1000,
    max_output_chars: 100000
  })

  t.equal(result.ok, true)
  t.equal(result.data.sort, 'severity_impact_desc')
  t.same(result.data.items.map(item => item.id), ['high-big', 'high-small'])
  t.equal(result.data.items.length, 2)
  t.equal(result.data.has_more, true)
  t.ok(JSON.stringify(result.data).length <= 20000)
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
  t.ok(server.cursors.has(first.data.next_cursor))

  await server.call('get_profile_findings', args)
  await server.call('get_profile_findings', args)
  t.equal(server.cursors.size, 2)
  t.end()
})
