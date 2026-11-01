'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('tap').test
const { resolveWorkload, workloadInputDigest, verifyDeclaredInputs, runWorkload, exportArtifacts, verifyArtifactCompletion, recoverArtifactStaging, cleanupExpiredArtifactRuns } = require('../lib/profile-runner')
const { loadManifest } = require('../lib/profile-manifest')
const { hashInputPath } = require('../lib/profile-input-mounts')

function manifest (argv) {
  return { profile_workloads: { smoke: { executable: process.execPath, argv, cwd: '/workspace', env_allowlist: [], profilers: ['clinic-flame'], limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 64, artifact_mb: 1 }, network: 'disabled', parameters: {}, throughput: { unit: 'runs', definition: 'completed runs', value_field: 'throughput' } } } }
}

test('resolveWorkload rejects unknown and invalid workloads', t => {
  t.throws(() => resolveWorkload(manifest(['-e', '']), 'missing'), { code: 'UNKNOWN_WORKLOAD' })
  t.throws(() => resolveWorkload({ profile_workloads: { smoke: { argv: [] } } }, 'smoke'), { code: 'INVALID_WORKLOAD' })
  t.end()
})

test('workload input digest includes canonical parameters and declared input hashes', t => {
  const definition = {
    input_mounts: [
      { source_root: 'workspace', source: 'fixtures/b', target: '/inputs/b', digest: `sha256-${'b'.repeat(64)}` },
      { source_root: 'workspace', source: 'fixtures/a', target: '/inputs/a', digest: `sha256-${'a'.repeat(64)}` }
    ]
  }
  const first = workloadInputDigest(definition, { iterations: 10, seed: 2 })
  const reordered = workloadInputDigest(definition, { seed: 2, iterations: 10 })
  t.equal(first, reordered)
  t.not(first, workloadInputDigest(definition, { seed: 2, iterations: 11 }))
  t.not(first, workloadInputDigest({ input_mounts: [definition.input_mounts[0]] }, { iterations: 10, seed: 2 }))
  t.match(first, /^sha256-[a-f0-9]{64}$/)
  t.end()
})

test('runner verifies declared input content before direct profiling', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-declared-input-'))
  const inputPath = path.join(root, 'fixture.json')
  fs.writeFileSync(inputPath, '{"items":1}')
  const mount = { source_root: 'workspace', source: 'fixture.json', target: '/inputs/fixture.json', digest: hashInputPath(inputPath) }
  t.doesNotThrow(() => verifyDeclaredInputs({ input_mounts: [mount] }, root, null))
  fs.writeFileSync(inputPath, '{"items":2}')
  t.throws(() => verifyDeclaredInputs({ input_mounts: [mount] }, root, null), { code: 'INPUT_DIGEST_MISMATCH' })
  fs.rmSync(root, { recursive: true, force: true })
  t.end()
})

test('runWorkload executes without ambient environment and exports completion metadata', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-'))
  const runRoot = path.join(root, '.clinic-runs')
  const result = await runWorkload({ rootDir: root, runRoot, runtimeRoot: path.dirname(process.execPath), workload: 'smoke', manifest: manifest(['-e', 'process.stdout.write(process.env.HOME || "none")']) })
  t.equal(result.status, 'completed')
  t.equal(result.exitCode, 0)
  t.equal(result.terminationReason, 'completed')
  t.equal(result.artifact.bytes, 0)
  t.ok(fs.existsSync(path.join(runRoot, result.runId, 'artifacts', 'completion.json')))
  t.end()
})

test('artifact export refuses to replace an existing run directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-artifact-export-'))
  const staging = path.join(root, 'staging')
  const destination = path.join(root, 'run', 'artifacts')
  fs.mkdirSync(staging, { recursive: true })
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing artifact')

  await t.rejects(exportArtifacts(staging, destination, 1024), { code: 'ARTIFACT_EXISTS' })
  t.equal(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8'), 'existing artifact')
  t.end()
})

