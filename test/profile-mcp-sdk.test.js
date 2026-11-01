'use strict'

const t = require('tap')
const { createSdkServer, TOOLS } = require('../lib/profile-mcp-sdk')

t.test('SDK MCP server registers all profiling tools', t => {
  const server = createSdkServer({
    call: async name => ({ ok: true, data: { name } })
  })
  const expectedTools = [
    'list_profile_workloads',
    'start_profile_run',
    'approve_profile_run',
    'get_profile_status',
    'get_profile_findings',
    'compare_profile_runs',
    'get_finding_detail',
    'cancel_profile_run'
  ]
  t.same(TOOLS, expectedTools)
  t.same(Object.keys(server._registeredTools), expectedTools)
  t.end()
})

t.test('SDK tool schema validates bounded pagination inputs', t => {
  const server = createSdkServer({ call: async () => ({ ok: true, data: {} }) })
  const schema = server._registeredTools.get_profile_findings.inputSchema
  t.equal(schema.safeParse({ run_id: 'run-1', page_size: 10, max_output_chars: 8000 }).success, true)
  t.equal(schema.safeParse({ page_size: 1.5 }).success, false)
  t.equal(schema.safeParse({ max_output_chars: '8000' }).success, false)
  t.end()
})

t.test('SDK handler unwraps facade data and exposes structured MCP content', async t => {
  const calls = []
  const server = createSdkServer({
    call: async (name, input, requestId) => {
      calls.push({ name, input, requestId })
      return { ok: true, data: { run_id: 'run-1', status: 'queued' } }
    }
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'smoke', profiler: 'clinic-flame' })
  t.equal(calls[0].name, 'start_profile_run')
  t.same(calls[0].input, { workload: 'smoke', profiler: 'clinic-flame' })
  t.match(calls[0].requestId, /^mcp_\d+$/)
  t.same(response.structuredContent, { run_id: 'run-1', status: 'queued' })
  t.same(response.content, [{ type: 'text', text: '{"run_id":"run-1","status":"queued"}' }])
  t.equal(response.isError, false)
  t.end()
})

t.test('SDK handler marks facade failures as MCP errors', async t => {
  const server = createSdkServer({
    call: async () => ({ ok: false, error: { code: 'unknown_workload', message: 'Not registered' } })
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'missing' })
  t.equal(response.isError, true)
  t.same(response.structuredContent, { code: 'unknown_workload', message: 'Not registered' })
  t.end()
})
