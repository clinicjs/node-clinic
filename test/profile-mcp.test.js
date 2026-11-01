'use strict'

const test = require('tap').test
const { ProfileMcpServer } = require('../lib/profile-mcp')

test('MCP facade uses envelopes and session-bound capabilities', async t => {
  const runner = {
    start: async () => ({ status: 'completed', runId: 'runner-1' })
  }
  const server = new ProfileMcpServer({
    workloads: { smoke: { profilers: ['clinic-flame'], limits: { wall_clock_ms: 1, memory_mb: 1 } } },
    runner
  })
  const response = await server.call('start_profile_run', { workload: 'smoke' }, 'req-1')
  t.equal(response.ok, true)
  t.equal(response.data.status, 'completed')
  t.type(response.data.run_capability, 'string')
  const denied = await server.call('get_profile_status', { run_id: response.data.run_id, run_capability: 'wrong' }, 'req-2')
  t.equal(denied.ok, false)
  t.equal(denied.error.code, 'not_found')
  t.end()
})
