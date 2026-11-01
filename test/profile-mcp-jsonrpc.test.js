'use strict'

const test = require('tap').test
const { PassThrough } = require('stream')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { createSdkServer } = require('../lib/profile-mcp-sdk')
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('MCP SDK stdio initializes, lists tools, and starts a queued profile run', async t => {
  const input = new PassThrough()
  const output = new PassThrough()
  const profileServer = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1000, memory_mb: 64 } } },
    runner: { start: async () => ({ status: 'queued', runId: 'fake-run' }) }
  })
  const server = createSdkServer(profileServer)
  let buffer = ''
  const pending = new Map()
  let nextId = 0

  output.on('data', chunk => {
    buffer += chunk.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })

  const request = (method, params) => new Promise(resolve => {
    const id = ++nextId
    pending.set(id, resolve)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  await server.connect(new StdioServerTransport(input, output))
  t.teardown(async () => {
    await server.close().catch(() => {})
    input.destroy()
    output.destroy()
  })

  const initialized = await request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'profile-mcp-stdio-test', version: '1.0.0' }
  })
  t.equal(initialized.result.serverInfo.name, 'clinic-profile-mcp')
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

  const listed = await request('tools/list', {})
  t.ok(listed.result.tools.some(tool => tool.name === 'start_profile_run'))

  const started = await request('tools/call', {
    name: 'start_profile_run',
    arguments: { workload: 'fibonacci', profiler: 'clinic-flame' }
  })
  t.equal(started.result.isError, false)
  t.equal(started.result.structuredContent.status, 'queued')
  t.equal(started.result.structuredContent.run_id.startsWith('run_'), true)
  t.end()
})
