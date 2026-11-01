'use strict'

const test = require('tap').test
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { readHostMeasurementConditions, createMeasurementEnvironment, hashDependencyTree, combineToolchainDigest } = require('../lib/profile-reproducibility')

test('toolchain digest covers installed dependency contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-dependencies-'))
  t.teardown(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'pkg'))
  await fs.writeFile(path.join(root, 'pkg', 'index.js'), 'module.exports = 1\n')
  const first = await hashDependencyTree(root)
  const same = await hashDependencyTree(root)
  t.equal(first, same, 'digest is independent of directory creation order')
  const toolchain = combineToolchainDigest('sha256-node', first)
  t.match(toolchain, /^sha256-[a-f0-9]{64}$/)
  await fs.writeFile(path.join(root, 'pkg', 'index.js'), 'module.exports = 2\n')
  const changed = await hashDependencyTree(root)
  t.not(changed, first, 'changed installed code changes the descriptive digest')
  t.end()
})

test('toolchain digest rejects dependency symlinks that escape node_modules', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-dependency-symlink-'))
  const root = path.join(parent, 'node_modules')
  await fs.mkdir(root)
  await fs.writeFile(path.join(parent, 'outside.js'), 'outside')
  await fs.symlink(path.join(parent, 'outside.js'), path.join(root, 'outside.js'))
  t.teardown(() => fs.rm(parent, { recursive: true, force: true }))
  await t.rejects(hashDependencyTree(root), /symlink escapes installed tree/)
  t.end()
})

test('measurement environment records host conditions and bounded limitations', t => {
  const start = readHostMeasurementConditions()
  const finish = { ...start }
  const environment = createMeasurementEnvironment({
    isolationMode: 'systemd-bubblewrap',
    schedulerMode: 'systemd-cgroup-cpu-quota',
    start,
    finish
  })
  t.same(Object.keys(start).sort(), ['cpu_affinity', 'cpu_frequency_khz', 'cpu_governor', 'thermal_millicelsius'])
  t.equal(environment.isolation_mode, 'systemd-bubblewrap')
  t.equal(environment.scheduler_mode, 'systemd-cgroup-cpu-quota')
  t.same(environment.start, start)
  t.same(environment.finish, finish)
  t.ok(environment.limitations.length >= 1)
  t.end()
})
