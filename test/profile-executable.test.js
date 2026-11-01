'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('tap').test
const { pinExecutable, verifyExecutablePin, spawnPinnedExecutable } = require('../lib/profile-executable')

test('pins an executable by real path, file identity, and content hash', async t => {
  const pin = await pinExecutable(process.execPath)
  t.equal(pin.path, fs.realpathSync(process.execPath))
  t.match(pin.hash, /^sha256-[a-f0-9]{64}$/)
  t.equal(await verifyExecutablePin(pin), true)
  t.end()
})

test('launches the pinned executable through descriptor-based exec', async t => {
  if (process.platform !== 'linux') {
    t.skip('descriptor-based exec is Linux-specific')
    t.end()
    return
  }
  const pin = await pinExecutable(process.execPath)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-pinned-exec-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const resultPath = path.join(root, 'result')
  const child = spawnPinnedExecutable('/usr/bin/python3', pin, ['-e', 'require("fs").writeFileSync(process.env.RESULT_PATH, process.argv[1])', 'pinned'], {
    env: { ...process.env, RESULT_PATH: resultPath },
    stdio: ['ignore', 'ignore', 'pipe']
  }, spawn)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  t.equal(result.code, 0, stderr)
  t.equal(fs.readFileSync(resultPath, 'utf8'), 'pinned')
  t.end()
})

test('rejects executable content changes and path replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-executable-pin-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const executable = path.join(root, 'workload')
  const replacement = path.join(root, 'replacement')
  fs.writeFileSync(executable, 'original', { mode: 0o700 })

  const contentPin = await pinExecutable(executable)
  fs.writeFileSync(executable, 'modified', { mode: 0o700 })
  await t.rejects(verifyExecutablePin(contentPin), { code: 'EXECUTABLE_CHANGED' })

  const replacementPin = await pinExecutable(executable)
  fs.writeFileSync(replacement, 'replacement', { mode: 0o700 })
  fs.renameSync(replacement, executable)
  await t.rejects(verifyExecutablePin(replacementPin), { code: 'EXECUTABLE_CHANGED' })
  t.end()
})

test('descriptor launch rejects replacement with identical bytes but a different file identity', async t => {
  if (process.platform !== 'linux') {
    t.skip('descriptor-based exec is Linux-specific')
    t.end()
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-executable-identity-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const executable = path.join(root, 'workload')
  const replacement = path.join(root, 'replacement')
  fs.copyFileSync('/usr/bin/id', executable)
  fs.chmodSync(executable, 0o755)
  const pin = await pinExecutable(executable)
  fs.copyFileSync(executable, replacement)
  fs.chmodSync(replacement, 0o755)
  fs.renameSync(replacement, executable)

  t.throws(() => spawnPinnedExecutable('/usr/bin/python3', pin, [], { stdio: ['ignore', 'ignore', 'pipe'] }, spawn), { code: 'EXECUTABLE_CHANGED' })
  t.end()
})

test('descriptor launch never executes the replacement at a replaced path', async t => {
  if (process.platform !== 'linux') {
    t.skip('descriptor-based exec is Linux-specific')
    t.end()
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-executable-race-'))
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }))
  const executable = path.join(root, 'workload')
  const replacement = path.join(root, 'replacement')
  fs.copyFileSync('/usr/bin/id', executable)
  fs.chmodSync(executable, 0o755)
  const pin = await pinExecutable(executable)
  fs.copyFileSync('/usr/bin/true', replacement)
  fs.chmodSync(replacement, 0o755)

  const child = spawnPinnedExecutable('/usr/bin/python3', pin, ['-u'], { stdio: ['ignore', 'pipe', 'pipe'] }, (command, args, options) => {
    fs.renameSync(replacement, executable)
    return spawn(command, args, options)
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  if (result.code === 0) {
    t.equal(stdout.trim(), String(process.getuid()), 'the pinned executable ran')
    t.equal(stderr, '')
  } else {
    t.equal(stdout, '', 'the replacement did not run')
    t.match(stderr, /FileNotFoundError/, 'the unlinked descriptor failed closed')
  }
  t.end()
})
