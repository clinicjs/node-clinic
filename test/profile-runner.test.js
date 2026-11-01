'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('tap').test
const { resolveWorkload, runWorkload } = require('../lib/profile-runner')
const { loadManifest } = require('../lib/profile-manifest')

function manifest (argv) {
  return { profile_workloads: { smoke: { executable: process.execPath, argv, cwd: '/workspace', env_allowlist: [], profilers: ['clinic-flame'], limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 64, artifact_mb: 1 }, network: 'disabled', parameters: {}, throughput: { unit: 'runs', definition: 'completed runs' } } } }
}

test('resolveWorkload rejects unknown and invalid workloads', t => {
  t.throws(() => resolveWorkload(manifest(['-e', '']), 'missing'), { code: 'UNKNOWN_WORKLOAD' })
  t.throws(() => resolveWorkload({ profile_workloads: { smoke: { argv: [] } } }, 'smoke'), { code: 'INVALID_WORKLOAD' })
  t.end()
})

test('runWorkload executes without ambient environment and exports completion metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-'))
  const runRoot = path.join(root, '.clinic-runs')
  const result = await runWorkload({ rootDir: root, runRoot, runtimeRoot: path.dirname(process.execPath), workload: 'smoke', manifest: manifest(['-e', 'process.stdout.write(process.env.HOME || "none")']) })
  t.equal(result.status, 'completed')
  t.equal(result.exitCode, 0)
  t.equal(result.artifact.bytes, 0)
  t.ok(fs.existsSync(path.join(runRoot, result.runId, 'artifacts', 'completion.json')))
  t.end()
})

test('runWorkload applies wall-clock timeout', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-timeout-'))
  const m = manifest(['-e', 'setTimeout(() => {}, 5000)'])
  m.profile_workloads.smoke.limits.wall_clock_ms = 25
  const result = await runWorkload({ rootDir: root, runRoot: path.join(root, '.clinic-runs'), runtimeRoot: path.dirname(process.execPath), workload: 'smoke', manifest: m })
  t.equal(result.status, 'timed_out')
  t.end()
})

test('runWorkload rejects undeclared parameters before execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-invalid-parameters-'))
  await t.rejects(runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.exit(0)']),
    parameters: { command: 'unexpected' }
  }), { code: 'INVALID_PARAMETERS' })
  t.notOk(fs.existsSync(path.join(root, '.clinic-runs')))
  t.end()
})

test('runWorkload forwards the bounded measurement contract to the Clinic collector', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-measurement-'))
  const m = manifest(['-e', 'process.exit(0)'])
  const measurement = { warmup_runs: 2, measured_runs: 3, max_wall_clock_ms: 500, value_field: 'throughput' }
  const throughput = { unit: 'ops_per_second', definition: 'completed operations / measured seconds' }
  m.profile_workloads.smoke.measurement = measurement
  m.profile_workloads.smoke.throughput = throughput
  let collectorOptions
  const collectedMeasurement = { samples: [10, 12, 11], sample_count: 3, warmup_count: 2, value_field: 'throughput', max_wall_clock_ms: 500, elapsed_ms: 100, unit: throughput.unit, definition: throughput.definition, median: 11 }
  const result = await runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: m,
    collector: async options => {
      collectorOptions = options
      return { artifactDir: options.dest, profiler: 'clinic-flame', profile: { nodes: [] }, measurement: collectedMeasurement }
    }
  })
  t.same(collectorOptions.measurement, measurement)
  t.same(collectorOptions.throughput, throughput)
  t.same(result.measurement, collectedMeasurement)
  t.equal(result.status, 'completed')
  t.end()
})

test('runWorkload revalidates the startup manifest before launching a collector', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-manifest-recheck-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'profile-workloads.json')
  const source = manifest(['-e', 'process.stdout.write("ok")'])
  source.profile_workloads.smoke.executable = 'node'
  fs.writeFileSync(manifestPath, JSON.stringify(source))
  const loaded = loadManifest(manifestPath, { trustedRoot: root })
  let collectorCalled = false
  const run = runWorkload({
    manifest: loaded.manifest,
    manifestSource: loaded,
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    workload: 'smoke',
    collector: async () => {
      collectorCalled = true
      throw new Error('collector must not run after the manifest changes')
    }
  })
  source.profile_workloads.smoke.argv[1] = 'process.exit(7)'
  fs.writeFileSync(manifestPath, JSON.stringify(source))

  const result = await run
  t.equal(collectorCalled, false)
  t.equal(result.status, 'failed')
  t.equal(result.error.code, 'MANIFEST_CHANGED')
  t.end()
})

test('runWorkload reports measurement wall-clock exhaustion as timed out', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-measurement-timeout-'))
  const result = await runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.exit(0)']),
    collector: async () => {
      throw Object.assign(new Error('measurement exceeded its wall-clock limit'), { code: 'MEASUREMENT_TIMEOUT' })
    }
  })
  t.equal(result.status, 'timed_out')
  t.equal(result.error.code, 'MEASUREMENT_TIMEOUT')
  t.equal(result.error.retryable, true)
  t.end()
})

test('strict runs fail closed without an isolation provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-strict-'))
  await t.rejects(runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.exit(0)']),
    strict: true
  }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('strict runs delegate execution to the injected isolation provider', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-provider-'))
  let context
  const provider = {
    run: async value => {
      context = value
      return value.execute()
    }
  }
  const result = await runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.stdout.write("ok")']),
    strict: true,
    isolationProvider: provider
  })
  t.equal(result.status, 'completed')
  t.equal(result.exitCode, 0)
  t.equal(context.limits.memory_mb, 64)
  t.ok(fs.existsSync(path.join(root, '.clinic-runs', result.runId, 'artifacts', 'completion.json')))
  t.end()
})
