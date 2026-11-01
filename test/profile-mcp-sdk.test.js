'use strict'

const t = require('tap')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
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
  const outputSchema = server._registeredTools.get_profile_findings.outputSchema
  const detailSchema = server._registeredTools.get_finding_detail.inputSchema
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', page_size: 10, max_output_chars: 8000 }).success, true)
  t.equal(schema.safeParse({ run_id: 'run-1', page_size: 10 }).success, false)
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', detail_level: 'summary' }).success, true)
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', page_size: 1.5 }).success, false)
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', page_size: 21 }).success, false)
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', max_output_chars: '8000' }).success, false)
  t.equal(schema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', max_output_chars: 12001 }).success, false)
  t.equal(outputSchema.safeParse({ request_id: 'req-1', ok: true, data: { run_id: 'run-1', classification: 'sensitive-diagnostic', snapshot_id: 'snapshot', sort: 'impact_desc', expires_at: 'now', items: [], next_cursor: null, has_more: false, truncated: false, low_information: false }, error: null, usage: null }).success, true)
  t.equal(outputSchema.safeParse({ request_id: 'req-1', ok: true, data: { unexpected: true }, error: null, usage: null }).success, false)
  t.equal(detailSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', finding_id: 'finding-1', top_k: 10, max_depth: 5, source_context_lines: 40 }).success, true)
  t.equal(detailSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', source_context_lines: 1000 }).success, false)
  const workloadSchema = server._registeredTools.list_profile_workloads.inputSchema
  const waitSchema = server._registeredTools.wait_profile_run.inputSchema
  t.equal(workloadSchema.safeParse({ page_size: 20, cursor: 'cursor_opaque' }).success, true)
  t.equal(workloadSchema.shape.cursor != null, true)
  t.equal(workloadSchema.shape.offset, undefined)
  const workloadOutput = server._registeredTools.list_profile_workloads.outputSchema
  t.equal(workloadOutput.safeParse({ request_id: 'req-1', ok: true, data: { items: [], total: 0, has_more: false, next_cursor: null }, error: null, usage: null }).success, true)
  t.equal(waitSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', timeout_ms: 5000, poll_interval_ms: 250 }).success, true)
  t.equal(waitSchema.safeParse({ timeout_ms: 60000 }).success, false)
  t.equal(waitSchema.safeParse({ poll_interval_ms: 10 }).success, false)
  const startSchema = server._registeredTools.start_profile_run.inputSchema
  const compareSchema = server._registeredTools.compare_profile_runs.inputSchema
  t.equal(startSchema.safeParse({ workload: 'fibonacci' }).success, true)
  t.equal(startSchema.safeParse({ workloadId: 'fibonacci' }).success, false)
  t.equal(compareSchema.safeParse({ candidate_run_id: 'candidate', candidate_run_capability: 'candidate-cap', baseline_run_id: 'baseline', baseline_run_capability: 'baseline-cap' }).success, true)
  t.equal(compareSchema.safeParse({ candidate_run_id: 'candidate', baseline_run_id: 'baseline' }).success, false)
  const artifactSchema = server._registeredTools.get_profile_artifact.inputSchema
  const artifactOutput = server._registeredTools.get_profile_artifact.outputSchema
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', artifact_ref: 'artifact-123', page_size: 20 }).success, true)
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', artifact_ref: 'artifact-123', cursor: 'cursor_opaque' }).success, true)
  t.equal(artifactOutput.safeParse({ request_id: 'req-1', ok: true, data: { run_id: 'run-1', classification: 'sensitive-diagnostic', artifact_ref: 'artifact-123', files: [], total: 0, has_more: false, next_cursor: null }, error: null, usage: null }).success, true)
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1' }).success, false)
  t.equal(artifactSchema.safeParse({ run_id: 'run-1', run_capability: 'cap-1', artifact_ref: 'artifact-123', max_bytes: 9000 }).success, false)
  t.end()
})

t.test('SDK handler exposes the common response envelope as structured MCP content', async t => {
  const calls = []
  const server = createSdkServer({
    call: async (name, input, requestId) => {
      calls.push({ name, input, requestId })
      return { request_id: requestId, ok: true, data: { run_id: 'run-1', run_capability: 'cap-1', status: 'queued', created_at: '2026-11-01T00:00:00.000Z' }, error: null, usage: null }
    }
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'smoke', profiler: 'clinic-flame' })
  t.equal(calls[0].name, 'start_profile_run')
  t.same(calls[0].input, { workload: 'smoke', profiler: 'clinic-flame' })
  t.match(calls[0].requestId, /^mcp_\d+$/)
  t.same(response.structuredContent, {
    request_id: calls[0].requestId,
    ok: true,
    data: { run_id: 'run-1', run_capability: 'cap-1', status: 'queued', created_at: '2026-11-01T00:00:00.000Z' },
    error: null,
    usage: null
  })
  t.same(response.content, [{ type: 'text', text: JSON.stringify(response.structuredContent) }])
  t.equal(response.isError, false)
  t.end()
})

t.test('SDK handler marks facade failures as MCP errors', async t => {
  const server = createSdkServer({
    call: async (name, input, requestId) => ({ request_id: requestId, ok: false, data: null, error: { code: 'unknown_workload', message: 'Not registered', retryable: false }, usage: null })
  })
  const response = await server._registeredTools.start_profile_run.handler({ workload: 'missing' })
  t.equal(response.isError, true)
  t.equal(response.structuredContent.ok, false)
  t.same(response.structuredContent.error, { code: 'unknown_workload', message: 'Not registered', retryable: false })
  t.end()
})

t.test('expensive run approval requires an affirmative client elicitation', async t => {
  const calls = []
  const profileServer = {
    getApprovalDetails: token => token === 'approval-1' ? { workload: 'fibonacci', profiler: 'clinic-flame', parameters: { iterations: 2 }, resource_cost_estimate: { wall_clock_ms: 40000 } } : null,
    call: async (name, input, requestId) => {
      calls.push({ name, input })
      return { request_id: requestId, ok: true, data: { approved: true, approval_token: input.approval_token }, error: null, usage: null }
    }
  }
  const server = createSdkServer(profileServer)
  let elicitation
  server.server.elicitInput = async params => {
    elicitation = params
    return { action: 'accept', content: { confirm: true } }
  }
  const response = await server._registeredTools.approve_profile_run.handler({ approval_token: 'approval-1' })
  t.equal(elicitation.mode, 'form')
  t.match(elicitation.message, /fibonacci/)
  t.match(elicitation.message, /wall_clock_ms/)
  t.same(calls, [{ name: 'approve_profile_run', input: { approval_token: 'approval-1' } }])
  t.equal(response.structuredContent.ok, true)

  server.server.elicitInput = async () => ({ action: 'decline' })
  const declined = await server._registeredTools.approve_profile_run.handler({ approval_token: 'approval-1' })
  t.equal(declined.structuredContent.error.code, 'approval_declined')
  t.equal(calls.length, 1)

  server.server.elicitInput = async () => { throw new Error('unsupported') }
  const unsupported = await server._registeredTools.approve_profile_run.handler({ approval_token: 'approval-1' })
  t.equal(unsupported.structuredContent.error.code, 'approval_unavailable')
  t.equal(calls.length, 1)
  t.end()
})

t.test('MCP protocol carries approval confirmation through client elicitation', async t => {
  const calls = []
  const server = createSdkServer({
    getApprovalDetails: () => ({ workload: 'fibonacci', profiler: 'clinic-flame', parameters: {}, resource_cost_estimate: { wall_clock_ms: 40000 } }),
    call: async (name, input, requestId) => {
      calls.push(name)
      return { request_id: requestId, ok: true, data: { approved: true, approval_token: input.approval_token }, error: null, usage: null }
    }
  })
  const client = new Client({ name: 'approval-test-client', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } })
  let prompt
  client.setRequestHandler(ElicitRequestSchema, async request => {
    prompt = request.params.message
    return { action: 'accept', content: { confirm: true } }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const response = await client.callTool({ name: 'approve_profile_run', arguments: { approval_token: 'approval-1' } })
  t.match(prompt, /Approve profiling workload "fibonacci"/)
  t.same(calls, ['approve_profile_run'])
  t.equal(response.structuredContent.ok, true)
  await client.close()
  t.end()
})

t.test('SDK handler rejects a terminal report that violates the runtime schemas', async t => {
  const server = createSdkServer({
    call: async (name, input, requestId) => ({
      request_id: requestId,
      ok: true,
      data: { schema_version: 1, run: { status: 'completed' }, summary: {}, findings: [], artifacts: [] },
      error: null,
      usage: null
    })
  })
  const response = await server._registeredTools.get_profile_status.handler({ run_id: 'run-1', run_capability: 'cap-1' })
  t.equal(response.isError, true)
  t.equal(response.structuredContent.ok, false)
  t.equal(response.structuredContent.error.code, 'invalid_tool_output')
  t.end()
})
