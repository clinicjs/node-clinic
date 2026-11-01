'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const TOOLS = ['list_profile_workloads', 'start_profile_run', 'approve_profile_run', 'get_profile_status', 'wait_profile_run', 'get_profile_findings', 'compare_profile_runs', 'get_finding_detail', 'get_profile_artifact', 'cancel_profile_run']

const OPTIONAL_STRING = z.string().optional()
const RUN_INPUT = {
  run_id: OPTIONAL_STRING,
  run_capability: OPTIONAL_STRING
}
const TOOL_SCHEMAS = {
  list_profile_workloads: {
    page_size: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).optional()
  },
  start_profile_run: {
    workload: OPTIONAL_STRING,
    workloadId: OPTIONAL_STRING,
    profiler: OPTIONAL_STRING,
    parameters: z.record(z.unknown()).optional(),
    approval_token: OPTIONAL_STRING
  },
  approve_profile_run: { approval_token: OPTIONAL_STRING },
  get_profile_status: RUN_INPUT,
  wait_profile_run: {
    ...RUN_INPUT,
    timeout_ms: z.number().int().min(100).max(30000).optional(),
    poll_interval_ms: z.number().int().min(50).max(1000).optional()
  },
  get_profile_findings: {
    ...RUN_INPUT,
    detail_level: z.enum(['summary', 'findings']).optional(),
    page_size: z.number().int().min(1).max(20).optional(),
    max_output_chars: z.number().int().min(1024).max(20000).optional(),
    cursor: OPTIONAL_STRING,
    min_severity: z.enum(['low', 'medium', 'high']).optional()
  },
  compare_profile_runs: {
    candidate_run_id: OPTIONAL_STRING,
    candidate_run_capability: OPTIONAL_STRING,
    baseline_run_id: OPTIONAL_STRING,
    baseline_run_capability: OPTIONAL_STRING
  },
  get_finding_detail: {
    ...RUN_INPUT,
    finding_id: OPTIONAL_STRING,
    top_k: z.number().int().min(1).max(20).optional(),
    max_depth: z.number().int().min(0).max(20).optional(),
    source_context_lines: z.number().int().min(0).max(80).optional()
  },
  get_profile_artifact: {
    run_id: z.string().min(1),
    run_capability: z.string().min(1),
    artifact_ref: z.string().min(1).max(128),
    path: z.string().min(1).max(512).optional(),
    offset: z.number().int().min(0).optional(),
    page_size: z.number().int().min(1).max(50).optional(),
    max_bytes: z.number().int().min(1).max(8000).optional()
  },
  cancel_profile_run: RUN_INPUT
}

const RESPONSE_SCHEMA = {
  request_id: z.string(),
  ok: z.boolean(),
  data: z.record(z.unknown()).nullable(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    approval_token: z.string().optional()
  }).strict().nullable(),
  usage: z.object({
    estimated_input_tokens: z.number().int().nonnegative(),
    estimated_output_tokens: z.number().int().nonnegative(),
    token_counts_are_estimates: z.literal(true),
    truncated: z.boolean(),
    scope: z.enum(['response', 'run', 'session', 'window']),
    session_input_tokens_remaining: z.number().int().nonnegative(),
    session_output_tokens_remaining: z.number().int().nonnegative(),
    window_input_tokens_remaining: z.number().int().nonnegative(),
    window_output_tokens_remaining: z.number().int().nonnegative(),
    process_input_tokens_remaining: z.number().int().nonnegative(),
    process_output_tokens_remaining: z.number().int().nonnegative(),
    run_input_tokens_remaining: z.number().int().nonnegative().nullable(),
    run_output_tokens_remaining: z.number().int().nonnegative().nullable()
  }).strict().nullable()
}

function createSdkServer (profileServer) {
  const server = new McpServer({ name: 'clinic-profile-mcp', version: '1.0.0' })
  for (const name of TOOLS) {
    const descriptions = {
      list_profile_workloads: 'List registered profiling workloads. Use page_size and offset to page through the list.',
      start_profile_run: 'Start one asynchronous profiling run. It returns queued or running with run_id and run_capability; do not start it again to check progress. Reuse both values with get_profile_status or wait_profile_run. At most one run can be active per server.',
      get_profile_status: 'Check progress for the same run using its run_id and run_capability. For queued or running, keep using this run; do not start another run.',
      wait_profile_run: 'Wait on the same run, polling internally until it is terminal or timeout_ms elapses. Pass the run_id and run_capability returned by start_profile_run; a timeout returns the current state and next poll hint.',
      get_profile_findings: 'Return findings from the selected profiling run sorted by severity and impact with bounded pagination; use next_cursor for the next page.',
      get_profile_artifact: 'Use the run_id and run_capability plus artifact_ref from the completed run. Omit path to list files; set a listed relative path to read a bounded base64 page, using offset and max_bytes.',
      cancel_profile_run: 'Request cancellation for the same run using run_id and run_capability. Success is returned only after the runner confirms a terminal state; unsupported or unconfirmed cancellation returns an error.'
    }
    const description = descriptions[name] || `Clinic.js ${name.replaceAll('_', ' ')}`
    server.registerTool(name, { description, inputSchema: TOOL_SCHEMAS[name], outputSchema: RESPONSE_SCHEMA }, async (input = {}) => {
      const response = await profileServer.call(name, input, `mcp_${Date.now()}`)
      return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(response) }], structuredContent: response }
    })
  }
  return server
}

async function serveSdk (profileServer) {
  const server = createSdkServer(profileServer)
  await server.connect(new StdioServerTransport())
}

module.exports = { TOOLS, TOOL_SCHEMAS, createSdkServer, serveSdk }
