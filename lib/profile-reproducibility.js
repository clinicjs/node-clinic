'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function commandOutput (args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 })
  return result.status === 0 ? result.stdout.trim() : null
}

function readRepositoryMetadata (root) {
  const revision = commandOutput(['rev-parse', 'HEAD'], root)
  const status = commandOutput(['status', '--porcelain', '--untracked-files=all'], root)
  const remote = commandOutput(['config', '--get', 'remote.origin.url'], root)
  return {
    revision: status === '' && revision && /^[a-f0-9]{40,64}$/.test(revision) ? revision : null,
    identity: remote ? `sha256-${crypto.createHash('sha256').update(remote).digest('hex')}` : null
  }
}

function dependencyFileIdentity (stat) {
  return ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(stat[key] == null ? stat[key.replace('Ns', 'Ms')] : stat[key])).join(':')
}

function hashExecutable (filePath) {
  return new Promise(resolve => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => resolve(null))
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(`sha256-${hash.digest('hex')}`))
  })
}

async function hashDependencyTree (rootPath) {
  const requestedRoot = path.resolve(rootPath)
  const requestedRootStat = await fs.promises.lstat(requestedRoot)
  if (!requestedRootStat.isDirectory() || requestedRootStat.isSymbolicLink()) throw new Error('dependency root must be a real directory')
  const root = await fs.promises.realpath(requestedRoot)
  const rootStat = await fs.promises.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('dependency root must be a real directory')
  const hash = crypto.createHash('sha256')
  const entries = []
  const buffer = Buffer.allocUnsafe(1024 * 1024)

  async function walk (directory, relativeDirectory) {
    const children = await fs.promises.readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
      const stat = await fs.promises.lstat(absolute, { bigint: true })
      if (stat.isSymbolicLink()) {
        const resolved = await fs.promises.realpath(absolute)
        const fromRoot = path.relative(root, resolved)
        if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) throw new Error(`dependency symlink escapes installed tree: ${relative}`)
        const target = await fs.promises.readlink(absolute)
        const after = await fs.promises.lstat(absolute, { bigint: true })
        if (dependencyFileIdentity(stat) !== dependencyFileIdentity(after)) throw new Error(`dependency symlink changed while being hashed: ${relative}`)
        entries.push({ relative, kind: 'symlink', target })
      } else if (stat.isDirectory()) {
        entries.push({ relative, kind: 'directory' })
        await walk(absolute, relative)
      } else if (stat.isFile()) {
        const fileHash = crypto.createHash('sha256')
        const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
        try {
          const before = await handle.stat({ bigint: true })
          if (!before.isFile() || dependencyFileIdentity(stat) !== dependencyFileIdentity(before)) throw new Error(`dependency file changed while being opened: ${relative}`)
          let offset = 0
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
            if (bytesRead === 0) break
            fileHash.update(buffer.subarray(0, bytesRead))
            offset += bytesRead
          }
          const after = await handle.stat({ bigint: true })
          if (dependencyFileIdentity(before) !== dependencyFileIdentity(after)) throw new Error(`dependency file changed while being hashed: ${relative}`)
          entries.push({ relative, kind: 'file', mode: String(after.mode), size: String(after.size), digest: fileHash.digest('hex') })
        } finally {
          await handle.close()
        }
      } else {
        throw new Error(`unsupported filesystem entry in installed dependencies: ${relative}`)
      }
    }
  }

  await walk(root, '')
  for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`)
  return `sha256-${hash.digest('hex')}`
}

function combineToolchainDigest (executableDigest, dependencyDigest) {
  if (typeof executableDigest !== 'string' || typeof dependencyDigest !== 'string') return null
  return `sha256-${crypto.createHash('sha256').update(`clinic-toolchain-v1\0${executableDigest}\0${dependencyDigest}`).digest('hex')}`
}

function readOptionalText (filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim() || null } catch { return null }
}

function readOptionalNumber (filePath) {
  const value = readOptionalText(filePath)
  if (value === null || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

function readHostMeasurementConditions () {
  const status = readOptionalText('/proc/self/status') || ''
  const affinity = status.match(/^Cpus_allowed_list:\s*(\S+)/m)
  let thermal = null
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter(name => /^thermal_zone\d+$/.test(name)).sort()
    for (const zone of zones) {
      thermal = readOptionalNumber(`/sys/class/thermal/${zone}/temp`)
      if (thermal !== null) break
    }
  } catch {}
  return {
    cpu_affinity: affinity ? affinity[1] : null,
    cpu_governor: readOptionalText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    cpu_frequency_khz: readOptionalNumber('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'),
    thermal_millicelsius: thermal
  }
}

function createMeasurementEnvironment (options = {}) {
  return {
    isolation_mode: options.isolationMode || 'unknown',
    scheduler_mode: options.schedulerMode || 'unknown',
    start: options.start || readHostMeasurementConditions(),
    finish: options.finish || readHostMeasurementConditions(),
    limitations: [
      'CPU frequency and temperature are point observations and may change during the run.',
      'CPU affinity describes the supervisor process; thread affinity may differ.',
      'Host background load and thermal throttling are not controlled by the profiler.'
    ]
  }
}

module.exports = { readRepositoryMetadata, hashExecutable, hashDependencyTree, combineToolchainDigest, readHostMeasurementConditions, createMeasurementEnvironment }
