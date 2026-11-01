'use strict'

const t = require('tap')
const { createSdkServer, TOOLS } = require('../lib/profile-mcp-sdk')

t.test('SDK MCP server registers all profiling tools', t => {
  const calls = []
  const server = createSdkServer({
    call: async (name, input) => {
      calls.push([name, input])
      return { ok: true, data: { name } }
    }
  })
  t.ok(server)
  t.same(TOOLS.length, 8)
  t.end()
})
