'use strict'

const test = require('tap').test
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createLinuxIsolationProvider, createBubblewrapSupervisor, createSystemdCgroupSupervisor, elfInterpreter } = require('../lib/profile-isolation-provider')
const { pinExecutable } = require('../lib/profile-executable')

test('provider fails closed when no supervisor is configured', async t => {
  const provider = createLinuxIsolationProvider()
  await t.rejects(provider.run({ execute: async () => ({}) }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('provider forwards the strict guarantee contract', async t => {
  let received
  const provider = createLinuxIsolationProvider({
    atomicExec: true,
    atomicTargetExec: true,
    completeInputFilesystem: true,
    supervisor: async context => {
      received = context
      return { status: 'completed' }
    }
  })
  const result = await provider.run({ execute: async () => ({ status: 'completed' }), workload: 'smoke' })
  t.same(result, { status: 'completed' })
  t.equal(received.workload, 'smoke')
  t.equal(received.guarantees.private_network, true)
  t.equal(received.guarantees.atomic_exec, true)
  t.equal(received.guarantees.atomic_target_exec, true)
  t.equal(received.guarantees.complete_input_filesystem, true)
  t.end()
})

test('provider fails closed without atomic executable selection', async t => {
  const provider = createLinuxIsolationProvider({ atomicExec: true, supervisor: async () => ({ status: 'completed' }) })
  await t.rejects(provider.run({ execute: async () => ({ status: 'completed' }) }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('provider fails closed unless it guarantees only declared filesystem inputs', async t => {
  const provider = createLinuxIsolationProvider({
    atomicExec: true,
    atomicTargetExec: true,
    supervisor: async () => ({ status: 'completed' })
  })
  await t.rejects(provider.run({ execute: async () => ({ status: 'completed' }) }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('bubblewrap provider requires cgroup integration', t => {
  const supervisor = createBubblewrapSupervisor({ workspaceRoot: process.cwd(), runtimeRoot: process.execPath })
  t.throws(() => supervisor({ executable: process.execPath, args: [], cwd: process.cwd(), sandboxDir: process.cwd(), limits: { wall_clock_ms: 1 } }), { code: 'ISOLATION_UNAVAILABLE' })
  t.type(createSystemdCgroupSupervisor(), 'function')
  t.end()
})

test('systemd supervisor applies resource limits and can terminate the whole cgroup', t => {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let launch
  let stop
  const supervisor = createSystemdCgroupSupervisor({
    spawnProcess: (command, args, options) => {
      launch = { command, args, options }
      return child
    },
    stopProcess: (command, args, options) => {
      stop = { command, args, options }
      return {}
    }
  })
  const run = supervisor('/usr/bin/bwrap', ['--unshare-net'], {
    runId: 'run-test',
    passFds: [{ fd: 42, targetFd: 4 }],
    limits: { wall_clock_ms: 1000, cpu_ms: 500, memory_mb: 64 }
  })

  t.equal(launch.command, 'systemd-run')
  t.ok(launch.args.includes('--property=MemoryMax=64M'))
  t.ok(launch.args.includes('--property=MemorySwapMax=0'))
  t.ok(launch.args.includes('--property=CPUQuota=50%'))
  t.ok(launch.args.includes('--property=KillMode=control-group'))
  t.ok(launch.args.includes('--property=TasksMax=512'))
  t.equal(launch.args.at(-2), '/usr/bin/bwrap')
  t.equal(launch.options.stdio[3], 'ignore')
  t.equal(launch.options.stdio[4], 42)
  run.terminateTree('TERM')
  t.equal(stop.command, 'systemctl')
  t.ok(stop.args.includes('--kill-whom=all'))
  t.ok(stop.args.includes('--signal=TERM'))
  t.ok(stop.args.at(-1).endsWith('.scope'))
  t.end()
})

test('systemd supervisor rejects limits below its CPU quota resolution', t => {
  const supervisor = createSystemdCgroupSupervisor({ spawnProcess: () => { throw new Error('must not launch') } })
  t.throws(() => supervisor('/usr/bin/bwrap', [], {
    limits: { wall_clock_ms: 1000, cpu_ms: 5, memory_mb: 64 }
  }), { code: 'ISOLATION_UNAVAILABLE' })
  t.end()
})

test('Bubblewrap mounts the pinned worker descriptor before starting it', async t => {
  const pin = await pinExecutable('/usr/bin/id')
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-bwrap-test-'))
  const hostInputPath = path.join(sandboxDir, 'worker-input.json')
  fs.writeFileSync(hostInputPath, '{}', { mode: 0o600 })
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let launch
  const supervisor = createBubblewrapSupervisor({
    workspaceRoot: process.cwd(),
    runtimeRoot: '/usr/bin',
    workerExecutablePin: pin,
    cgroupSupervisor: (command, args, context) => {
      launch = { command, args, context }
      return child
    }
  })
  const run = supervisor({
    executable: pin.path,
    cwd: process.cwd(),
    sandboxDir,
    env: {},
    limits: { wall_clock_ms: 1000, artifact_mb: 1 },
    executablePin: pin,
    workloadDefinition: { argv: [], input_mounts: [] },
    profileWorker: {
      clinicRoot: process.cwd(),
      workerPath: pin.path,
      executablePath: '/runtime/id',
      hostInputPath,
      inputPath: '/run/worker-input.json',
      resultPath: '/run/profile/.clinic-worker-result.json',
      outputPath: '/run/worker-output'
    }
  })
  t.equal(launch.command, 'bwrap')
  const fdMount = launch.args.indexOf('--ro-bind-fd')
  t.ok(fdMount >= 0)
  t.type(Number(launch.args[fdMount + 1]), 'number')
  t.equal(Number.isInteger(Number(launch.args[fdMount + 1])), true)
  t.equal(launch.args[fdMount + 2], '/runtime/id')
  const interpreter = elfInterpreter(pin.path)
  if (interpreter) t.ok(launch.args.includes(interpreter), 'mounts the ELF interpreter at its required path')
  t.equal(launch.context.passFds.length > 0, true)
  t.equal(launch.args.includes('--size'), true)
  t.equal(launch.args[launch.args.indexOf('--size') + 1], String(1024 * 1024))
  t.equal(launch.args.includes('--cap-drop'), true)
  t.equal(launch.args.includes('CAP_SYS_ADMIN'), true)
  t.equal(launch.args.includes('--disable-userns'), true)
  t.equal(launch.args.includes('--assert-userns-disabled'), true)
  t.equal(launch.args.includes('--preserve-fds'), false)
  const outputMount = launch.args.indexOf('--bind-fd')
  t.ok(outputMount >= 0)
  t.equal(launch.args[outputMount + 2], '/run/worker-output')
  const separator = launch.args.indexOf('--')
  t.same(launch.args.slice(separator + 1), ['/runtime/id', '/clinic/bin/profile-clinic-worker.js', '/run/worker-input.json', '/run/profile/.clinic-worker-result.json', '/run/worker-output'])
  const outputFd = fs.openSync(launch.context.transferChannel.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  fs.writeSync(outputFd, `${JSON.stringify({ type: 'file', path: 'artifacts/test.data', size: 6 })}\nclinic${JSON.stringify({ type: 'result', size: 21 })}\n{"value":{"ok":true}}${JSON.stringify({ type: 'done' })}\n`)
  fs.closeSync(outputFd)
  child.emit('close', 0, null)
  const result = await run
  t.equal(result.status, 'completed')
  t.same(result.workerResult, { value: { ok: true } })
  t.equal(fs.readFileSync(path.join(sandboxDir, 'worker-input.json'), 'utf8'), '{}')
  t.equal(fs.readFileSync(path.join(sandboxDir, 'artifacts/test.data'), 'utf8'), 'clinic')
  fs.rmSync(sandboxDir, { recursive: true, force: true })
  t.end()
})

test('Bubblewrap reports and terminates a run that crosses the artifact limit', async t => {
  const pin = await pinExecutable('/usr/bin/id')
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-bwrap-limit-'))
  const hostInputPath = path.join(sandboxDir, 'worker-input.json')
  fs.writeFileSync(hostInputPath, '{}', { mode: 0o600 })
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.terminateTree = signal => {
    if (signal === 'TERM') setImmediate(() => child.emit('close', null, 'SIGTERM'))
  }
  let launch
  const supervisor = createBubblewrapSupervisor({
    workspaceRoot: process.cwd(),
    runtimeRoot: '/usr/bin',
    workerExecutablePin: pin,
    cgroupSupervisor: (command, args, context) => {
      launch = { command, args, context }
      return child
    }
  })
  const run = supervisor({
    executable: pin.path,
    cwd: process.cwd(),
    sandboxDir,
    env: {},
    limits: { wall_clock_ms: 1000, artifact_mb: 1 },
    executablePin: pin,
    workloadDefinition: { argv: [], input_mounts: [] },
    profileWorker: {
      clinicRoot: process.cwd(),
      workerPath: pin.path,
      executablePath: '/runtime/id',
      hostInputPath,
      inputPath: '/run/worker-input.json',
      resultPath: '/run/profile/.clinic-worker-result.json',
      outputPath: '/run/worker-output'
    }
  })
  const outputFd = fs.openSync(launch.context.transferChannel.fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
  fs.writeSync(outputFd, `${JSON.stringify({ type: 'file', path: 'artifacts/large.data', size: 1024 * 1024 + 1 })}\n`)
  fs.closeSync(outputFd)
  const result = await run
  t.equal(result.status, 'artifact_limit_exceeded')
  fs.rmSync(sandboxDir, { recursive: true, force: true })
  t.end()
})
