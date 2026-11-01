'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('tap').test
const { resolveWorkload, runWorkload } = require('../lib/profile-runner')

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
