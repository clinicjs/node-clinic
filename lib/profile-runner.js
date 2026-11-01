'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawn } = require('child_process')
const { validateWorkloadBindings, validateWorkloadParameters } = require('./profile-semantic-validator')
const { verifyManifestSnapshot } = require('./profile-manifest')

function createRunId () {
  return `run_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(8).toString('hex')}`
}

function createRunManager (executeRun, options = {}) {
  if (typeof executeRun !== 'function') throw new TypeError('executeRun must be a function')
  const runs = new Map()
  const maxConcurrent = Number.isInteger(options.maxConcurrent) && options.maxConcurrent > 0 ? options.maxConcurrent : 1
  const maxStoredRuns = Number.isInteger(options.maxStoredRuns) && options.maxStoredRuns > 0 ? options.maxStoredRuns : 100
  const retentionMs = Number.isInteger(options.retentionMs) && options.retentionMs > 0 ? options.retentionMs : 24 * 60 * 60 * 1000

  function pruneRuns () {
    const cutoff = Date.now() - retentionMs
    for (const [runId, run] of runs) {
      if (run.finishedAt && Date.parse(run.finishedAt) <= cutoff) runs.delete(runId)
    }
  }

  function publicRun (run) {
    const result = {
      runId: run.runId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      progress_pct: run.progress_pct
    }
    if (run.report) result.report = run.report
    if (run.artifactRef) result.artifactRef = run.artifactRef
    if (run.artifact) result.artifact = run.artifact
    if (run.error) result.error = run.error
    return result
  }

  return {
    start (options) {
      pruneRuns()
      const active = [...runs.values()].filter(run => !['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)).length
      if (active >= maxConcurrent || runs.size >= maxStoredRuns) {
        const error = new Error(active >= maxConcurrent ? 'maximum concurrent profile runs reached' : 'profile run retention limit reached')
        error.code = 'RUN_LIMIT'
        throw error
      }
      const runId = options.runId || createRunId()
      if (runs.has(runId)) throw new Error(`run already exists: ${runId}`)
      const run = {
        runId,
        status: 'queued',
        createdAt: new Date().toISOString(),
        controller: new AbortController()
      }
      runs.set(runId, run)
      run.promise = new Promise(resolve => setImmediate(resolve))
        .then(async () => {
          if (run.controller.signal.aborted) {
            return {
              runId,
              status: 'cancelled',
              error: {
                code: 'PROFILE_CANCELLED',
                message: 'Profile run was cancelled before it started',
                retryable: false
              }
            }
          }
          run.status = 'running'
          run.startedAt = new Date().toISOString()
          return executeRun({ ...options, runId, signal: run.controller.signal })
        })
        .then(result => {
          Object.assign(run, result || {})
          run.runId = runId
          run.status = result && result.status ? result.status : 'completed'
          run.finishedAt = run.finishedAt || new Date().toISOString()
          return publicRun(run)
        })
        .catch(error => {
          run.status = run.controller.signal.aborted ? 'cancelled' : 'failed'
          run.error = { code: error.code || 'PROFILE_FAILED', message: error.message || String(error), retryable: false }
          run.finishedAt = new Date().toISOString()
          return publicRun(run)
        })
      return Promise.resolve({ runId, status: 'queued' })
    },

    async status (runId) {
      const run = runs.get(runId)
      return run ? publicRun(run) : null
    },

    async cancel (runId) {
      const run = runs.get(runId)
      if (!run) return null
      if (['completed', 'failed', 'timed_out', 'cancelled', 'partial'].includes(run.status)) return publicRun(run)
      run.controller.abort()
      return run.promise
    }
  }
}

function sha256File (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(`sha256-${hash.digest('hex')}`))
  })
}

function assertWithin (root, candidate, label) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    const error = new Error(`${label} escapes allowed root`)
    error.code = 'PATH_OUTSIDE_ROOT'
    throw error
  }
  return resolved
}

