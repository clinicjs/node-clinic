'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')
const { handleJsonRpc } = require('../lib/profile-mcp-jsonrpc')

function server () {
  return new ProfileMcpServer({ workloads: { smoke: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1, memory_mb: 1 } } }, runner: { start: async () => ({ status: 'running', runId: 'r1' }) } })
}

test('MCP JSON-RPC initializes and lists tools', async t => {
  const init = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, server())
  t.equal(init.result.serverInfo.name, 'clinic-profile-mcp')
  const tools = await handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, server())
  t.ok(tools.result.tools.some(tool => tool.name === 'start_profile_run'))
  t.end()
})

test('MCP JSON-RPC dispatches tools/call and reports protocol errors', async t => {
  const response = await handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_profile_workloads', arguments: {} } }, server())
  t.equal(response.result.isError, false)
  t.match(response.result.structuredContent.items, [{ id: 'smoke' }])
  const error = await handleJsonRpc({ jsonrpc: '2.0', id: 4, method: 'nope' }, server())
  t.equal(error.error.code, -32601)
  t.end()
})
