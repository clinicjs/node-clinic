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
    'wait_profile_run',
    'get_profile_findings',
    'compare_profile_runs',
    'get_finding_detail',
    'get_profile_artifact',
    'cancel_profile_run'
  ]
  t.same(TOOLS, expectedTools)
  t.same(Object.keys(server._registeredTools), expectedTools)
  t.end()
})

t.test('SDK tool schema validates bounded pagination inputs', t => {
  const server = createSdkServer({ call: async () => ({ ok: true, data: {} }) })
  const schema = server._registeredTools.get_profile_findings.inputSchema
  const detailSchema = server._registeredTools.get_finding_detail.inputSchema
  t.equal(schema.safeParse({ run_id: 'run-1', page_size: 10, max_output_chars: 8000 }).success, true)
  t.equal(schema.safeParse({ detail_level: 'summary' }).success, true)
  t.equal(schema.safeParse({ page_size: 1.5 }).success, false)
  t.equal(schema.safeParse({ page_size: 21 }).success, false)
  t.equal(schema.safeParse({ max_output_chars: '8000' }).success, false)
  t.equal(detailSchema.safeParse({ top_k: 10, max_depth: 5, source_context_lines: 40 }).success, true)
  t.equal(detailSchema.safeParse({ source_context_lines: 1000 }).success, false)
  const workloadSchema = server._registeredTools.list_profile_workloads.inputSchema
  const waitSchema = server._registeredTools.wait_profile_run.inputSchema
  t.equal(workloadSchema.safeParse({ page_size: 20, offset: 40 }).success, true)
  t.equal(waitSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', timeout_ms: 5000, poll_interval_ms: 250 }).success, true)
  t.equal(waitSchema.safeParse({ timeout_ms: 60000 }).success, false)
  t.equal(waitSchema.safeParse({ poll_interval_ms: 10 }).success, false)
  const artifactSchema = server._registeredTools.get_profile_artifact.inputSchema
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', artifact_ref: 'artifact-123', page_size: 20 }).success, true)
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1' }).success, false)
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', artifact_ref: 'artifact-123', max_bytes: 9000 }).success, false)
  t.end()
})

t.test('SDK handler exposes the common response envelope as structured MCP content', async t => {
  const calls = []
  const server = createSdkServer({
    call: async (name, input, requestId) => {
      calls.push({ name, input, requestId })
      return { request_id: requestId, ok: true, data: { run_id: 'run-1', status: 'queued' }, error: null, usage: null }
    }
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'smoke', profiler: 'clinic-flame' })
  t.equal(calls[0].name, 'start_profile_run')
  t.same(calls[0].input, { workload: 'smoke', profiler: 'clinic-flame' })
  t.match(calls[0].requestId, /^mcp_\d+$/)
  t.same(response.structuredContent, {
    request_id: calls[0].requestId,
    ok: true,
    data: { run_id: 'run-1', status: 'queued' },
    error: null,
    usage: null
  })
  t.same(response.content, [{ type: 'text', text: JSON.stringify(response.structuredContent) }])
  t.equal(response.isError, false)
  t.end()
})

t.test('SDK handler marks facade failures as MCP errors', async t => {
  const server = createSdkServer({
    call: async (name, input, requestId) => ({ request_id: requestId, ok: false, data: null, error: { code: 'unknown_workload', message: 'Not registered' }, usage: null })
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'missing' })
  t.equal(response.isError, true)
  t.equal(response.structuredContent.ok, false)
  t.same(response.structuredContent.error, { code: 'unknown_workload', message: 'Not registered' })
  t.end()
})