function resolveWorkload (manifest, workloadKey) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('manifest must be an object')
  const workloads = manifest.profile_workloads
  if (!workloads || !Object.prototype.hasOwnProperty.call(workloads, workloadKey)) {
    const error = new Error(`unknown workload: ${workloadKey}`)
    error.code = 'UNKNOWN_WORKLOAD'
    throw error
  }
  const workload = workloads[workloadKey]
  const errors = validateWorkloadBindings(workload)
  if (errors.length) {
    const error = new Error(`invalid workload: ${errors.map(item => item.message).join('; ')}`)
    error.code = 'INVALID_WORKLOAD'
    error.validationErrors = errors
    throw error
  }
  return workload
}

async function copyTree (source, destination, maxBytes) {
  let bytes = 0
  await fsp.mkdir(destination, { recursive: true })
  const entries = await fsp.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) throw Object.assign(new Error('symlinks are not allowed in artifacts'), { code: 'ARTIFACT_SYMLINK' })
    if (entry.isDirectory()) {
      bytes += await copyTree(from, to, maxBytes - bytes)
    } else if (entry.isFile()) {
      const stat = await fsp.stat(from)
      bytes += stat.size
      if (bytes > maxBytes) throw Object.assign(new Error('artifact size limit exceeded'), { code: 'ARTIFACT_LIMIT' })
      await fsp.copyFile(from, to)
    }
  }
  return bytes
}

async function exportArtifacts (staging, destination, maxBytes) {
  await fsp.rm(destination, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const temp = `${destination}.staging-${crypto.randomBytes(6).toString('hex')}`
  try {
    const bytes = await copyTree(staging, temp, maxBytes)
    const files = []
    async function collect (dir, relative) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        const rel = path.join(relative, entry.name)
        if (entry.isDirectory()) await collect(file, rel)
        else if (entry.isFile()) files.push({ path: rel.replaceAll(path.sep, '/'), size: (await fsp.stat(file)).size, hash: await sha256File(file) })
      }
    }
    await collect(temp, '')
    const completion = { schema_version: 1, bytes, files }
    await fsp.writeFile(path.join(temp, 'completion.json'), JSON.stringify(completion) + '\n', { mode: 0o600 })
    const handle = await fsp.open(path.join(temp, 'completion.json'), 'r')
    await handle.sync()
    await handle.close()
    await fsp.rename(temp, destination)
    return completion
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true })
    throw error
  }
}

