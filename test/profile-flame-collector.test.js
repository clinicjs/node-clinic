'use strict'

const test = require('tap').test
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { collectClinicFlame, analyzeFlameArtifact } = require('../lib/profile-flame-collector')

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
