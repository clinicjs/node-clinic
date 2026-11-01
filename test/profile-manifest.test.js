'use strict'

const test = require('tap').test
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadManifest, hashManifest, selectWorkload } = require('../lib/profile-manifest')

function fixture () {
  return {
    scripts: {},
    profile_workloads: {
      demo: {
        executable: 'node',
        argv: ['bench.js', '$' + '{iterations}'],
        cwd: '/workspace',
        env_allowlist: [],
        profilers: ['clinic-flame'],
        limits: { wall_clock_ms: 1000, cpu_ms: 1000, memory_mb: 64, artifact_mb: 4 },
        network: 'disabled',
        input_mounts: [],
        parameters: { iterations: { type: 'integer', min: 1, max: 2, binding: { kind: 'argv', index: 1 } } },
        throughput: { unit: 'ops_per_second', definition: 'completed operations divided by measured seconds' }
      }
    }
  }
}

test('loads, validates and hashes a manifest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-manifest-'))
  const file = path.join(dir, 'profile.json')
  fs.writeFileSync(file, JSON.stringify(fixture()))
  const loaded = loadManifest(file, { trustedRoot: dir })
  t.match(loaded.hash, /^sha256-[a-f0-9]{64}$/)
  t.equal(loaded.hash, hashManifest(loaded.manifest))
  t.same(selectWorkload(loaded.manifest, 'demo').parameters.iterations.min, 1)
  t.end()
})

test('rejects symlinked manifests and unknown workloads', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-manifest-'))
  const real = path.join(dir, 'real.json')
  const link = path.join(dir, 'link.json')
  fs.writeFileSync(real, JSON.stringify(fixture()))
  fs.symlinkSync(real, link)
  t.throws(() => loadManifest(link, { trustedRoot: dir }), /symlink/)
  t.throws(() => selectWorkload(fixture(), 'missing'), { code: 'UNKNOWN_WORKLOAD' })
  t.end()
})

test('rejects invalid manifest semantics', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-manifest-'))
  const file = path.join(dir, 'profile.json')
  const invalid = fixture()
  invalid.profile_workloads.demo.argv = []
  fs.writeFileSync(file, JSON.stringify(invalid))
  t.throws(() => loadManifest(file), error => error.code === 'INVALID_MANIFEST')
  t.end()
})
