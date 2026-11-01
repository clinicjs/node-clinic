#!/usr/bin/env node
'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const { runMeasurementPlan } = require('../lib/profile-measurement')
const { verifyExecutablePin } = require('../lib/profile-executable')

const MAX_RESULT_BYTES = 16 * 1024 * 1024

function writeAll (fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let offset = 0
  while (offset < buffer.length) offset += fsSync.writeSync(fd, buffer, offset, buffer.length - offset)
}

async function sendProfileOutput (root, outputPath, result) {
  const fd = fsSync.openSync(outputPath, fsSync.constants.O_WRONLY)
  function sendHeader (header) {
    writeAll(fd, `${JSON.stringify(header)}\n`)
  }
  async function sendDirectory (directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error('profile output contains a symlink')
      if (entry.isDirectory()) {
        await sendDirectory(file, name)
        continue
      }
      const stat = await fs.lstat(file)
      if (!stat.isFile()) throw new Error('profile output contains a non-regular file')
      sendHeader({ type: 'file', path: name, size: stat.size })
      const stream = fsSync.createReadStream(file)
      for await (const chunk of stream) writeAll(fd, chunk)
    }
  }

  try {
    await sendDirectory(root)
    let encoded = Buffer.from(JSON.stringify(result))
    if (encoded.length > MAX_RESULT_BYTES) {
      encoded = Buffer.from(JSON.stringify({ error: { code: 'PROFILE_RESULT_TOO_LARGE', message: 'normalized profile data exceeds the worker transfer limit' } }))
    }
    sendHeader({ type: 'result', size: encoded.length })
    writeAll(fd, encoded)
    sendHeader({ type: 'done' })
  } finally {
    fsSync.closeSync(fd)
  }
}

async function main () {
  const [, , inputPath, resultPath, outputPath] = process.argv
  if (!inputPath || !resultPath) throw new Error('worker input and result paths are required')
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  const targetCwd = input.options.cwd
  const collectorCwd = path.resolve(input.options.dest)
  const shimPath = path.join(collectorCwd, `.clinic-cwd-${process.pid}.js`)
  // In strict mode the supervisor mounts the already-open, pinned executable
  // descriptor read-only. Inside a user namespace, uid/gid metadata can be
  // translated, so re-reading the path would reject the same immutable inode.
  const verifyTargetExecutable = input.options.executablePin && input.options.atomicTargetExec !== true
    ? () => verifyExecutablePin(input.options.executablePin)
    : async () => {}
  const reportProgress = progress => {
    if (typeof process.send !== 'function') return
    try { process.send({ type: 'profile_progress', progress }) } catch {}
  }
  const targetExecutable = path.resolve(input.options.nodePath)
  const originalSpawn = childProcess.spawn
  const atomicTargetExec = input.options.atomicTargetExec === true
  const spawnTarget = (command, args, options) => {
    if (atomicTargetExec && path.resolve(command) === targetExecutable) {
      return originalSpawn.call(childProcess, command, args || [], options)
    }
    return originalSpawn.call(childProcess, command, args, options)
  }
  const cancellation = new AbortController()
  const hasThroughputSample = Boolean(input.options.measurement || (input.options.throughput && input.options.throughput.value_field))
  const onTerminate = () => cancellation.abort()
  process.once('SIGTERM', onTerminate)
  process.once('SIGINT', onTerminate)
  let result
  try {
    await verifyTargetExecutable()
    if (hasThroughputSample) reportProgress({ phase: 'measuring', progress_pct: 10 })
    else reportProgress({ phase: 'profiling', progress_pct: 25 })
    const measurement = await runMeasurementPlan({
      nodePath: input.options.nodePath,
      args: input.options.args,
      cwd: targetCwd,
      env: input.options.env,
      signal: cancellation.signal,
      beforeSpawn: verifyTargetExecutable,
      onProgress: reportProgress,
      spawnProcess: atomicTargetExec ? spawnTarget : undefined
    }, input.options.measurement, input.options.throughput)
    await verifyTargetExecutable()
    reportProgress({ phase: 'profiling', progress_pct: hasThroughputSample ? 45 : 50 })
    const { collectClinicProfilerDirect } = require('../lib/profile-clinic-collector')
    const targetSpawnCwd = input.profiler === 'clinic-heapprofiler' ? targetCwd : collectorCwd
    childProcess.spawn = function (command, args, options = {}) {
      if (path.resolve(command) === targetExecutable) options = { ...options, cwd: targetSpawnCwd }
      return spawnTarget(command, args, options)
    }
    process.chdir(collectorCwd)
    if (input.profiler === 'clinic-heapprofiler') {
      process.chdir(targetCwd)
    } else {
      await fs.writeFile(shimPath, `process.chdir(${JSON.stringify(targetCwd)})\n`, { mode: 0o600, flag: 'wx' })
      const tracePattern = path.join(collectorCwd, 'node_trace.%pid.log')
      process.env.NODE_OPTIONS = [
        process.env.NODE_OPTIONS,
        `--trace-event-file-pattern=${JSON.stringify(tracePattern)}`,
        '--require',
        JSON.stringify(shimPath)
      ].filter(Boolean).join(' ')
    }
    const value = await collectClinicProfilerDirect(input.profiler, input.options)
    reportProgress({ phase: 'analyzing', progress_pct: 85 })
    result = { value: { ...value, measurement } }
  } catch (error) {
    result = { error: { code: error.code, message: error.message || String(error) } }
    process.exitCode = 1
  } finally {
    process.removeListener('SIGTERM', onTerminate)
    process.removeListener('SIGINT', onTerminate)
    await fs.rm(shimPath, { force: true })
    for (const entry of await fs.readdir(collectorCwd).catch(() => [])) {
      if (/^node_trace\.\d+\.log$/.test(entry)) await fs.rm(path.join(collectorCwd, entry), { force: true })
    }
  }
  if (typeof outputPath === 'string' && outputPath.startsWith('/run/')) {
    await sendProfileOutput(collectorCwd, outputPath, result)
  } else {
    await fs.writeFile(resultPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' })
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
