'use strict'

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawn } = require('child_process')
const { validateWorkloadBindings, validateWorkloadParameters } = require('./profile-semantic-validator')
const { verifyManifestSnapshot } = require('./profile-manifest')
const { pinExecutable, verifyExecutablePin } = require('./profile-executable')
const { openInputMount } = require('./profile-input-mounts')

const DEFAULT_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1000

function opaqueTokenHash (token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function hashReportArtifactReferences (report) {
  if (!report || typeof report !== 'object') return report
  const stored = JSON.parse(JSON.stringify(report))
  for (const artifact of stored.artifacts || []) {
    if (artifact && typeof artifact.ref === 'string') {
      artifact.ref_hash = opaqueTokenHash(artifact.ref)
      delete artifact.ref
    }
  }
  return stored
}

function workloadInputDigest (workload, parameters) {
  const canonicalParameters = Object.fromEntries(Object.entries(parameters || {}).sort(([left], [right]) => left.localeCompare(right)))
  const mounts = (workload.input_mounts || []).map(mount => ({
    source_root: mount.source_root,
    source: mount.source,
    target: mount.target,
    digest: mount.digest
  })).sort((left, right) => left.target.localeCompare(right.target) || left.source_root.localeCompare(right.source_root) || left.source.localeCompare(right.source))
  const value = JSON.stringify({ parameters: canonicalParameters, input_mounts: mounts })
  return `sha256-${crypto.createHash('sha256').update(value).digest('hex')}`
}

function verifyDeclaredInputs (workload, rootDir, declaredInputRoot) {
  const roots = { workspace: rootDir, 'declared-input': declaredInputRoot }
  for (const input of workload.input_mounts || []) {
    const mount = openInputMount(input, roots)
    fs.closeSync(mount.fd)
  }
}

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
      phase: run.phase,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      progress_pct: run.progress_pct,
      exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
      terminationReason: run.terminationReason || run.status
    }
    if (run.report) result.report = run.report
    if (run.artifactRefHash) result.artifactRefHash = run.artifactRefHash
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
        phase: 'queued',
        progress_pct: 0,
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
          run.phase = 'preparing'
          run.progress_pct = 5
          run.startedAt = new Date().toISOString()
          return executeRun({
            ...options,
            runId,
            signal: run.controller.signal,
            onProgress (update) {
              if (!update || typeof update !== 'object') return
              if (typeof update.phase === 'string') run.phase = update.phase
              if (Number.isFinite(update.progress_pct)) {
                run.progress_pct = Math.max(run.progress_pct || 0, Math.min(99, Math.max(0, update.progress_pct)))
              }
            }
          })
        })
        .then(result => {
          const { report, artifactRef, artifactRefHash, ...safeResult } = result || {}
          Object.assign(run, safeResult)
          if (report) run.report = hashReportArtifactReferences(report)
          if (typeof artifactRef === 'string') run.artifactRefHash = opaqueTokenHash(artifactRef)
          else if (typeof artifactRefHash === 'string') run.artifactRefHash = artifactRefHash
          run.runId = runId
          run.status = result && result.status ? result.status : 'completed'
          run.phase = run.status
          if (run.status === 'completed') run.progress_pct = 100
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

async function sha256File (file) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
  try {
    if (!(await handle.stat()).isFile()) throw Object.assign(new Error('artifact entry is not a regular file'), { code: 'ARTIFACT_INVALID' })
    const hash = crypto.createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) hash.update(chunk)
    return `sha256-${hash.digest('hex')}`
  } finally {
    await handle.close()
  }
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
      const input = await fsp.open(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0))
      let output
      try {
        output = await fsp.open(to, 'wx', 0o600)
        const before = await input.stat()
        if (!before.isFile()) throw Object.assign(new Error('artifact entry is not a regular file'), { code: 'ARTIFACT_INVALID' })
        if (bytes + before.size > maxBytes) throw Object.assign(new Error('artifact size limit exceeded'), { code: 'ARTIFACT_LIMIT' })
        let copied = 0
        const buffer = Buffer.alloc(64 * 1024)
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied)
          if (bytesRead === 0) break
          let written = 0
          while (written < bytesRead) {
            const result = await output.write(buffer, written, bytesRead - written, copied + written)
            written += result.bytesWritten
          }
          copied += bytesRead
        }
        const after = await input.stat()
        if (copied !== before.size || after.size !== before.size || before.dev !== after.dev || before.ino !== after.ino) {
          throw Object.assign(new Error('artifact changed while being copied'), { code: 'ARTIFACT_CHANGED' })
        }
        bytes += copied
        await output.sync()
      } finally {
        await Promise.all([input.close(), output && output.close()])
      }
    }
  }
  await syncDirectory(destination)
  return bytes
}

