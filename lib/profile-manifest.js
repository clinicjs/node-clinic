'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { validateWorkloadBindings } = require('./profile-semantic-validator')

function stableStringify (value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalizeManifest (manifest) {
  return stableStringify(manifest)
}

function hashManifest (manifest) {
  return `sha256-${crypto.createHash('sha256').update(canonicalizeManifest(manifest)).digest('hex')}`
}

function freezeJsonSnapshot (value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeJsonSnapshot(child)
  return Object.freeze(value)
}

function assertNoSymlink (filePath) {
  const absolute = path.resolve(filePath)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`manifest path contains symlink: ${current}`)
  }
}

function fileIdentity (stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs == null ? BigInt(Math.trunc(stat.mtimeMs * 1e6)) : stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs == null ? BigInt(Math.trunc(stat.ctimeMs * 1e6)) : stat.ctimeNs)
  }
}

function readPinnedManifest (absolute, maxBytes = 1024 * 1024) {
  assertNoSymlink(absolute)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const fd = fs.openSync(absolute, flags)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile()) throw new Error('manifest path must reference a regular file')
    if (before.size > BigInt(maxBytes)) throw new Error('manifest exceeds the 1 MiB size limit')
    const content = fs.readFileSync(fd, 'utf8')
    const after = fs.fstatSync(fd, { bigint: true })
    if (JSON.stringify(fileIdentity(before)) !== JSON.stringify(fileIdentity(after))) {
      const error = new Error('manifest changed while it was being read')
      error.code = 'MANIFEST_CHANGED'
      throw error
    }
    return { content, identity: fileIdentity(after) }
  } finally {
    fs.closeSync(fd)
  }
}

function validateManifest (manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object']
  if (!manifest.profile_workloads || typeof manifest.profile_workloads !== 'object' || Array.isArray(manifest.profile_workloads)) {
    errors.push('profile_workloads must be an object')
    return errors
  }
  const keys = Object.keys(manifest.profile_workloads)
  if (keys.length === 0) errors.push('profile_workloads must not be empty')
  if (keys.length > 1000) errors.push('profile_workloads must not exceed 1000 entries')
  for (const key of keys) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) errors.push(`invalid workload key: ${key}`)
    const workload = manifest.profile_workloads[key]
    if (!workload || typeof workload.executable !== 'string' || workload.executable.length === 0 || workload.executable.length > 256) errors.push(`${key}: executable must be a non-empty string of at most 256 characters`)
    if (!Array.isArray(workload.profilers) || workload.profilers.length < 1 || workload.profilers.length > 4 || new Set(workload.profilers).size !== workload.profilers.length || workload.profilers.some(profiler => !['clinic-doctor', 'clinic-bubbleprof', 'clinic-flame', 'clinic-heapprofiler'].includes(profiler))) errors.push(`${key}: profilers must be a unique allowlist of supported Clinic profilers`)
    const limits = workload.limits
    if (!limits || !['wall_clock_ms', 'cpu_ms', 'memory_mb', 'artifact_mb'].every(name => Number.isInteger(limits[name]) && limits[name] > 0)) errors.push(`${key}: limits must contain positive wall_clock_ms, cpu_ms, memory_mb, and artifact_mb values`)
    if (workload.network !== 'disabled') errors.push(`${key}: network must be disabled`)
    if (!workload.throughput || typeof workload.throughput.unit !== 'string' || typeof workload.throughput.definition !== 'string' || workload.throughput.unit.length > 128 || workload.throughput.definition.length > 256) errors.push(`${key}: throughput must define bounded unit and definition strings`)
    if (workload.measurement != null) {
      const measurement = workload.measurement
      if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) {
        errors.push(`${key}: measurement must be an object`)
      } else {
        const measurementKeys = ['warmup_runs', 'measured_runs', 'max_wall_clock_ms', 'value_field']
        if (Object.keys(measurement).some(name => !measurementKeys.includes(name))) errors.push(`${key}: measurement contains an unsupported property`)
        if (!Number.isSafeInteger(measurement.warmup_runs) || measurement.warmup_runs < 0 || measurement.warmup_runs > 20) errors.push(`${key}: measurement.warmup_runs must be an integer from 0 to 20`)
        if (!Number.isSafeInteger(measurement.measured_runs) || measurement.measured_runs < 2 || measurement.measured_runs > 30) errors.push(`${key}: measurement.measured_runs must be an integer from 2 to 30`)
        if (!Number.isSafeInteger(measurement.max_wall_clock_ms) || measurement.max_wall_clock_ms < 1 || measurement.max_wall_clock_ms > (limits && limits.wall_clock_ms)) errors.push(`${key}: measurement.max_wall_clock_ms must be within the workload wall-clock limit`)
        if (typeof measurement.value_field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(measurement.value_field)) errors.push(`${key}: measurement.value_field must be a top-level JSON field name`)
      }
    }
    for (const error of validateWorkloadBindings(workload)) errors.push(`${key}: ${error.code}: ${error.message}`)
  }
  return errors
}

