'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('tap').test
const { hashInputPath, openInputMount } = require('../lib/profile-input-mounts')
const { createSourceRoots } = require('../lib/profile-source-roots')

test('hashes file inputs and opens only digest-matching read-only mounts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-input-mount-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'fixture.json')
  fs.writeFileSync(source, '{"items":[1,2,3]}')
  const digest = hashInputPath(source)
  t.match(digest, /^sha256-[a-f0-9]{64}$/)

  const mount = openInputMount({
    source_root: 'workspace',
    source: 'fixture.json',
    target: '/inputs/fixture.json',
    digest
  }, { workspace: root })
  t.equal(fs.fstatSync(mount.fd).isFile(), true)
  t.equal(mount.target, '/inputs/fixture.json')
  fs.closeSync(mount.fd)

  t.throws(() => openInputMount({
    source_root: 'workspace',
    source: 'fixture.json',
    target: '/inputs/fixture.json',
    digest: `sha256-${'0'.repeat(64)}`
  }, { workspace: root }), { code: 'INPUT_DIGEST_MISMATCH' })
  t.end()
})

test('directory input digests are deterministic and cover relative paths and contents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-input-tree-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'assets')
  fs.mkdirSync(path.join(directory, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'nested', 'b.json'), '{"b":2}')
  fs.writeFileSync(path.join(directory, 'a.json'), '{"a":1}')
  const first = hashInputPath(directory)
  t.equal(hashInputPath(directory), first)
  fs.writeFileSync(path.join(directory, 'nested', 'b.json'), '{"b":3}')
  t.not(hashInputPath(directory), first)
  t.end()
})

test('input mounts reject symlinks, noncanonical targets, and unconfigured roots', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-input-invalid-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const secret = path.join(root, 'secret')
  const link = path.join(root, 'linked')
  fs.writeFileSync(secret, 'private')
  fs.symlinkSync(secret, link)
  const mount = {
    source_root: 'workspace',
    source: 'linked',
    target: '/inputs/linked',
    digest: `sha256-${'0'.repeat(64)}`
  }
  t.throws(() => openInputMount(mount, { workspace: root }), { code: 'INVALID_INPUT_MOUNT' })
  t.throws(() => openInputMount({ ...mount, source: 'secret', target: '/workspace/secret' }, { workspace: root }), { code: 'INVALID_INPUT_MOUNT' })
  t.throws(() => openInputMount({ ...mount, source: 'secret', source_root: 'declared-input' }, { workspace: root }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('source roots map declared input mounts without exposing host paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-source-roots-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'bench'))
  fs.mkdirSync(path.join(root, 'inputs'))
  fs.writeFileSync(path.join(root, 'inputs', 'fixture.js'), 'module.exports = 1\n')
  const mount = {
    source_root: 'workspace',
    source: 'inputs/fixture.js',
    target: '/inputs/corpus/fixture.js',
    digest: hashInputPath(path.join(root, 'inputs', 'fixture.js'))
  }
  const roots = createSourceRoots({ cwd: '/workspace/bench', input_mounts: [mount] }, root, null)
  t.same(roots.map(entry => entry.reportPrefix), ['bench', '', 'inputs/corpus/fixture.js'])
  t.equal(roots[0].root, path.join(root, 'bench'))
  t.equal(roots[2].root, path.join(root, 'inputs', 'fixture.js'))
  t.end()
})
