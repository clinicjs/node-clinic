'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawn } = require('child_process')
const { validateWorkloadBindings } = require('./profile-semantic-validator')

function createRunId () {
  return `run_${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomBytes(8).toString('hex')}`
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
  const rootDir = path.resolve(opts.rootDir || process.cwd())
  const runRoot = path.resolve(opts.runRoot || path.join(rootDir, '.clinic-runs'))
  const workloadKey = opts.workload
  const workload = resolveWorkload(opts.manifest, workloadKey)
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
        const collected = await opts.collector({ nodePath: executable, args, dest: sandboxDir, name: runId, timeoutMs })
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
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          profiler: collected.profiler || 'clinic-flame'
        }
      } catch (error) {
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: error.code === 'PROFILE_TIMEOUT' ? 'timed_out' : 'failed',
          startedAt,
          finishedAt,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: error.message,
          artifact: null,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          platform: os.platform(),
          error: { code: error.code || 'PROFILE_FAILED', message: error.message, retryable: error.code === 'PROFILE_TIMEOUT' }
        }
      }
    }
    const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data.toString() })
    child.stderr.on('data', data => { stderr += data.toString() })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 250)
    }, timeoutMs)
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }).finally(() => clearTimeout(timer))
    let artifact = null
    if (fs.existsSync(sandboxDir)) artifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit).catch(error => ({ error: error.code || error.message }))
    const finishedAt = new Date().toISOString()
    return {
      runId,
      workload: workloadKey,
      status: timedOut ? 'timed_out' : result.code === 0 ? 'completed' : 'failed',
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
  exportArtifacts,
  assertWithin
}
