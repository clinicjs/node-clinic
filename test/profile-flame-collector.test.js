'use strict'

const test = require('tap').test
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { collectClinicFlame, analyzeFlameArtifact } = require('../lib/profile-flame-collector')
const proxyquire = require('proxyquire').noCallThru()

test('collector validates required inputs before invoking Clinic', t => {
  t.throws(() => collectClinicFlame({}), /nodePath is required/)
  t.throws(() => collectClinicFlame({ nodePath: process.execPath }), /args must be an array/)
  t.end()
})

test('artifact analysis rejects incomplete Clinic output', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-flame-artifact-'))
  await t.rejects(analyzeFlameArtifact(dir), { code: 'PROFILE_NO_DATA' })
  t.end()
})

test('artifact analysis preserves Flame hierarchy with stable internal node IDs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-flame-tree-'))
  t.teardown(() => fs.rm(dir, { recursive: true, force: true }))
  await fs.writeFile(path.join(dir, 'run.clinic-flame-samples'), '[]')
  await fs.writeFile(path.join(dir, 'run.clinic-flame-systeminfo'), '{}')
  await fs.writeFile(path.join(dir, 'run.clinic-flame-inlinedfunctions'), '{}')
  const flameAnalysis = proxyquire('../lib/profile-flame-collector', {
    '@clinic/flame': class {},
    '@clinic/flame/analysis': async () => ({
      merged: {
        name: 'root',
        onStack: 10,
        onStackTop: { base: 0 },
        children: [{
          functionName: 'work',
          fullFileName: 'work.js',
          lineNumber: 4,
          onStack: 10,
          onStackTop: { base: 3 },
          children: [{ functionName: 'leaf', onStack: 4, onStackTop: { base: 2 }, children: [] }]
        }]
      }
    })
  })
  const profile = await flameAnalysis.analyzeFlameArtifact(dir)
  t.equal(profile.nodes.length, 2)
  t.equal(profile.nodes[0].name, 'work')
  t.equal(profile.nodes[0].node_id, profile.call_tree.children[0].node_id)
  t.equal(profile.call_tree.children[0].children[0].name, 'leaf')
  t.end()
})