function loadManifest (filePath, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('manifest path must be a non-empty string')
  const absolute = path.resolve(filePath)
  if (options.trustedRoot) {
    const root = path.resolve(options.trustedRoot)
    const relative = path.relative(root, absolute)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('manifest path is outside trusted root')
  }
  const pinned = readPinnedManifest(absolute)
  const manifest = JSON.parse(pinned.content)
  const errors = validateManifest(manifest)
  if (errors.length) {
    const error = new Error(`invalid profile manifest: ${errors.join('; ')}`)
    error.code = 'INVALID_MANIFEST'
    error.errors = errors
    throw error
  }
  const hash = hashManifest(manifest)
  freezeJsonSnapshot(manifest)
  return { manifest, path: absolute, hash, identity: pinned.identity, trustedRoot: options.trustedRoot && path.resolve(options.trustedRoot) }
}

function verifyManifestSnapshot (loaded) {
  if (!loaded || typeof loaded.path !== 'string' || !loaded.identity || typeof loaded.hash !== 'string') {
    const error = new Error('manifest snapshot is missing its startup identity')
    error.code = 'INVALID_MANIFEST_SNAPSHOT'
    throw error
  }
  if (loaded.trustedRoot) {
    const relative = path.relative(loaded.trustedRoot, loaded.path)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      const error = new Error('manifest path is outside trusted root')
      error.code = 'MANIFEST_CHANGED'
      throw error
    }
  }
  let current
  try {
    current = readPinnedManifest(loaded.path)
  } catch (cause) {
    const error = new Error(`manifest is no longer available in its startup state: ${cause.message}`)
    error.code = 'MANIFEST_CHANGED'
    error.cause = cause
    throw error
  }
  let manifest
  try {
    manifest = JSON.parse(current.content)
  } catch (cause) {
    const error = new Error('manifest changed after startup and is no longer valid JSON')
    error.code = 'MANIFEST_CHANGED'
    error.cause = cause
    throw error
  }
  if (JSON.stringify(current.identity) !== JSON.stringify(loaded.identity) || hashManifest(manifest) !== loaded.hash) {
    const error = new Error('manifest changed after startup; restart the MCP server to load the reviewed manifest')
    error.code = 'MANIFEST_CHANGED'
    throw error
  }
  const errors = validateManifest(manifest)
  if (errors.length) {
    const error = new Error(`manifest changed after startup and no longer validates: ${errors.join('; ')}`)
    error.code = 'MANIFEST_CHANGED'
    throw error
  }
  return true
}

function selectWorkload (manifest, workloadKey) {
  if (!manifest || !manifest.profile_workloads || !Object.prototype.hasOwnProperty.call(manifest.profile_workloads, workloadKey)) {
    const error = new Error(`unknown profile workload: ${workloadKey}`)
    error.code = 'UNKNOWN_WORKLOAD'
    throw error
  }
  return manifest.profile_workloads[workloadKey]
}

module.exports = { stableStringify, canonicalizeManifest, hashManifest, freezeJsonSnapshot, validateManifest, loadManifest, verifyManifestSnapshot, selectWorkload }
