'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function mountError (message, code = 'INVALID_INPUT_MOUNT') {
  const error = new Error(message)
  error.code = code
  return error
}

function identity (stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs)
  }
}

function sameIdentity (left, right) {
  return ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key])
}

function hashFileDescriptor (fd) {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let offset = 0
  let bytesRead
  while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
    hash.update(buffer.subarray(0, bytesRead))
    offset += bytesRead
  }
  return `sha256-${hash.digest('hex')}`
}

function hashRegularFile (filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile()) throw mountError(`input is not a regular file: ${filePath}`)
    const digest = hashFileDescriptor(fd)
    const after = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(identity(before), identity(after))) throw mountError(`input changed while hashing: ${filePath}`, 'INPUT_CHANGED')
    return digest
  } finally {
    fs.closeSync(fd)
  }
}

function treeRecords (root, relative, records) {
  const entries = fs.readdirSync(path.join(root, relative), { encoding: 'buffer' })
    .sort(Buffer.compare)
  for (const entry of entries) {
    const name = entry.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(entry) || name.includes('/') || name.includes('\0')) {
      throw mountError('input directory contains a non-canonical filename')
    }
    const itemRelative = relative ? path.posix.join(relative, name) : name
    const itemPath = path.join(root, itemRelative)
    const stat = fs.lstatSync(itemPath, { bigint: true })
    if (stat.isSymbolicLink()) throw mountError(`input directory contains a symlink: ${itemRelative}`)
    if (stat.isDirectory()) {
      records.push({ path: itemRelative, type: 'directory' })
      treeRecords(root, itemRelative, records)
    } else if (stat.isFile()) {
      records.push({ path: itemRelative, type: 'file', digest: hashRegularFile(itemPath) })
    } else {
      throw mountError(`input directory contains an unsupported file type: ${itemRelative}`)
    }
  }
}

function hashInputPath (inputPath) {
  const stat = fs.lstatSync(inputPath, { bigint: true })
  if (stat.isSymbolicLink()) throw mountError('input source must not be a symlink')
  if (stat.isFile()) return hashRegularFile(inputPath)
  if (!stat.isDirectory()) throw mountError('input source must be a regular file or directory')

  const records = []
  treeRecords(inputPath, '', records)
  records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)) || left.type.localeCompare(right.type))
  const hash = crypto.createHash('sha256').update('clinic-input-tree-v1\0')
  for (const record of records) {
    hash.update(record.type).update('\0').update(record.path).update('\0')
    if (record.digest) hash.update(record.digest)
    hash.update('\0')
  }
  return `sha256-${hash.digest('hex')}`
}

function assertNoSymlinkInPath (root, relative) {
  let current = root
  for (const segment of relative.split('/').filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw mountError(`input source path contains a symlink: ${relative}`)
  }
}

function assertNoSymlinkAncestors (absolute) {
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (fs.lstatSync(current).isSymbolicLink()) throw mountError(`configured input root contains a symlink: ${current}`)
  }
}

function openInputMount (mount, roots) {
  if (!mount || !['workspace', 'declared-input'].includes(mount.source_root) || typeof mount.source !== 'string' || typeof mount.target !== 'string') {
    throw mountError('input mount declaration is invalid')
  }
  const rootValue = roots[mount.source_root]
  if (typeof rootValue !== 'string' || rootValue.length === 0) {
    throw mountError(`input root is not configured: ${mount.source_root}`, 'ISOLATION_UNAVAILABLE')
  }
  const rootInput = path.resolve(rootValue)
  assertNoSymlinkAncestors(rootInput)
  let root
  try {
    const rootStat = fs.lstatSync(rootInput)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw mountError(`input root is not a regular directory: ${rootInput}`)
    root = fs.realpathSync(rootInput)
  } catch (error) {
    if (!error.code) error.code = 'INVALID_INPUT_MOUNT'
    throw error
  }
  const segments = mount.source.split('/')
  if (path.posix.isAbsolute(mount.source) || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw mountError('input source must be a canonical relative path')
  }
  if (!/^\/inputs\/(?!.*(?:^|\/)\.\.?($|\/))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(mount.target)) throw mountError('input target must be a canonical path under /inputs')
  if (!/^sha256-[a-f0-9]{64}$/.test(mount.digest)) throw mountError('input digest must be a SHA-256 digest')
  const source = path.resolve(root, ...segments)
  const relative = path.relative(root, source)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw mountError('input source must be below its configured root')
  assertNoSymlinkInPath(root, relative.split(path.sep).join('/'))
  const sourceStat = fs.lstatSync(source, { bigint: true })
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw mountError('input source must be a regular file or directory')
  const digest = hashInputPath(source)
  if (digest !== mount.digest) throw mountError(`input digest mismatch: ${mount.source}`, 'INPUT_DIGEST_MISMATCH')
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (sourceStat.isDirectory() ? fs.constants.O_DIRECTORY : 0)
  const fd = fs.openSync(source, flags)
  const opened = fs.fstatSync(fd, { bigint: true })
  if (!sameIdentity(identity(sourceStat), identity(opened))) {
    fs.closeSync(fd)
    throw mountError(`input changed before mount: ${mount.source}`, 'INPUT_CHANGED')
  }
  return { fd, source, target: mount.target }
}

module.exports = { hashInputPath, openInputMount }
