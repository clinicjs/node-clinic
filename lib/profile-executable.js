'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = fs.promises
const { spawn } = require('node:child_process')

const EXEC_BY_DESCRIPTOR = [
  'import hashlib, json, os, sys',
  'fd, path, expected, expected_identity = int(sys.argv[1]), sys.argv[2], sys.argv[3], json.loads(sys.argv[4])',
  'stat = os.fstat(fd)',
  'identity = {"dev": str(stat.st_dev), "ino": str(stat.st_ino), "uid": str(stat.st_uid), "gid": str(stat.st_gid), "mode": str(stat.st_mode), "size": str(stat.st_size), "mtimeNs": str(stat.st_mtime_ns), "ctimeNs": str(stat.st_ctime_ns)}',
  'identity.pop("ctimeNs")',
  'expected_identity.pop("ctimeNs", None)',
  'if identity != expected_identity:',
  '  sys.stderr.write("pinned executable identity mismatch\\n")',
  '  sys.exit(126)',
  'os.lseek(fd, 0, os.SEEK_SET)',
  'digest = hashlib.sha256()',
  'while True:',
  '  chunk = os.read(fd, 1024 * 1024)',
  '  if not chunk: break',
  '  digest.update(chunk)',
  'if "sha256-" + digest.hexdigest() != expected:',
  '  sys.stderr.write("pinned executable digest mismatch\\n")',
  '  sys.exit(126)',
  'os.execve(fd, [path] + sys.argv[5:], os.environ)'
].join('\n')

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

async function readExecutableSnapshot (filePath) {
  const realPath = await fsp.realpath(filePath)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const handle = await fsp.open(realPath, flags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('executable must be a regular file')
    if (process.platform !== 'win32' && (before.mode & 0o111n) === 0n) throw new Error('executable file has no execute permission')
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(null, { fd: handle.fd, autoClose: false })
      stream.on('data', chunk => hash.update(chunk))
      stream.once('error', reject)
      stream.once('end', resolve)
    })
    const after = await handle.stat({ bigint: true })
    if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after))) {
      const error = new Error('executable changed while its startup pin was being captured')
      error.code = 'EXECUTABLE_CHANGED'
      throw error
    }
    return { path: realPath, identity: identity(after), hash: `sha256-${hash.digest('hex')}` }
  } finally {
    await handle.close()
  }
}

async function pinExecutable (filePath) {
  return readExecutableSnapshot(filePath)
}

async function verifyExecutablePin (pin) {
  let current
  try {
    current = await readExecutableSnapshot(pin.path)
  } catch (cause) {
    const error = new Error(`executable is no longer available in its pinned state: ${cause.message}`)
    error.code = 'EXECUTABLE_CHANGED'
    error.cause = cause
    throw error
  }
  if (current.hash !== pin.hash || JSON.stringify(current.identity) !== JSON.stringify(pin.identity)) {
    const error = new Error('executable changed after its startup pin was captured')
    error.code = 'EXECUTABLE_CHANGED'
    throw error
  }
  return true
}

function sameIdentity (left, right) {
  return left && right && ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(key => String(left[key]) === String(right[key]))
}

function openPinnedExecutable (pin) {
  if (!pin || !pin.path || !pin.hash || !pin.identity) throw new TypeError('a pinned executable with identity is required')
  let fd
  try {
    fd = fs.openSync(pin.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || (before.mode & 0o111n) === 0n || !sameIdentity(identity(before), pin.identity)) {
      const error = new Error('pinned executable identity mismatch')
      error.code = 'EXECUTABLE_CHANGED'
      throw error
    }
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytesRead))
    const after = fs.fstatSync(fd, { bigint: true })
    if (!sameIdentity(identity(after), pin.identity) || `sha256-${hash.digest('hex')}` !== pin.hash) {
      const error = new Error('pinned executable content or identity mismatch')
      error.code = 'EXECUTABLE_CHANGED'
      throw error
    }
    return fd
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd)
    if (!error.code) error.code = 'EXECUTABLE_CHANGED'
    throw error
  }
}

function descriptorExecArgs (fd, pin, args = []) {
  return ['-c', EXEC_BY_DESCRIPTOR, String(fd), pin.path, pin.hash, JSON.stringify(pin.identity), ...args]
}

function spawnPinnedExecutable (pythonPath, pin, args, options = {}, spawnProcess = spawn) {
  const fd = openPinnedExecutable(pin)
  const stdio = Array.isArray(options.stdio)
    ? [...options.stdio]
    : options.stdio === undefined
      ? ['pipe', 'pipe', 'pipe']
      : [options.stdio, options.stdio, options.stdio]
  while (stdio.length < 3) stdio.push('pipe')
  const childFd = Math.max(fd + 1, stdio.length)
  while (stdio.length < childFd) stdio.push('ignore')
  stdio[childFd] = fd
  let child
  try {
    child = spawnProcess(pythonPath, descriptorExecArgs(childFd, pin, args), { ...options, stdio })
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  let closed = false
  const closeFd = () => {
    if (closed) return
    closed = true
    try { fs.closeSync(fd) } catch {}
  }
  child.once('error', closeFd)
  child.once('close', closeFd)
  return child
}

module.exports = { pinExecutable, verifyExecutablePin, openPinnedExecutable, descriptorExecArgs, spawnPinnedExecutable }
