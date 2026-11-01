'use strict'

const test = require('tap').test
const { createLinuxIsolationProvider, createBubblewrapSupervisor, createSystemdCgroupSupervisor } = require('../lib/profile-isolation-provider')

test('provider fails closed when no supervisor is configured', async t => {
  const provider = createLinuxIsolationProvider()
  await t.rejects(provider.run({ execute: async () => ({}) }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('provider forwards the strict guarantee contract', async t => {
  let received
  const provider = createLinuxIsolationProvider({
    atomicExec: true,
    supervisor: async context => {
      received = context
      return { status: 'completed' }
    }
  })
  const result = await provider.run({ execute: async () => ({ status: 'completed' }), workload: 'smoke' })
  t.same(result, { status: 'completed' })
  t.equal(received.workload, 'smoke')
  t.equal(received.guarantees.private_network, true)
  t.equal(received.guarantees.atomic_exec, true)
  t.end()
})

test('provider fails closed without atomic executable selection', async t => {
  const provider = createLinuxIsolationProvider({ supervisor: async () => ({ status: 'completed' }) })
  await t.rejects(provider.run({ execute: async () => ({ status: 'completed' }) }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('bubblewrap provider requires cgroup integration', t => {
  const supervisor = createBubblewrapSupervisor({ workspaceRoot: process.cwd(), runtimeRoot: process.execPath })
  t.throws(() => supervisor({ executable: process.execPath, args: [], cwd: process.cwd(), sandboxDir: process.cwd(), limits: { wall_clock_ms: 1 } }), { code: 'ISOLATION_UNAVAILABLE' })
  t.type(createSystemdCgroupSupervisor(), 'function')
  t.end()
})