async function syncDirectory (directory) {
  if (process.platform === 'win32') return
  const handle = await fsp.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function exportArtifacts (staging, destination, maxBytes, options = {}) {
  const runRoot = path.dirname(path.dirname(destination))
  await fsp.mkdir(runRoot, { recursive: true, mode: 0o700 })
  const runRootStat = await fsp.lstat(runRoot)
  if (!runRootStat.isDirectory() || runRootStat.isSymbolicLink()) throw Object.assign(new Error('artifact run root must be a real directory'), { code: 'ARTIFACT_INVALID' })
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const realRunRoot = await fsp.realpath(runRoot)
  const realRunDir = await fsp.realpath(path.dirname(destination))
  if (!realRunDir.startsWith(`${realRunRoot}${path.sep}`)) throw Object.assign(new Error('artifact destination escapes run root'), { code: 'ARTIFACT_INVALID' })
  try {
    await fsp.lstat(destination)
    throw Object.assign(new Error('artifact destination already exists'), { code: 'ARTIFACT_EXISTS' })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const stagingRoot = path.join(runRoot, '.staging')
  await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const stagingStat = await fsp.lstat(stagingRoot)
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) throw Object.assign(new Error('artifact staging root must be a real directory'), { code: 'ARTIFACT_INVALID' })
  const temp = path.join(stagingRoot, `artifacts-${process.pid}-${crypto.randomBytes(12).toString('hex')}`)
  let renamed = false
  try {
    const bytes = await copyTree(staging, temp, maxBytes)
    const files = []
    async function collect (dir, relative) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        const rel = path.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw Object.assign(new Error('symlinks are not allowed in artifacts'), { code: 'ARTIFACT_SYMLINK' })
        if (entry.isDirectory()) await collect(file, rel)
        else if (entry.isFile()) {
          const stat = await fsp.lstat(file)
          files.push({ path: rel.replaceAll(path.sep, '/'), size: stat.size, hash: await sha256File(file) })
        }
      }
    }
    await collect(temp, '')
    files.sort((a, b) => a.path.localeCompare(b.path))
    const createdAt = Number.isSafeInteger(options.createdAt) ? options.createdAt : Date.now()
    const retentionMs = Number.isSafeInteger(options.retentionMs) && options.retentionMs > 0 ? options.retentionMs : DEFAULT_ARTIFACT_RETENTION_MS
    const completion = {
      schema_version: 1,
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(createdAt + retentionMs).toISOString(),
      bytes,
      files
    }
    await fsp.writeFile(path.join(temp, 'completion.json'), JSON.stringify(completion) + '\n', { mode: 0o600 })
    const handle = await fsp.open(path.join(temp, 'completion.json'), 'r')
    await handle.sync()
    await handle.close()
    await syncDirectory(temp)
    await fsp.rename(temp, destination)
    renamed = true
    await syncDirectory(path.dirname(destination))
    const verified = await verifyArtifactCompletion(destination)
    if (!verified) throw Object.assign(new Error('artifact completion manifest failed verification'), { code: 'ARTIFACT_INVALID' })
    return completion
  } catch (error) {
    await fsp.rm(temp, { recursive: true, force: true })
    if (renamed) await fsp.rm(destination, { recursive: true, force: true })
    throw error
  }
}

