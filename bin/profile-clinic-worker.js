#!/usr/bin/env node
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const childProcess = require('node:child_process')
const { collectClinicProfilerDirect } = require('../lib/profile-clinic-collector')

async function main () {
  const [, , inputPath, resultPath] = process.argv
  if (!inputPath || !resultPath) throw new Error('worker input and result paths are required')
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
  const targetCwd = input.options.cwd
  const collectorCwd = path.resolve(input.options.dest)
  const shimPath = path.join(collectorCwd, `.clinic-cwd-${process.pid}.js`)
  try {
    const targetExecutable = path.resolve(input.options.nodePath)
    const targetSpawnCwd = input.profiler === 'clinic-heapprofiler' ? targetCwd : collectorCwd
    const originalSpawn = childProcess.spawn
    childProcess.spawn = function (command, args, options = {}) {
      if (path.resolve(command) === targetExecutable) options = { ...options, cwd: targetSpawnCwd }
      return originalSpawn.call(this, command, args, options)
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
    await fs.writeFile(resultPath, JSON.stringify({ value }), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    await fs.writeFile(resultPath, JSON.stringify({ error: { code: error.code, message: error.message || String(error) } }), { mode: 0o600, flag: 'wx' })
    process.exitCode = 1
  } finally {
    await fs.rm(shimPath, { force: true })
    for (const entry of await fs.readdir(collectorCwd).catch(() => [])) {
      if (/^node_trace\.\d+\.log$/.test(entry)) await fs.rm(path.join(collectorCwd, entry), { force: true })
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
