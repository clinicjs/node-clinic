'use strict'

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const TOOLS = ['list_profile_workloads', 'start_profile_run', 'approve_profile_run', 'get_profile_status', 'get_profile_findings', 'compare_profile_runs', 'get_finding_detail', 'cancel_profile_run']

const OPTIONAL_STRING = z.string().optional()
const RUN_INPUT = {
  run_id: OPTIONAL_STRING,
  run_capability: OPTIONAL_STRING
}
const TOOL_SCHEMAS = {
  list_profile_workloads: {},
  start_profile_run: {
    workload: OPTIONAL_STRING,
    workloadId: OPTIONAL_STRING,
    profiler: OPTIONAL_STRING,
    parameters: z.record(z.unknown()).optional(),
    approval_token: OPTIONAL_STRING
  },
  approve_profile_run: { approval_token: OPTIONAL_STRING },
  get_profile_status: RUN_INPUT,
  get_profile_findings: {
    ...RUN_INPUT,
    detail_level: OPTIONAL_STRING,
    page_size: z.number().int().optional(),
    max_output_chars: z.number().int().optional(),
    cursor: OPTIONAL_STRING,
    min_severity: OPTIONAL_STRING
  },
  compare_profile_runs: {
    candidate_run_id: OPTIONAL_STRING,
    candidate_run_capability: OPTIONAL_STRING,
    baseline_run_id: OPTIONAL_STRING,
    baseline_run_capability: OPTIONAL_STRING
  },
  get_finding_detail: { ...RUN_INPUT, finding_id: OPTIONAL_STRING },
  cancel_profile_run: RUN_INPUT
}

function createSdkServer (profileServer) {
  const server = new McpServer({ name: 'clinic-profile-mcp', version: '1.0.0' })
  for (const name of TOOLS) {
    const descriptions = {
      start_profile_run: 'Start a declared workload with a permitted profiler, e.g. workload="tok2vec", profiler="clinic-flame".',
      get_profile_findings: 'Return findings from the selected profiling run sorted by impact with bounded pagination; use next_cursor for the next page.'
    }
    const description = descriptions[name] || `Clinic.js ${name.replaceAll('_', ' ')}`
    server.registerTool(name, { description, inputSchema: TOOL_SCHEMAS[name] }, async (input = {}) => {
      const response = await profileServer.call(name, input, `mcp_${Date.now()}`)
      const payload = response.ok ? response.data : response.error
      return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
    })
  }
  return server
}

async function serveSdk (profileServer) {
  const server = createSdkServer(profileServer)
  await server.connect(new StdioServerTransport())
}

module.exports = { TOOLS, TOOL_SCHEMAS, createSdkServer, serveSdk }