test('artifact export verifies the completion manifest and copied file hashes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-artifact-manifest-'))
  const staging = path.join(root, 'source')
  const destination = path.join(root, 'run', 'artifacts')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'profile.json'), '{"samples":3}')
  const completion = await exportArtifacts(staging, destination, 1024)
  t.equal(completion.files.length, 1)
  t.equal(await verifyArtifactCompletion(destination), true)
  fs.writeFileSync(path.join(destination, 'profile.json'), '{"samples":4}')
  t.equal(await verifyArtifactCompletion(destination), false)
  t.end()
})

test('startup recovery removes only known artifact staging directories', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-artifact-recovery-'))
  const stagingDir = path.join(root, '.staging')
  const stale = path.join(stagingDir, 'artifacts-999999999-abcdef012345abcdef012345')
  const active = path.join(stagingDir, `artifacts-${process.pid}-abcdef012345abcdef012345`)
  const unrelated = path.join(stagingDir, 'unrelated')
  fs.mkdirSync(stale, { recursive: true })
  fs.mkdirSync(active, { recursive: true })
  fs.mkdirSync(unrelated, { recursive: true })
  t.equal(await recoverArtifactStaging(root), 1)
  t.equal(fs.existsSync(stale), false)
  t.equal(fs.existsSync(active), true)
  t.equal(fs.existsSync(unrelated), true)
  t.end()
})

test('artifact retention removes expired exports and preserves live ones', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-artifact-retention-'))
  const staging = path.join(root, 'source')
  fs.mkdirSync(staging, { recursive: true })
  fs.writeFileSync(path.join(staging, 'profile.json'), '{}')
  const expired = path.join(root, 'run_expired', 'artifacts')
  const live = path.join(root, 'run_live', 'artifacts')
  await exportArtifacts(staging, expired, 1024, { createdAt: 1000, retentionMs: 1000 })
  await exportArtifacts(staging, live, 1024, { createdAt: 1000, retentionMs: 5000 })
  t.equal(await cleanupExpiredArtifactRuns(root, 2001), 1)
  t.equal(fs.existsSync(expired), false)
  t.equal(fs.existsSync(live), true)
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
    atomicExec: true,
    atomicTargetExec: true,
    completeInputFilesystem: true,
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

test('strict failures retain bounded partial artifacts for terminal reports', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-partial-'))
  const isolationProvider = {
    atomicExec: true,
    atomicTargetExec: true,
    completeInputFilesystem: true,
    run: async context => {
      fs.writeFileSync(path.join(context.sandboxDir, 'partial.clinic-data'), 'partial profile')
      return { status: 'failed', exitCode: 1, stdout: '', stderr: 'profile interrupted' }
    }
  }
  const result = await runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.exit(0)']),
    strict: true,
    isolationProvider,
    collector: async () => { throw new Error('collector must run in the isolation provider') }
  })
  t.equal(result.status, 'failed')
  t.equal(result.error.code, 'PROFILE_FAILED')
  t.match(result.artifactRef, /^artifact_[A-Za-z0-9_-]{22}$/)
  t.equal(result.artifact.files.some(file => file.path === 'partial.clinic-data'), true)
  t.ok(fs.existsSync(path.join(root, '.clinic-runs', result.runId, 'artifacts', 'completion.json')))
  t.end()
})

test('strict runs expose artifact quota termination as a stable failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-runner-artifact-limit-'))
  const result = await runWorkload({
    rootDir: root,
    runRoot: path.join(root, '.clinic-runs'),
    runtimeRoot: path.dirname(process.execPath),
    workload: 'smoke',
    manifest: manifest(['-e', 'process.exit(0)']),
    strict: true,
    isolationProvider: {
      atomicExec: true,
      atomicTargetExec: true,
      completeInputFilesystem: true,
      run: async () => ({ status: 'artifact_limit_exceeded', exitCode: null, stdout: '', stderr: '' })
    },
    collector: async () => { throw new Error('collector must run in the isolation provider') }
  })
  t.equal(result.status, 'failed')
  t.equal(result.terminationReason, 'artifact_limit_exceeded')
  t.equal(result.error.code, 'ARTIFACT_LIMIT')
  t.end()
})