async function verifyArtifactCompletion (artifactDir) {
  try {
    const rootStat = await fsp.lstat(artifactDir)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const manifestPath = path.join(artifactDir, 'completion.json')
    const manifestStat = await fsp.lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) return false
    const manifestHandle = await fsp.open(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    let manifest
    try { manifest = JSON.parse(await manifestHandle.readFile('utf8')) } finally { await manifestHandle.close() }
    const createdAt = manifest && Date.parse(manifest.created_at)
    const expiresAt = manifest && Date.parse(manifest.expires_at)
    if (!manifest || manifest.schema_version !== 1 || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || !Array.isArray(manifest.files)) return false
    const listed = new Map()
    let listedBytes = 0
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || file.path === '' || file.path.includes('\\') || path.posix.isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || !Number.isSafeInteger(file.size) || file.size < 0 || !/^sha256-[a-f0-9]{64}$/.test(file.hash) || listed.has(file.path)) return false
      listed.set(file.path, file)
      listedBytes += file.size
    }
    if (listedBytes !== manifest.bytes) return false
    const actual = []
    async function collect (directory, relative) {
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) throw new Error('artifact contains a symlink')
        if (entry.isDirectory()) await collect(file, rel)
        else if (entry.isFile() && rel !== 'completion.json') {
          const stat = await fsp.lstat(file)
          actual.push({ path: rel, size: stat.size, hash: await sha256File(file) })
        } else if (!entry.isFile()) throw new Error('artifact contains an unsupported entry')
      }
    }
    await collect(artifactDir, '')
    if (actual.length !== listed.size) return false
    for (const file of actual) {
      const expected = listed.get(file.path)
      if (!expected || expected.size !== file.size || expected.hash !== file.hash) return false
    }
    return true
  } catch {
    return false
  }
}

async function recoverArtifactStaging (runRoot) {
  let removed = 0
  let runRootStat
  try { runRootStat = await fsp.lstat(runRoot) } catch (error) {
    if (error.code === 'ENOENT') return removed
    throw error
  }
  if (!runRootStat.isDirectory() || runRootStat.isSymbolicLink()) throw Object.assign(new Error('artifact run root must be a real directory'), { code: 'ARTIFACT_INVALID' })
  const stagingRoot = path.join(runRoot, '.staging')
  let entries
  try { entries = await fsp.readdir(stagingRoot, { withFileTypes: true }) } catch (error) {
    if (error.code === 'ENOENT') return removed
    throw error
  }
  const stagingStat = await fsp.lstat(stagingRoot)
  if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) {
    throw Object.assign(new Error('artifact run and staging roots must be real directories'), { code: 'ARTIFACT_INVALID' })
  }
  for (const entry of entries) {
    const match = entry.name.match(/^artifacts-(\d+)-[a-f0-9]{24}$/)
    if (!entry.isDirectory() || entry.isSymbolicLink() || !match) continue
    const ownerPid = Number(match[1])
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 2) continue
    try {
      process.kill(ownerPid, 0)
      continue
    } catch (error) {
      if (error.code === 'EPERM') continue
      if (error.code !== 'ESRCH') throw error
    }
    await fsp.rm(path.join(stagingRoot, entry.name), { recursive: true, force: true })
    removed++
  }
  return removed
}

