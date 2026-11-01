'use strict'

const test = require('tap').test
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { ProfileMcpServer } = require('../lib/profile-mcp')
const { createRunManager } = require('../lib/profile-runner')

async function createArtifactRun (t) {
  let now = 1000
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-mcp-artifact-'))
  const artifactRef = `artifact_${crypto.randomBytes(16).toString('base64url')}`
  const fileData = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
  const hash = `sha256-${crypto.createHash('sha256').update(fileData).digest('hex')}`
  const server = new ProfileMcpServer({
    workloads: { fibonacci: { profilers: ['clinic-flame'] } },
    artifactRoot,
    now: () => now,
    ttlMs: 100,
    runner: {
      start: async () => ({ status: 'queued', runnerId: 'artifact-runner' }),
      status: async () => ({
        status: 'completed',
        artifactRef,
        artifact: { files: [{ path: 'profiles/flame.bin', size: fileData.length, hash }] },
        report: { run: { status: 'completed' }, artifacts: [{ kind: 'clinic', ref: artifactRef }] }
      })
    }
  })
  const started = await server.call('start_profile_run', { workload: 'fibonacci' })
  t.equal(started.ok, true)
  const artifactDir = path.join(artifactRoot, started.data.run_id, 'artifacts', 'profiles')
  fs.mkdirSync(artifactDir, { recursive: true })
  fs.writeFileSync(path.join(artifactDir, 'flame.bin'), fileData)
  return {
    server,
    artifactRoot,
    artifactRef,
    fileData,
    started: started.data,
    advanceTime: ms => { now += ms }
  }
}

test('lists and reads bounded pages from the authorized run artifact', async t => {
  const fixture = await createArtifactRun(t)
  const credentials = { run_id: fixture.started.run_id, run_capability: fixture.started.run_capability, artifact_ref: fixture.artifactRef }
  const listing = await fixture.server.call('get_profile_artifact', credentials)
  t.equal(listing.ok, true)
  t.same(listing.data.files.map(file => file.path), ['profiles/flame.bin'])
  t.equal(listing.data.files[0].size, fixture.fileData.length)
  const referenceKey = crypto.createHash('sha256').update(fixture.artifactRef).digest('hex')
  const reference = fixture.server.artifactReferences.get(referenceKey)
  for (let index = 0; index < 55; index++) reference.files.set(`extra/${index}.bin`, { size: index, hash: null })
  const firstListingPage = await fixture.server.call('get_profile_artifact', { ...credentials, page_size: 50 })
  t.equal(firstListingPage.data.files.length, 50)
  t.equal(firstListingPage.data.has_more, true)
  const secondListingPage = await fixture.server.call('get_profile_artifact', { ...credentials, offset: firstListingPage.data.next_offset, page_size: 50 })
  t.equal(secondListingPage.data.files.length, 6)

  const first = await fixture.server.call('get_profile_artifact', { ...credentials, path: 'profiles/flame.bin', max_bytes: 10 })
  t.equal(first.ok, true)
  t.equal(Buffer.from(first.data.data, 'base64').toString(), fixture.fileData.subarray(0, 10).toString())
  t.equal(first.data.expected_sha256, `sha256-${crypto.createHash('sha256').update(fixture.fileData).digest('hex')}`)
  t.equal(first.data.next_offset, 10)
  t.equal(first.data.complete, false)

  const second = await fixture.server.call('get_profile_artifact', { ...credentials, path: 'profiles/flame.bin', offset: first.data.next_offset, max_bytes: 10 })
  t.equal(Buffer.from(second.data.data, 'base64').toString(), fixture.fileData.subarray(10, 20).toString())
  t.end()
})

test('run manager retains artifact metadata for the MCP facade', async t => {
  const artifactRef = `artifact_${crypto.randomBytes(16).toString('base64url')}`
  const artifact = { files: [{ path: 'flame.bin', size: 4, hash: 'sha256-' + 'a'.repeat(64) }] }
  const manager = createRunManager(async () => ({ status: 'completed', artifactRef, artifact }))
  await manager.start({ runId: 'run-artifact-metadata' })
  let status
  for (let attempt = 0; attempt < 20; attempt++) {
    status = await manager.status('run-artifact-metadata')
    if (status.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  t.equal(status.status, 'completed')
  t.equal(status.artifactRef, artifactRef)
  t.same(status.artifact, artifact)
  t.end()
})

test('rejects forged, cross-run, and expired artifact references uniformly', async t => {
  const fixture = await createArtifactRun(t)
  const credentials = { run_id: fixture.started.run_id, run_capability: fixture.started.run_capability }
  const forged = await fixture.server.call('get_profile_artifact', { ...credentials, artifact_ref: 'artifact_' + 'A'.repeat(22) })
  t.equal(forged.error.code, 'not_found')

  const crossRun = await fixture.server.call('get_profile_artifact', { ...credentials, run_id: 'another-run', artifact_ref: fixture.artifactRef })
  t.equal(crossRun.error.code, 'not_found')

  fixture.advanceTime(101)
  const expired = await fixture.server.call('get_profile_artifact', { ...credentials, artifact_ref: fixture.artifactRef })
  t.equal(expired.error.code, 'not_found')
  t.end()
})

test('rejects traversal, symlinks, and oversized artifact pages', async t => {
  const fixture = await createArtifactRun(t)
  const credentials = { run_id: fixture.started.run_id, run_capability: fixture.started.run_capability, artifact_ref: fixture.artifactRef }
  const traversal = await fixture.server.call('get_profile_artifact', { ...credentials, path: '../outside.txt' })
  t.equal(traversal.error.code, 'not_found')

  const outside = path.join(fixture.artifactRoot, 'outside.txt')
  fs.writeFileSync(outside, 'secret')
  const artifactDir = path.join(fixture.artifactRoot, fixture.started.run_id, 'artifacts')
  fs.symlinkSync(outside, path.join(artifactDir, 'link.txt'))
  const reference = fixture.server.artifactReferences.get(crypto.createHash('sha256').update(fixture.artifactRef).digest('hex'))
  reference.files.set('link.txt', { size: 6, hash: 'sha256-' + 'a'.repeat(64) })
  const symlink = await fixture.server.call('get_profile_artifact', { ...credentials, path: 'link.txt' })
  t.equal(symlink.error.code, 'not_found')

  const tooLarge = await fixture.server.call('get_profile_artifact', { ...credentials, path: 'profiles/flame.bin', max_bytes: 8001 })
  t.equal(tooLarge.error.code, 'invalid_range')
  t.end()
})