function runWorkload (options) {
  const opts = options || {}
  if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
  const rootDir = path.resolve(opts.rootDir || process.cwd())
  const runRoot = path.resolve(opts.runRoot || path.join(rootDir, '.clinic-runs'))
  const workloadKey = opts.workload
  const workload = resolveWorkload(opts.manifest, workloadKey)
  const parameterErrors = validateWorkloadParameters(workload, opts.parameters)
  if (parameterErrors.length) {
    const error = new Error(`invalid workload parameters: ${parameterErrors.map(item => `${item.path}: ${item.message}`).join('; ')}`)
    error.code = 'INVALID_PARAMETERS'
    error.validationErrors = parameterErrors
    return Promise.reject(error)
  }
  if (opts.strict && (!opts.isolationProvider || typeof opts.isolationProvider.run !== 'function')) {
    const error = new Error('strict profiling runs require a configured isolation provider with run()')
    error.code = 'ISOLATION_UNAVAILABLE'
    return Promise.reject(error)
  }
  if (process.platform !== 'linux' && !opts.isolationProvider) {
    const error = new Error('profiling runs require Linux or an isolation provider')
    error.code = 'ISOLATION_UNAVAILABLE'
    return Promise.reject(error)
  }
  const runId = opts.runId || createRunId()
  const cwd = assertWithin(rootDir, path.join(rootDir, workload.cwd.replace(/^\/workspace\/?/, '')), 'cwd')
  const executable = workload.executable === 'node'
    ? process.execPath
    : path.isAbsolute(workload.executable) ? workload.executable : path.resolve(rootDir, workload.executable)
  if (workload.executable === 'node') {
    // The configured Node runtime is resolved to the current trusted executable.
  } else if (path.isAbsolute(workload.executable)) {
    const runtimeRoot = opts.runtimeRoot && path.resolve(opts.runtimeRoot)
    if (!runtimeRoot || (path.resolve(executable) !== runtimeRoot && !path.resolve(executable).startsWith(`${runtimeRoot}${path.sep}`))) assertWithin(rootDir, executable, 'executable')
  } else assertWithin(rootDir, executable, 'executable')
  const args = workload.argv.map(argument => argument
    .replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, (_, name) => String(opts.parameters && opts.parameters[name]))
    .replace(/^\/workspace(?:\/|$)/, `${rootDir}${path.sep}`))
  const env = {}
  for (const name of workload.env_allowlist || []) if (Object.prototype.hasOwnProperty.call(opts.env || {}, name)) env[name] = String(opts.env[name])
  const runDir = path.join(runRoot, runId)
  const sandboxDir = path.join(runDir, '.sandbox-artifacts')
  const timeoutMs = workload.limits.wall_clock_ms
  const artifactLimit = workload.limits.artifact_mb * 1024 * 1024

  if (opts.strict && typeof opts.collector === 'function') {
    return (async () => {
      const startedAt = new Date().toISOString()
      const inputPath = path.join(sandboxDir, `.clinic-worker-${crypto.randomBytes(8).toString('hex')}.json`)
      const resultPath = `${inputPath}.result`
      const runtimeRoot = path.resolve(opts.runtimeRoot || path.dirname(process.execPath))
      const runtimeRelative = path.relative(runtimeRoot, process.execPath)
      const clinicRoot = path.resolve(opts.clinicRoot || path.join(__dirname, '..'))
      const workspaceRelative = path.relative(rootDir, cwd)
      const containerArgs = args.map(argument => {
        if (!path.isAbsolute(argument)) return argument
        const absolute = path.resolve(argument)
        const relative = path.relative(rootDir, absolute)
        return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
          ? argument
          : path.posix.join('/workspace', relative.split(path.sep).join('/'))
      })
      const workerInput = {
        profiler: opts.profiler || 'clinic-flame',
        options: {
          nodePath: path.posix.join('/runtime', runtimeRelative.split(path.sep).join('/')),
          args: containerArgs,
          cwd: path.posix.join('/workspace', workspaceRelative.split(path.sep).join('/')),
          dest: '/run/profile',
          name: runId,
          timeoutMs,
          env: { PATH: '/runtime:/usr/bin:/bin', ...env },
          measurement: workload.measurement || null,
          throughput: workload.throughput
        }
      }
      try {
        if (opts.isolationProvider.atomicExec !== true) throw Object.assign(new Error('strict profiling requires a provider with atomic executable selection'), { code: 'ISOLATION_UNAVAILABLE' })
        if (runtimeRelative.startsWith('..') || path.isAbsolute(runtimeRelative)) throw Object.assign(new Error('Node runtime is outside the configured runtime root'), { code: 'ISOLATION_UNAVAILABLE' })
        await fsp.mkdir(sandboxDir, { recursive: true, mode: 0o700 })
        if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
        await fsp.writeFile(inputPath, JSON.stringify(workerInput), { mode: 0o600, flag: 'wx' })
        const isolated = await opts.isolationProvider.run({
          ...opts,
          strict: false,
          workloadDefinition: workload,
          runId,
          executable: process.execPath,
          args: [],
          cwd,
          env,
          runDir,
          sandboxDir,
          limits: workload.limits,
          signal: opts.signal,
          profileWorker: {
            clinicRoot,
            workerPath: path.join(clinicRoot, 'bin/profile-clinic-worker.js'),
            inputPath: `/run/profile/${path.basename(inputPath)}`,
            resultPath: `/run/profile/${path.basename(resultPath)}`
          }
        })
        if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Clinic profiling was cancelled'), { code: 'PROFILE_CANCELLED' })
        if (isolated && isolated.status === 'timed_out') throw Object.assign(new Error('Clinic profiling timed out'), { code: 'PROFILE_TIMEOUT' })
        const result = JSON.parse(await fsp.readFile(resultPath, 'utf8'))
        if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code || 'PROFILE_FAILED' })
        if (!isolated || isolated.status !== 'completed') throw Object.assign(new Error((isolated && isolated.stderr) || 'isolated profiler failed'), { code: 'PROFILE_FAILED' })
        await fsp.rm(inputPath, { force: true })
        await fsp.rm(resultPath, { force: true })
        const artifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit)
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: 'completed',
          startedAt,
          finishedAt,
          exitCode: 0,
          signal: null,
          stdout: isolated.stdout || '',
          stderr: isolated.stderr || '',
          artifact,
          profile: result.value && result.value.profile,
          measurement: result.value && result.value.measurement,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          profiler: (result.value && result.value.profiler) || workerInput.profiler
        }
      } catch (error) {
        await Promise.all([fsp.rm(inputPath, { force: true }), fsp.rm(resultPath, { force: true })])
        return {
          runId,
          workload: workloadKey,
          status: ['PROFILE_TIMEOUT', 'MEASUREMENT_TIMEOUT'].includes(error.code) ? 'timed_out' : error.code === 'PROFILE_CANCELLED' ? 'cancelled' : 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: error.message,
          artifact: null,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          profiler: workerInput.profiler,
          error: { code: error.code || 'PROFILE_FAILED', message: error.message, retryable: ['PROFILE_TIMEOUT', 'MEASUREMENT_TIMEOUT'].includes(error.code) }
        }
      }
    })()
  }

  if (opts.strict) {
    return Promise.resolve(opts.isolationProvider.run({
      ...opts,
      strict: false,
      workloadDefinition: workload,
      runId,
      executable,
      args,
      cwd,
      env,
      runDir,
      sandboxDir,
      limits: workload.limits,
      execute: () => runWorkload({ ...opts, strict: false, isolationProvider: null })
    }))
  }

  return (async () => {
    await fsp.mkdir(sandboxDir, { recursive: true, mode: 0o700 })
    const startedAt = new Date().toISOString()
    if (typeof opts.collector === 'function') {
      try {
        if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
        const collected = await opts.collector({ nodePath: executable, args, cwd, dest: sandboxDir, name: runId, timeoutMs, env, signal: opts.signal, measurement: workload.measurement || null, throughput: workload.throughput })
        const artifact = await exportArtifacts(collected.artifactDir, path.join(runRoot, runId, 'artifacts'), artifactLimit)
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: 'completed',
          startedAt,
          finishedAt,
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: '',
          artifact,
          profile: collected.profile || null,
          measurement: collected.measurement || null,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          profiler: collected.profiler || 'clinic-flame'
        }
      } catch (error) {
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: ['PROFILE_TIMEOUT', 'MEASUREMENT_TIMEOUT'].includes(error.code) ? 'timed_out' : error.code === 'PROFILE_CANCELLED' ? 'cancelled' : 'failed',
          startedAt,
          finishedAt,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: error.message,
          artifact: null,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          error: { code: error.code || 'PROFILE_FAILED', message: error.message, retryable: ['PROFILE_TIMEOUT', 'MEASUREMENT_TIMEOUT'].includes(error.code) }
        }
      }
    }
    if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
    const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data.toString() })
    child.stderr.on('data', data => { stderr += data.toString() })
    let timedOut = false
    const onAbort = () => {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 250)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 250)
    }, timeoutMs)
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }).finally(() => {
      clearTimeout(timer)
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
    })
    let artifact = null
    if (fs.existsSync(sandboxDir)) artifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit).catch(error => ({ error: error.code || error.message }))
    const finishedAt = new Date().toISOString()
    return {
      runId,
      workload: workloadKey,
      status: timedOut ? 'timed_out' : opts.signal && opts.signal.aborted ? 'cancelled' : result.code === 0 ? 'completed' : 'failed',
      startedAt,
      finishedAt,
      exitCode: result.code,
      signal: result.signal,
      stdout,
      stderr,
      artifact,
      artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
      platform: os.platform()
    }
  })()
}

module.exports = {
  createRunId,
  resolveWorkload,
  runWorkload,
  runProfile: runWorkload,
  start: runWorkload,
  createRunManager,
  exportArtifacts,
  assertWithin
}
