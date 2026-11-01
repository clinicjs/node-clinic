'use strict'

const test = require('tap').test
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { median, runMeasurementPlan } = require('../lib/profile-measurement')

function options (output, delayMs = 0) {
  const calls = []
  return {
    nodePath: '/trusted/node',
    args: ['-e', 'fixed workload'],
    cwd: process.cwd(),
    env: {},
    calls,
    spawnProcess (nodePath, args, spawnOptions) {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = signal => {
        process.nextTick(() => child.emit('close', null, signal))
        return true
      }
      calls.push({ nodePath, args, spawnOptions })
      if (output !== null) {
        setTimeout(() => {
          child.stdout.end(output)
          child.stderr.end()
          let ended = 0
          const onEnd = () => {
            ended++
            if (ended === 2) child.emit('close', 0, null)
          }
          child.stdout.once('end', onEnd)
          child.stderr.once('end', onEnd)
        }, delayMs)
      }
      return child
    }
  }
}

test('measurement plan discards warmups and records bounded numeric samples', async t => {
  const workload = options(JSON.stringify({ throughput: 12.5 }))
  const result = await runMeasurementPlan(workload, {
    warmup_runs: 2,
    measured_runs: 3,
    max_wall_clock_ms: 2000,
    value_field: 'throughput'
  }, {
    unit: 'operations_per_second',
    definition: 'completed operations divided by measured wall-clock seconds'
  })

  t.same(result.samples, [12.5, 12.5, 12.5])
  t.equal(result.sample_count, 3)
  t.equal(result.warmup_count, 2)
  t.equal(result.median, 12.5)
  t.equal(result.unit, 'operations_per_second')
  t.equal(workload.calls.length, 5)
  t.equal(workload.calls[0].nodePath, '/trusted/node')
  t.equal(workload.calls[0].spawnOptions.shell, false)
  t.end()
})

test('measurement plan rejects invalid JSON and undeclared metric values', async t => {
  const plan = { warmup_runs: 0, measured_runs: 2, max_wall_clock_ms: 2000, value_field: 'throughput' }
  await t.rejects(runMeasurementPlan(options('12'), plan, { unit: 'ops', definition: 'ops' }), { code: 'MEASUREMENT_INVALID_OUTPUT' })
  await t.rejects(runMeasurementPlan(options(JSON.stringify({ other: 12 })), plan, { unit: 'ops', definition: 'ops' }), { code: 'MEASUREMENT_INVALID_OUTPUT' })
  await t.rejects(runMeasurementPlan(options(JSON.stringify({ throughput: '12' })), plan, { unit: 'ops', definition: 'ops' }), { code: 'MEASUREMENT_INVALID_VALUE' })
  t.end()
})

test('measurement plan enforces output and wall-clock caps', async t => {
  const plan = { warmup_runs: 0, measured_runs: 2, max_wall_clock_ms: 2000, value_field: 'throughput' }
  await t.rejects(runMeasurementPlan(options('x'.repeat(9000)), plan, { unit: 'ops', definition: 'ops' }), { code: 'MEASUREMENT_OUTPUT_LIMIT' })

  const timedPlan = { ...plan, max_wall_clock_ms: 20 }
  await t.rejects(runMeasurementPlan(options(null), timedPlan, { unit: 'ops', definition: 'ops' }), { code: 'MEASUREMENT_TIMEOUT' })
  t.end()
})

test('measurement plan terminates a child process group when cancelled', async t => {
  const workload = options(null)
  const controller = new AbortController()
  workload.signal = controller.signal
  const run = runMeasurementPlan(workload, {
    warmup_runs: 0,
    measured_runs: 2,
    max_wall_clock_ms: 2000,
    value_field: 'throughput'
  }, { unit: 'ops', definition: 'ops' })
  setImmediate(() => controller.abort())
  await t.rejects(run, { code: 'PROFILE_CANCELLED' })
  t.end()
})

test('measurement median is deterministic for even and odd sample counts', t => {
  t.equal(median([4, 1, 3]), 3)
  t.equal(median([4, 1, 3, 2]), 2.5)
  t.end()
})
