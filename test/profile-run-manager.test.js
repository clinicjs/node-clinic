'use strict'

const t = require('tap')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createRunManager, runWorkload } = require('../lib/profile-runner')

t.test('run manager returns before completion and reports live status', async t => {
  let finish
  let started
  const manager = createRunManager(options => {
    started = options
    return new Promise(resolve => { finish = resolve })
  })

  const result = await manager.start({ runId: 'run-async-test' })
  t.equal(result.status, 'queued')
  await new Promise(resolve => setImmediate(resolve))
  t.equal((await manager.status('run-async-test')).status, 'running')
  t.ok(started.signal instanceof AbortSignal)

  finish({ status: 'completed', report: { findings: [] } })
  const final = await new Promise(resolve => setImmediate(async () => resolve(await manager.status('run-async-test'))))
  t.equal(final.status, 'completed')
  t.same(final.report, { findings: [] })
  t.end()
})

t.test('run manager abort waits for the run to stop', async t => {
  let signal
  const manager = createRunManager(options => {
    signal = options.signal
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }))
  })

  await manager.start({ runId: 'run-cancel-test' })
  await new Promise(resolve => setImmediate(resolve))
  const cancelled = await manager.cancel('run-cancel-test')
  t.ok(signal.aborted)
  t.equal(cancelled.status, 'cancelled')
  t.end()
})

t.test('cancelling a workload terminates its detached process group', async t => {
  if (process.platform !== 'linux') {
    t.skip('process-group cancellation is verified on Linux')
    t.end()
    return
  }
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-run-cancel-'))
  t.teardown(() => fs.rm(rootDir, { recursive: true, force: true }))
  const manifest = {
    profile_workloads: {
      wait: {
        executable: 'node',
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: '/workspace',
        env_allowlist: [],
        parameters: {},
        limits: { wall_clock_ms: 10000, cpu_ms: 10000, memory_mb: 64, artifact_mb: 1 }
      }
    }
  }
  const manager = createRunManager(options => runWorkload({
    ...options,
    rootDir,
    runRoot: path.join(rootDir, '.clinic-runs'),
    manifest,
    workload: 'wait',
    strict: false
  }))
  await manager.start({ runId: 'run-real-cancel' })
  await new Promise(resolve => setTimeout(resolve, 50))
  t.equal((await manager.status('run-real-cancel')).status, 'running')
  const result = await manager.cancel('run-real-cancel')
  t.equal(result.status, 'cancelled')
})
