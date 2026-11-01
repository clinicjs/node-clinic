'use strict'

const t = require('tap')
const EventEmitter = require('node:events')
const PassThrough = require('node:stream').PassThrough
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const proxyquire = require('proxyquire').noCallThru()

async function makeHarness (t, onSpawn) {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-worker-test-'))
  t.teardown(() => fs.rm(dest, { recursive: true, force: true }))

  let child
  let paths
  let resolveSpawn
  const spawned = new Promise(resolve => { resolveSpawn = resolve })
  const killed = []
  const originalKill = process.kill
  process.kill = (pid, signal) => {
    if (pid === -424242) {
      killed.push(signal)
      child.kill(signal)
      return true
    }
    return originalKill(pid, signal)
  }
  t.teardown(() => { process.kill = originalKill })

  const { collectClinicProfiler } = proxyquire('../lib/profile-clinic-collector', {
    'node:child_process': {
      spawn (executable, args, options) {
        paths = { input: args[1], result: args[2] }
        child = new EventEmitter()
        child.pid = 424242
        child.stderr = new PassThrough()
        child.kill = signal => {
          if (child.closed) return false
          child.closed = true
          setImmediate(() => child.emit('close', null, signal))
          return true
        }
        resolveSpawn({ executable, args, options, paths, child })
        if (onSpawn) onSpawn({ args, child, paths })
        return child
      }
    }
  })

  return { collectClinicProfiler, dest, spawned, killed }
}

function optionsFor (dest, extra = {}) {
  return {
    nodePath: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: '/tmp/profiled-project',
    dest,
    name: 'worker-test',
    timeoutMs: 5000,
    env: {},
    ...extra
  }
}

t.test('worker input preserves the profiled workload cwd and removes temporary files', async t => {
  let workerInput
  const harness = await makeHarness(t, ({ args, child }) => {
    setImmediate(async () => {
      workerInput = JSON.parse(await fs.readFile(args[1], 'utf8'))
      await fs.writeFile(args[2], JSON.stringify({ value: { profiler: workerInput.profiler, profile: { sample_count: 7 } } }))
      child.closed = true
      child.emit('close', 0, null)
    })
  })

  const measurement = { warmup_runs: 2, measured_runs: 3, max_wall_clock_ms: 1000, value_field: 'throughput' }
  const throughput = { unit: 'ops_per_second', definition: 'completed operations / measured seconds' }
  const result = await harness.collectClinicProfiler('clinic-flame', optionsFor(harness.dest, { measurement, throughput }))
  const launch = await harness.spawned

  t.equal(workerInput.options.cwd, '/tmp/profiled-project')
  t.same(workerInput.options.measurement, measurement)
  t.same(workerInput.options.throughput, throughput)
  t.equal(launch.options.cwd, process.cwd())
  t.same(result, { profiler: 'clinic-flame', profile: { sample_count: 7 } })
  t.equal(await fs.stat(launch.paths.input).then(() => true, () => false), false)
  t.equal(await fs.stat(launch.paths.result).then(() => true, () => false), false)
  t.end()
})

t.test('worker timeout kills the process group and cleans up its files', async t => {
  const harness = await makeHarness(t)
  const run = harness.collectClinicProfiler('clinic-flame', optionsFor(harness.dest, { timeoutMs: 20 }))
  const launch = await harness.spawned
  await t.rejects(run, { code: 'PROFILE_TIMEOUT' })
  t.same(harness.killed, ['SIGTERM'])
  t.equal(await fs.stat(launch.paths.input).then(() => true, () => false), false)
  t.equal(await fs.stat(launch.paths.result).then(() => true, () => false), false)
  t.end()
})

t.test('worker cancellation kills the process group and propagates the cancellation code', async t => {
  const harness = await makeHarness(t)
  const controller = new AbortController()
  const run = harness.collectClinicProfiler('clinic-flame', optionsFor(harness.dest, { signal: controller.signal }))
  const launch = await harness.spawned
  controller.abort()
  await t.rejects(run, { code: 'PROFILE_CANCELLED' })
  t.same(harness.killed, ['SIGTERM'])
  t.equal(await fs.stat(launch.paths.input).then(() => true, () => false), false)
  t.equal(await fs.stat(launch.paths.result).then(() => true, () => false), false)
  t.end()
})
