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

function validateManifest (manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object']
  if (!manifest.profile_workloads || typeof manifest.profile_workloads !== 'object' || Array.isArray(manifest.profile_workloads)) {
    errors.push('profile_workloads must be an object')
    return errors
  }
  const keys = Object.keys(manifest.profile_workloads)
  if (keys.length === 0) errors.push('profile_workloads must not be empty')
  for (const key of keys) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) errors.push(`invalid workload key: ${key}`)
    const workload = manifest.profile_workloads[key]
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
  assertNoSymlink(absolute)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error('manifest path must reference a regular file')
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  const errors = validateManifest(manifest)
  if (errors.length) {
    const error = new Error(`invalid profile manifest: ${errors.join('; ')}`)
    error.code = 'INVALID_MANIFEST'
    error.errors = errors
    throw error
  }
  return { manifest, path: absolute, hash: hashManifest(manifest) }
}

function selectWorkload (manifest, workloadKey) {
  if (!manifest || !manifest.profile_workloads || !Object.prototype.hasOwnProperty.call(manifest.profile_workloads, workloadKey)) {
    const error = new Error(`unknown profile workload: ${workloadKey}`)
    error.code = 'UNKNOWN_WORKLOAD'
    throw error
  }
  return manifest.profile_workloads[workloadKey]
}

module.exports = { stableStringify, canonicalizeManifest, hashManifest, validateManifest, loadManifest, selectWorkload }