async function cleanupExpiredArtifactRuns (runRoot, now = Date.now()) {
  let rootStat
  try { rootStat = await fsp.lstat(runRoot) } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error('artifact run root must be a real directory'), { code: 'ARTIFACT_INVALID' })
  let removed = 0
  for (const runEntry of await fsp.readdir(runRoot, { withFileTypes: true })) {
    if (!runEntry.isDirectory() || runEntry.isSymbolicLink() || !/^run_[A-Za-z0-9_.-]{1,128}$/.test(runEntry.name)) continue
    const runDir = path.join(runRoot, runEntry.name)
    const artifactDir = path.join(runDir, 'artifacts')
    let artifactStat
    try { artifactStat = await fsp.lstat(artifactDir) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) continue
    let manifestStat
    try { manifestStat = await fsp.lstat(path.join(artifactDir, 'completion.json')) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 1024 * 1024) continue
    let manifest
    try {
      const handle = await fsp.open(path.join(artifactDir, 'completion.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      try { manifest = JSON.parse(await handle.readFile('utf8')) } finally { await handle.close() }
    } catch {
      continue
    }
    const createdAt = manifest && Date.parse(manifest.created_at)
    const expiresAt = manifest && Date.parse(manifest.expires_at)
    if (!manifest || manifest.schema_version !== 1 || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt > now) continue
    await fsp.rm(artifactDir, { recursive: true, force: true })
    removed++
    const remaining = await fsp.readdir(runDir)
    if (remaining.length === 0) await fsp.rmdir(runDir)
  }
  return removed
}

function runWorkload (options) {
  const opts = options || {}
  if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
  const rootDir = path.resolve(opts.rootDir || process.cwd())
  const runRoot = path.resolve(opts.runRoot || path.join(rootDir, '.clinic-runs'))
  const workloadKey = opts.workload
  const workload = resolveWorkload(opts.manifest, workloadKey)
  const inputDigest = workloadInputDigest(workload, opts.parameters)
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
  let executable = workload.executable === 'node'
    ? process.execPath
    : path.isAbsolute(workload.executable) ? workload.executable : path.resolve(rootDir, workload.executable)
  executable = fs.realpathSync(executable)
  if (workload.executable === 'node') {
    if (executable !== fs.realpathSync(process.execPath)) throw Object.assign(new Error('configured Node executable does not match the current runtime'), { code: 'EXECUTABLE_CHANGED' })
  } else if (path.isAbsolute(workload.executable)) {
    const runtimeRoot = opts.runtimeRoot && path.resolve(opts.runtimeRoot)
    const realRuntimeRoot = runtimeRoot && fs.realpathSync(runtimeRoot)
    if (!realRuntimeRoot || (executable !== realRuntimeRoot && !executable.startsWith(`${realRuntimeRoot}${path.sep}`))) assertWithin(rootDir, executable, 'executable')
  } else assertWithin(rootDir, executable, 'executable')
  const executablePinPromise = pinExecutable(executable)
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
      const runtimeExecutable = fs.realpathSync(process.execPath)
      const runtimeRoot = path.resolve(opts.runtimeRoot || path.dirname(runtimeExecutable))
      const runtimeRelative = path.relative(runtimeRoot, runtimeExecutable)
      const executablePin = await executablePinPromise
      const executableRuntimeRelative = path.relative(runtimeRoot, executablePin.path)
      const executableWorkspaceRelative = path.relative(rootDir, executablePin.path)
      const isolatedExecutablePath = !executableRuntimeRelative.startsWith('..') && !path.isAbsolute(executableRuntimeRelative)
        ? path.posix.join('/runtime', executableRuntimeRelative.split(path.sep).join('/'))
        : !executableWorkspaceRelative.startsWith('..') && !path.isAbsolute(executableWorkspaceRelative)
            ? path.posix.join('/workspace', executableWorkspaceRelative.split(path.sep).join('/'))
            : null
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
          throughput: workload.throughput,
          executablePin: isolatedExecutablePath ? { ...executablePin, path: isolatedExecutablePath } : null,
          atomicTargetExec: true
        }
      }
      try {
        if (opts.isolationProvider.atomicExec !== true || opts.isolationProvider.atomicTargetExec !== true || opts.isolationProvider.completeInputFilesystem !== true) throw Object.assign(new Error('strict profiling requires atomic worker and target executable selection and a complete declared-input filesystem'), { code: 'ISOLATION_UNAVAILABLE' })
        if (!workerInput.options.executablePin) throw Object.assign(new Error('strict profiling executable is outside the configured runtime and workspace mounts'), { code: 'ISOLATION_UNAVAILABLE' })
        if (runtimeRelative.startsWith('..') || path.isAbsolute(runtimeRelative)) throw Object.assign(new Error('Node runtime is outside the configured runtime root'), { code: 'ISOLATION_UNAVAILABLE' })
        await fsp.mkdir(sandboxDir, { recursive: true, mode: 0o700 })
        if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
        await verifyExecutablePin(executablePin)
        await fsp.writeFile(inputPath, JSON.stringify(workerInput), { mode: 0o600, flag: 'wx' })
        if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'profiling', progress_pct: 25 })
        const isolated = await opts.isolationProvider.run({
          ...opts,
          strict: false,
          workloadDefinition: workload,
          runId,
          executable: process.execPath,
          executablePin,
          args: [],
          cwd,
          env,
          runDir,
          sandboxDir,
          limits: workload.limits,
          signal: opts.signal,
          onProgress: opts.onProgress,
          profileWorker: {
            clinicRoot,
            workerPath: path.join(clinicRoot, 'bin/profile-clinic-worker.js'),
            executablePath: isolatedExecutablePath,
            hostInputPath: inputPath,
            inputPath: '/run/worker-input.json',
            resultPath: '/run/profile/.clinic-worker-result.json',
            outputPath: '/run/worker-output'
          }
        })
        if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('Clinic profiling was cancelled'), { code: 'PROFILE_CANCELLED' })
        if (isolated && isolated.status === 'timed_out') throw Object.assign(new Error('Clinic profiling timed out'), { code: 'PROFILE_TIMEOUT' })
        if (isolated && isolated.status === 'artifact_limit_exceeded') throw Object.assign(new Error('Clinic artifact size limit exceeded during profiling'), { code: 'ARTIFACT_LIMIT' })
        let result = isolated && isolated.workerResult
        if (!result) {
          try {
            result = JSON.parse(await fsp.readFile(resultPath, 'utf8'))
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
        if (result && result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code || 'PROFILE_FAILED' })
        if (!isolated || isolated.status !== 'completed') {
          const details = isolated && [isolated.stderr, isolated.stdout].filter(Boolean).join('\n')
          const exit = isolated ? ` (exit code ${isolated.exitCode}, signal ${isolated.signal || 'none'})` : ''
          throw Object.assign(new Error(`${details || 'isolated profiler failed'}${exit}`), { code: 'PROFILE_FAILED' })
        }
        if (!result) throw Object.assign(new Error('isolated profiler completed without producing a result'), { code: 'PROFILE_FAILED' })
        await fsp.rm(inputPath, { force: true })
        await fsp.rm(resultPath, { force: true })
        if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'exporting', progress_pct: 90 })
        const artifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit, { retentionMs: opts.retentionMs })
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: 'completed',
          startedAt,
          finishedAt,
          exitCode: 0,
          terminationReason: 'completed',
          signal: null,
          stdout: isolated.stdout || '',
          stderr: isolated.stderr || '',
          artifact,
          profile: result.value && result.value.profile,
          measurement: result.value && result.value.measurement,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          inputDigest,
          platform: os.platform(),
          profiler: (result.value && result.value.profiler) || workerInput.profiler
        }
      } catch (error) {
        await Promise.all([fsp.rm(inputPath, { force: true }), fsp.rm(resultPath, { force: true })])
        await fsp.rm(path.join(sandboxDir, 'home'), { recursive: true, force: true })
        let partialArtifact = null
        let partialArtifactRef = null
        try {
          if ((await fsp.readdir(sandboxDir)).length > 0) {
            partialArtifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit, { retentionMs: opts.retentionMs })
            partialArtifactRef = `artifact_${crypto.randomBytes(16).toString('base64url')}`
          }
        } catch {}
        return {
          runId,
          workload: workloadKey,
          status: ['PROFILE_TIMEOUT', 'MEASUREMENT_TIMEOUT'].includes(error.code) ? 'timed_out' : error.code === 'PROFILE_CANCELLED' ? 'cancelled' : 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: null,
          terminationReason: error.code === 'PROFILE_TIMEOUT' || error.code === 'MEASUREMENT_TIMEOUT' ? 'wall_clock_timeout' : error.code === 'PROFILE_CANCELLED' ? 'cancelled' : error.code === 'ARTIFACT_LIMIT' ? 'artifact_limit_exceeded' : 'process_failed',
          signal: null,
          stdout: '',
          stderr: error.message,
          artifact: partialArtifact,
          artifactRef: partialArtifactRef,
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
    verifyDeclaredInputs(workload, rootDir, opts.declaredInputRoot)
    await fsp.mkdir(sandboxDir, { recursive: true, mode: 0o700 })
    const startedAt = new Date().toISOString()
    if (typeof opts.collector === 'function') {
      try {
        if (opts.manifestSource) verifyManifestSnapshot(opts.manifestSource)
        const executablePin = await executablePinPromise
        await verifyExecutablePin(executablePin)
        const collected = await opts.collector({ nodePath: executable, args, cwd, dest: sandboxDir, name: runId, timeoutMs, env, signal: opts.signal, measurement: workload.measurement || null, throughput: workload.throughput, executablePin, onProgress: opts.onProgress })
        if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'exporting', progress_pct: 90 })
        const artifact = await exportArtifacts(collected.artifactDir, path.join(runRoot, runId, 'artifacts'), artifactLimit, { retentionMs: opts.retentionMs })
        const finishedAt = new Date().toISOString()
        return {
          runId,
          workload: workloadKey,
          status: 'completed',
          startedAt,
          finishedAt,
          exitCode: 0,
          terminationReason: 'completed',
          signal: null,
          stdout: '',
          stderr: '',
          artifact,
          profile: collected.profile || null,
          measurement: collected.measurement || null,
          artifactRef: `artifact_${crypto.randomBytes(16).toString('base64url')}`,
          inputDigest,
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
          terminationReason: error.code === 'PROFILE_TIMEOUT' || error.code === 'MEASUREMENT_TIMEOUT' ? 'wall_clock_timeout' : error.code === 'PROFILE_CANCELLED' ? 'cancelled' : 'process_failed',
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
    const executablePin = await executablePinPromise
    await verifyExecutablePin(executablePin)
    if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'profiling', progress_pct: 25 })
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
    if (typeof opts.onProgress === 'function') opts.onProgress({ phase: 'exporting', progress_pct: 90 })
    if (fs.existsSync(sandboxDir)) artifact = await exportArtifacts(sandboxDir, path.join(runRoot, runId, 'artifacts'), artifactLimit, { retentionMs: opts.retentionMs }).catch(error => ({ error: error.code || error.message }))
    const finishedAt = new Date().toISOString()
    return {
      runId,
      workload: workloadKey,
      status: timedOut ? 'timed_out' : opts.signal && opts.signal.aborted ? 'cancelled' : result.code === 0 ? 'completed' : 'failed',
      startedAt,
      finishedAt,
      exitCode: result.code,
      terminationReason: timedOut ? 'wall_clock_timeout' : opts.signal && opts.signal.aborted ? 'cancelled' : result.signal ? 'process_signaled' : result.code === 0 ? 'completed' : 'process_failed',
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
  workloadInputDigest,
  verifyDeclaredInputs,
  runWorkload,
  runProfile: runWorkload,
  start: runWorkload,
  createRunManager,
  exportArtifacts,
  verifyArtifactCompletion,
  recoverArtifactStaging,
  cleanupExpiredArtifactRuns,
  assertWithin
}
