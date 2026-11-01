'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { spawn, spawnSync } = require('node:child_process')
const { openPinnedExecutable } = require('./profile-executable')
const { openInputMount } = require('./profile-input-mounts')

function closeMounts (mounts) {
  for (const mount of mounts) {
    if (mount.fd === undefined) continue
    try { fs.closeSync(mount.fd) } catch {}
    mount.fd = undefined
  }
}

function closeTransferChannel (channel, closeKeeper = true) {
  if (!channel) return
  if (closeKeeper && channel.keeperFd !== undefined) {
    try { fs.closeSync(channel.keeperFd) } catch {}
    channel.keeperFd = undefined
  }
  if (channel.readerFd !== undefined) {
    try { fs.closeSync(channel.readerFd) } catch {}
    channel.readerFd = undefined
  }
  if (channel.fifoPath) {
    try { fs.unlinkSync(channel.fifoPath) } catch {}
    channel.fifoPath = null
  }
}

function readProfileTransfer (fd, destination, maxBytes, onError = () => {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(fd)) {
      reject(Object.assign(new Error('profile worker output pipe is unavailable'), { code: 'PROFILE_TRANSFER_INVALID' }))
      return
    }
    let pending = Buffer.alloc(0)
    let currentFile = null
    let currentResult = null
    let result = null
    let hasResult = false
    let totalBytes = 0
    let done = false
    let settled = false
    const chunkBuffer = Buffer.alloc(64 * 1024)

    const fail = (code, message) => {
      if (settled) return
      settled = true
      const error = Object.assign(new Error(message), { code })
      if (currentFile) {
        try { fs.closeSync(currentFile.fd) } catch {}
        currentFile = null
      }
      onError(error)
      reject(error)
    }

    const parseHeader = line => {
      let header
      try { header = JSON.parse(line) } catch { throw Object.assign(new Error('profile worker sent invalid transfer metadata'), { code: 'PROFILE_TRANSFER_INVALID' }) }
      if (!header || typeof header !== 'object') throw Object.assign(new Error('profile worker sent invalid transfer metadata'), { code: 'PROFILE_TRANSFER_INVALID' })
      if (header.type === 'file') {
        const parts = typeof header.path === 'string' ? header.path.split('/') : []
        if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')) || !Number.isSafeInteger(header.size) || header.size < 0) {
          throw Object.assign(new Error('profile worker sent an unsafe file entry'), { code: 'PROFILE_TRANSFER_INVALID' })
        }
        if (totalBytes + header.size > maxBytes) throw Object.assign(new Error('profile artifact size limit exceeded'), { code: 'ARTIFACT_LIMIT' })
        const target = path.join(destination, ...parts)
        const relative = path.relative(destination, target)
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Object.assign(new Error('profile worker file path escapes the run directory'), { code: 'PROFILE_TRANSFER_INVALID' })
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
        currentFile = { fd, remaining: header.size }
        totalBytes += header.size
        if (header.size === 0) {
          fs.fsyncSync(fd)
          fs.closeSync(fd)
          currentFile = null
        }
        return
      }
      if (header.type === 'result') {
        if (hasResult || currentResult || !Number.isSafeInteger(header.size) || header.size < 0 || header.size > 16 * 1024 * 1024) {
          throw Object.assign(new Error('profile worker sent invalid result metadata'), { code: 'PROFILE_TRANSFER_INVALID' })
        }
        hasResult = true
        currentResult = { remaining: header.size, chunks: [] }
        if (header.size === 0) {
          result = null
          currentResult = null
        }
        return
      }
      if (header.type === 'done') {
        if (done || !hasResult || currentResult || currentFile) throw Object.assign(new Error('profile worker ended an incomplete transfer'), { code: 'PROFILE_TRANSFER_INVALID' })
        done = true
        return
      }
      throw Object.assign(new Error('profile worker sent an unknown transfer record'), { code: 'PROFILE_TRANSFER_INVALID' })
    }

    const consume = () => {
      try {
        while (true) {
          if (done) {
            if (pending.length) throw Object.assign(new Error('profile worker sent data after the end record'), { code: 'PROFILE_TRANSFER_INVALID' })
            return
          }
          const transfer = currentFile || currentResult
          if (transfer) {
            if (!pending.length) return
            const count = Math.min(transfer.remaining, pending.length)
            const chunk = pending.subarray(0, count)
            if (currentFile) {
              let offset = 0
              while (offset < chunk.length) offset += fs.writeSync(currentFile.fd, chunk, offset, chunk.length - offset)
            } else currentResult.chunks.push(Buffer.from(chunk))
            pending = pending.subarray(count)
            transfer.remaining -= count
            if (transfer.remaining === 0) {
              if (currentFile) {
                fs.fsyncSync(currentFile.fd)
                fs.closeSync(currentFile.fd)
                currentFile = null
              } else {
                try { result = JSON.parse(Buffer.concat(currentResult.chunks).toString('utf8')) } catch {
                  throw Object.assign(new Error('profile worker sent invalid result data'), { code: 'PROFILE_TRANSFER_INVALID' })
                }
                currentResult = null
              }
            }
            continue
          }
          const newline = pending.indexOf(10)
          if (newline === -1) {
            if (pending.length > 65536) throw Object.assign(new Error('profile worker transfer metadata is too large'), { code: 'PROFILE_TRANSFER_INVALID' })
            return
          }
          const line = pending.subarray(0, newline).toString('utf8')
          pending = pending.subarray(newline + 1)
          parseHeader(line)
        }
      } catch (error) {
        fail(error.code || 'PROFILE_TRANSFER_INVALID', error.message)
      }
    }

    const poll = () => {
      if (settled) return
      let bytesRead
      try {
        bytesRead = fs.readSync(fd, chunkBuffer, 0, chunkBuffer.length, null)
      } catch (error) {
        if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') {
          setTimeout(poll, 5)
          return
        }
        fail('PROFILE_TRANSFER_FAILED', error.message)
        return
      }
      if (bytesRead === 0) {
        if (!done || !hasResult || currentFile || currentResult || pending.length) return fail('PROFILE_TRANSFER_INVALID', 'profile worker transfer ended before completion')
        settled = true
        resolve({ workerResult: result, bytes: totalBytes })
        return
      }
      const chunk = Buffer.from(chunkBuffer.subarray(0, bytesRead))
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      consume()
      if (!settled) setImmediate(poll)
    }

    poll()
  })
}

function addMount (mounts, mount) {
  const existing = mounts.find(item => item.target === mount.target)
  if (existing) {
    try { fs.closeSync(mount.fd) } catch {}
    if (existing.source !== mount.source) {
      const error = new Error(`multiple sources target the same sandbox path: ${mount.target}`)
      error.code = 'ISOLATION_INVALID_CONTEXT'
      throw error
    }
    return existing
  }
  mounts.push(mount)
  return mount
}

function trustedMount (sourcePath, target, root) {
  const source = path.resolve(sourcePath)
  const relative = path.relative(root, source)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error(`trusted runtime path escapes its root: ${source}`)
    error.code = 'ISOLATION_INVALID_CONTEXT'
    throw error
  }
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) {
      const error = new Error(`trusted runtime path contains a symlink: ${current}`)
      error.code = 'ISOLATION_INVALID_CONTEXT'
      throw error
    }
  }
  const stat = fs.lstatSync(source)
  if (!stat.isFile() && !stat.isDirectory()) {
    const error = new Error(`trusted runtime path is not a regular file or directory: ${source}`)
    error.code = 'ISOLATION_INVALID_CONTEXT'
    throw error
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (stat.isDirectory() ? fs.constants.O_DIRECTORY : 0)
  return { fd: fs.openSync(source, flags), source, target, directory: stat.isDirectory() }
}

function systemRuntimeMounts (mounts) {
  const mapText = fs.readFileSync('/proc/self/maps', 'utf8')
  const paths = new Set()
  for (const line of mapText.split('\n')) {
    const match = line.match(/\s(\/.*?)(?: \(deleted\))?$/)
    if (!match || !/\.so(?:\.\d+)*$/.test(match[1])) continue
    const source = match[1]
    if (fs.existsSync(source)) paths.add(source)
  }
  for (const source of paths) {
    const target = path.resolve(source)
    if (mounts.some(mount => mount.target === target)) continue
    const realPath = fs.realpathSync(source)
    const stat = fs.statSync(realPath)
    if (!stat.isFile()) continue
    const fd = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    mounts.push({ fd, source: realPath, target, directory: false })
    // The dynamic loader resolves DT_NEEDED entries through SONAME symlinks
    // such as libstdc++.so.6, while /proc/self/maps exposes the versioned
    // file (libstdc++.so.6.0.33). Bind those aliases to the same pinned inode.
    for (const entry of fs.readdirSync(path.dirname(realPath), { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue
      const alias = path.join(path.dirname(realPath), entry.name)
      if (mounts.some(mount => mount.target === alias)) continue
      let aliasRealPath
      try { aliasRealPath = fs.realpathSync(alias) } catch { continue }
      if (aliasRealPath !== realPath) continue
      mounts.push({
        fd: fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
        source: realPath,
        target: alias,
        directory: false
      })
    }
  }
  const cachePath = '/etc/ld.so.cache'
  if (fs.existsSync(cachePath) && !mounts.some(mount => mount.target === cachePath)) {
    mounts.push({
      fd: fs.openSync(cachePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
      source: cachePath,
      target: cachePath,
      directory: false
    })
  }
  const envPath = '/usr/bin/env'
  if (fs.existsSync(envPath) && !mounts.some(mount => mount.target === envPath)) {
    const realPath = fs.realpathSync(envPath)
    mounts.push({
      fd: fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
      source: realPath,
      target: envPath,
      directory: false
    })
  }
}

function elfInterpreter (executable) {
  const fd = fs.openSync(executable, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const header = Buffer.alloc(64)
    const headerBytes = fs.readSync(fd, header, 0, header.length, 0)
    if (headerBytes < 52 || header.toString('ascii', 0, 4) !== '\u007fELF') return null
    const littleEndian = header[5] === 1
    if (!littleEndian && header[5] !== 2) return null
    const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE
    const read64 = littleEndian ? Buffer.prototype.readBigUInt64LE : Buffer.prototype.readBigUInt64BE
    const is64Bit = header[4] === 2
    if (!is64Bit && header[4] !== 1) return null
    const programOffset = is64Bit ? Number(read64.call(header, 32)) : read32.call(header, 28)
    const entrySize = read16.call(header, is64Bit ? 54 : 42)
    const entryCount = read16.call(header, is64Bit ? 56 : 44)
    if (!Number.isSafeInteger(programOffset) || entrySize < (is64Bit ? 56 : 32) || entryCount > 4096) return null
    const programHeaders = Buffer.alloc(entrySize * entryCount)
    if (fs.readSync(fd, programHeaders, 0, programHeaders.length, programOffset) !== programHeaders.length) return null
    for (let index = 0; index < entryCount; index++) {
      const offset = index * entrySize
      if (read32.call(programHeaders, offset) !== 3) continue // PT_INTERP
      const stringOffset = is64Bit ? Number(read64.call(programHeaders, offset + 8)) : read32.call(programHeaders, offset + 4)
      const stringSize = is64Bit ? Number(read64.call(programHeaders, offset + 32)) : read32.call(programHeaders, offset + 16)
      if (!Number.isSafeInteger(stringOffset) || !Number.isSafeInteger(stringSize) || stringSize < 2 || stringSize > 4096) return null
      const value = Buffer.alloc(stringSize)
      if (fs.readSync(fd, value, 0, stringSize, stringOffset) !== stringSize) return null
      const interpreter = value.toString('utf8').replace(/\0+$/, '')
      return path.isAbsolute(interpreter) ? interpreter : null
    }
    return null
  } finally {
    fs.closeSync(fd)
  }
}

function addElfInterpreterMount (mounts, executable) {
  const target = elfInterpreter(executable)
  if (!target || mounts.some(mount => mount.target === target)) return
  const source = fs.realpathSync(target)
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw Object.assign(new Error(`ELF interpreter is not a regular file: ${target}`), { code: 'ISOLATION_INVALID_CONTEXT' })
  mounts.push({
    fd: fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
    source,
    target,
    directory: false
  })
}

function mountDirectories (targets) {
  const directories = new Set(['/workspace', '/clinic', '/runtime', '/inputs', '/run', '/run/profile', '/etc', '/usr', '/usr/bin', '/lib', '/lib64'])
  for (const target of targets) {
    let current = path.posix.dirname(target)
    while (current !== '/' && current !== '.') {
      directories.add(current)
      current = path.posix.dirname(current)
    }
  }
  return [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right))
}

function inputArgumentPath (argument, root) {
  if (typeof argument !== 'string' || !argument.startsWith('/workspace/')) return null
  const relative = argument.slice('/workspace/'.length)
  if (!relative || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    const error = new Error('workload argument contains a non-canonical workspace path')
    error.code = 'ISOLATION_INVALID_CONTEXT'
    throw error
  }
  return { source: path.join(root, ...relative.split('/')), target: argument }
}

function assertInternalSymlinks (root) {
  const canonicalRoot = fs.realpathSync(root)
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(candidate)
        const relative = path.relative(canonicalRoot, resolved)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          const error = new Error(`dependency symlink escapes node_modules: ${candidate}`)
          error.code = 'ISOLATION_INVALID_CONTEXT'
          throw error
        }
      } else if (entry.isDirectory()) visit(candidate)
    }
  }
  visit(canonicalRoot)
}

/**
 * Adapter for a deployment-provided rootless Linux supervisor.
 *
 * The RFC deliberately does not silently downgrade strict MCP runs to a
 * normal child_process.spawn(). A deployment must inject a supervisor that
 * actually provides cgroups, namespaces, a private filesystem and descendant
 * cleanup. This adapter validates that contract and fails closed otherwise.
 */
function createLinuxIsolationProvider (options = {}) {
  const supervisor = options.supervisor
  return {
    name: options.name || 'external-rootless-provider',
    version: options.version || '1',
    atomicExec: options.atomicExec === true,
    atomicTargetExec: options.atomicTargetExec === true,
    completeInputFilesystem: options.completeInputFilesystem === true,
    async run (context) {
      if (os.platform() !== 'linux') {
        const error = new Error('strict isolation provider requires Linux')
        error.code = 'ISOLATION_UNAVAILABLE'
        throw error
      }
      if (typeof supervisor !== 'function') {
        const error = new Error('no rootless isolation supervisor configured')
        error.code = 'ISOLATION_UNAVAILABLE'
        throw error
      }
      if (options.atomicExec !== true || options.atomicTargetExec !== true || options.completeInputFilesystem !== true) {
        const error = new Error('isolation provider must guarantee atomic worker and target executable selection and expose only declared inputs')
        error.code = 'ISOLATION_UNAVAILABLE'
        throw error
      }
      if (!context || (!context.profileWorker && typeof context.execute !== 'function')) {
        const error = new Error('isolation context is missing a profiled worker or execute()')
        error.code = 'ISOLATION_INVALID_CONTEXT'
        throw error
      }
      return supervisor({
        ...context,
        guarantees: {
          cpu_memory_cgroups: true,
          private_network: true,
          private_filesystem: true,
          descendant_cleanup: true,
          atomic_exec: true,
          atomic_target_exec: true,
          complete_input_filesystem: true
        }
      })
    }
  }
}

function createBubblewrapSupervisor (options = {}) {
  const bwrap = options.bwrapPath || 'bwrap'
  const requireCgroup = options.requireCgroup !== false
  return context => {
    if (requireCgroup && !options.cgroupSupervisor) {
      const error = new Error('bubblewrap alone cannot provide the required cgroup limits')
      error.code = 'ISOLATION_UNAVAILABLE'
      throw error
    }
    if (!context || !context.sandboxDir || !context.limits || !Number.isSafeInteger(context.limits.artifact_mb) || context.limits.artifact_mb < 1) {
      const error = new Error('bubblewrap requires a sandbox artifact directory and a positive artifact size limit')
      error.code = 'ISOLATION_INVALID_LIMITS'
      throw error
    }
    const workspaceRoot = fs.realpathSync(options.workspaceRoot || context.rootDir || process.cwd())
    const runtimeRoot = fs.realpathSync(options.runtimeRoot || path.dirname(context.executable))
    const cwdRelative = path.relative(workspaceRoot, context.cwd)
    const cwd = cwdRelative === '..' || cwdRelative.startsWith(`..${path.sep}`) || path.isAbsolute(cwdRelative)
      ? '/workspace'
      : path.posix.join('/workspace', cwdRelative.split(path.sep).join('/'))
    const mounts = []
    const passFds = []
    let transferChannel = null
    let workerExecutablePath = null
    let targetExecutablePath = null
    try {
      if (context.profileWorker) {
        const workerPin = options.workerExecutablePin
        if (!workerPin || workerPin.path !== fs.realpathSync(context.executable)) {
          const error = new Error('bubblewrap requires a startup-pinned Node executable for the profile worker')
          error.code = 'ISOLATION_UNAVAILABLE'
          throw error
        }
        const relative = path.relative(runtimeRoot, workerPin.path)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          const error = new Error('pinned worker executable is outside the configured runtime root')
          error.code = 'ISOLATION_UNAVAILABLE'
          throw error
        }
        workerExecutablePath = path.posix.join('/runtime', relative.split(path.sep).join('/'))
        addMount(mounts, { fd: openPinnedExecutable(workerPin), source: workerPin.path, target: workerExecutablePath, directory: false })

        const targetPin = context.executablePin
        targetExecutablePath = context.profileWorker.executablePath
        if (!targetPin || typeof targetExecutablePath !== 'string') {
          const error = new Error('strict run is missing its pinned target executable mount')
          error.code = 'ISOLATION_UNAVAILABLE'
          throw error
        }
        if (!context.profileWorker.hostInputPath || context.profileWorker.outputPath !== '/run/worker-output') {
          const error = new Error('strict profile worker is missing its trusted input file or transfer FIFO')
          error.code = 'ISOLATION_INVALID_CONTEXT'
          throw error
        }
        if (targetExecutablePath !== workerExecutablePath) {
          addMount(mounts, { fd: openPinnedExecutable(targetPin), source: targetPin.path, target: targetExecutablePath, directory: false })
        }
        addElfInterpreterMount(mounts, workerPin.path)
        addElfInterpreterMount(mounts, targetPin.path)

        const clinicRoot = fs.realpathSync(context.profileWorker.clinicRoot)
        for (const relativePath of [
          'bin/profile-clinic-worker.js',
          'lib/profile-measurement.js',
          'lib/profile-executable.js',
          'lib/profile-clinic-collector.js',
          'lib/profile-flame-collector.js'
        ]) {
          const source = path.join(clinicRoot, relativePath)
          const target = path.posix.join('/clinic', relativePath.split(path.sep).join('/'))
          addMount(mounts, trustedMount(source, target, clinicRoot))
        }
        const clinicDependencies = path.join(clinicRoot, 'node_modules')
        assertInternalSymlinks(clinicDependencies)
        addMount(mounts, trustedMount(clinicDependencies, '/clinic/node_modules', clinicRoot))

        for (const argument of (context.workloadDefinition && context.workloadDefinition.argv) || []) {
          const input = inputArgumentPath(argument, workspaceRoot)
          if (input) addMount(mounts, trustedMount(input.source, input.target, workspaceRoot))
        }
        const roots = { workspace: workspaceRoot, 'declared-input': options.declaredInputRoot }
        for (const input of (context.workloadDefinition && context.workloadDefinition.input_mounts) || []) {
          addMount(mounts, openInputMount(input, roots))
        }
        addMount(mounts, trustedMount(context.profileWorker.hostInputPath, '/run/worker-input.json', context.sandboxDir))
        const fifoPath = path.join(context.sandboxDir, `.clinic-worker-output-${process.pid}-${Date.now()}`)
        const mkfifo = spawnSync(options.mkfifoPath || '/usr/bin/mkfifo', ['-m', '600', fifoPath], { stdio: 'ignore' })
        if (mkfifo.error || mkfifo.status !== 0) {
          const error = new Error('could not create the profile worker transfer FIFO')
          error.code = 'ISOLATION_UNAVAILABLE'
          throw error
        }
        try {
          const noFollow = fs.constants.O_NOFOLLOW || 0
          const readerFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow)
          let keeperFd
          let mountFd
          try {
            keeperFd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | noFollow)
            mountFd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow)
          } catch (error) {
            fs.closeSync(readerFd)
            if (keeperFd !== undefined) fs.closeSync(keeperFd)
            throw error
          }
          transferChannel = { fifoPath, readerFd, keeperFd }
          addMount(mounts, { fd: mountFd, source: fifoPath, target: '/run/worker-output', directory: false, writable: true })
        } catch (error) {
          try { fs.unlinkSync(fifoPath) } catch {}
          throw error
        }
        systemRuntimeMounts(mounts)
      } else {
        const error = new Error('Bubblewrap direct execution is not supported without a pinned profile worker')
        error.code = 'ISOLATION_UNAVAILABLE'
        throw error
      }

      const maxSourceFd = Math.max(3, ...mounts.map(mount => mount.fd))
      let targetFd = maxSourceFd + 1
      for (const mount of mounts) {
        mount.targetFd = targetFd++
        passFds.push({ fd: mount.fd, targetFd: mount.targetFd })
      }
      const args = [
        '--clearenv',
        '--die-with-parent',
        '--unshare-user', '--uid', '0', '--gid', '0',
        '--unshare-net',
        '--unshare-pid',
        '--disable-userns',
        '--assert-userns-disabled',
        '--cap-drop', 'CAP_SYS_ADMIN'
      ]
      for (const directory of mountDirectories([...mounts.map(mount => mount.target), cwd])) args.push('--dir', directory)
      args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--size', String(context.limits.artifact_mb * 1024 * 1024), '--tmpfs', '/run/profile', '--dir', '/run/profile/home', '--chdir', cwd)
      for (const mount of mounts) args.push(mount.writable ? '--bind-fd' : '--ro-bind-fd', String(mount.targetFd), mount.target)
      const inputNodePaths = mounts.filter(mount => mount.directory && mount.target.endsWith('/node_modules')).map(mount => mount.target)
      const nodePath = ['/clinic/node_modules', ...inputNodePaths].filter((value, index, values) => values.indexOf(value) === index).join(':')
      args.push('--setenv', 'PATH', '/runtime:/clinic/node_modules/.bin:/usr/bin')
      args.push('--setenv', 'NODE_PATH', nodePath)
      args.push('--setenv', 'HOME', '/run/profile/home')
      args.push('--setenv', 'TMPDIR', '/tmp')
      for (const [name, value] of Object.entries(context.env || {})) {
        if (!['PATH', 'NODE_PATH', 'HOME', 'TMPDIR'].includes(name)) args.push('--setenv', name, value)
      }
      args.push('--', workerExecutablePath, '/clinic/bin/profile-clinic-worker.js', context.profileWorker.inputPath, context.profileWorker.resultPath, context.profileWorker.outputPath)
      context = { ...context, passFds, transferChannel }
      context.bwrapArgs = args
    } catch (error) {
      closeMounts(mounts)
      closeTransferChannel(transferChannel)
      throw error
    }
    const args = context.bwrapArgs
    const launch = typeof options.cgroupSupervisor === 'function'
      ? options.cgroupSupervisor
      : (command, commandArgs, launchContext) => {
          const stdio = ['ignore', 'pipe', 'pipe']
          for (const item of launchContext.passFds) {
            while (stdio.length < item.targetFd) stdio.push('ignore')
            stdio[item.targetFd] = item.fd
          }
          return spawn(command, commandArgs, { stdio, shell: false, detached: true })
        }
    return new Promise((resolve, reject) => {
      let child
      try {
        child = launch(bwrap, args, context)
      } catch (error) {
        closeMounts(mounts)
        closeTransferChannel(transferChannel)
        reject(error)
        return
      }
      const closeAllMounts = () => closeMounts(mounts)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', data => { stdout += data.toString() })
      child.stderr.on('data', data => { stderr += data.toString() })
      let timedOut = false
      let artifactLimitExceeded = false
      let settled = false
      const terminate = () => {
        if (typeof child.terminateTree === 'function') child.terminateTree('TERM')
        else {
          try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
        }
        const killTimer = setTimeout(() => {
          if (typeof child.terminateTree === 'function') child.terminateTree('KILL')
          else {
            try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
          }
        }, 250)
        killTimer.unref()
      }
      const onAbort = () => terminate()
      const transfer = readProfileTransfer(transferChannel.readerFd, context.sandboxDir, context.limits.artifact_mb * 1024 * 1024, error => {
        if (error.code === 'ARTIFACT_LIMIT') artifactLimitExceeded = true
        terminate()
      })
      transfer.catch(() => {})
      if (context.signal) {
        if (context.signal.aborted) onAbort()
        else context.signal.addEventListener('abort', onAbort, { once: true })
      }
      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, context.limits.wall_clock_ms)
      child.once('error', error => {
        if (settled) return
        settled = true
        closeAllMounts()
        clearTimeout(timer)
        closeTransferChannel(transferChannel)
        if (context.signal) context.signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        closeAllMounts()
        clearTimeout(timer)
        if (transferChannel.keeperFd !== undefined) {
          try { fs.closeSync(transferChannel.keeperFd) } catch {}
          transferChannel.keeperFd = undefined
        }
        if (context.signal) context.signal.removeEventListener('abort', onAbort)
        transfer.then(value => {
          closeTransferChannel(transferChannel)
          resolve({ status: artifactLimitExceeded ? 'artifact_limit_exceeded' : timedOut ? 'timed_out' : context.signal && context.signal.aborted ? 'cancelled' : code === 0 ? 'completed' : 'failed', exitCode: code, signal, stdout, stderr, ...value })
        }, error => {
          closeTransferChannel(transferChannel)
          resolve({ status: artifactLimitExceeded ? 'artifact_limit_exceeded' : timedOut ? 'timed_out' : 'failed', exitCode: code, signal, stdout, stderr: [stderr, error.message].filter(Boolean).join('\n'), error: { code: error.code || 'PROFILE_TRANSFER_FAILED', message: error.message } })
        })
      })
    })
  }
}

function createSystemdCgroupSupervisor (options = {}) {
  const systemdRun = options.systemdRunPath || 'systemd-run'
  const systemctl = options.systemctlPath || 'systemctl'
  const spawnProcess = options.spawnProcess || spawn
  const stopProcess = options.stopProcess || spawn
  return (command, args, context = {}) => {
    const limits = context.limits || {}
    const wallClockMs = limits.wall_clock_ms
    const cpuMs = limits.cpu_ms
    const memoryMb = limits.memory_mb
    if (![wallClockMs, cpuMs, memoryMb].every(Number.isSafeInteger) || wallClockMs < 1 || cpuMs < 1 || memoryMb < 1) {
      const error = new Error('systemd isolation requires positive wall-clock, CPU, and memory limits')
      error.code = 'ISOLATION_INVALID_LIMITS'
      throw error
    }
    const quotaPct = cpuMs * 100 / wallClockMs
    if (quotaPct < 1) {
      const error = new Error('systemd CPUQuota cannot enforce a CPU budget below one percent of the wall-clock limit')
      error.code = 'ISOLATION_UNAVAILABLE'
      throw error
    }
    const cpuCount = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
    const quota = Math.floor(Math.min(quotaPct, cpuCount * 100) * 1000) / 1000
    const quotaText = quota.toFixed(3).replace(/\.?0+$/, '')
    if (quota < 1) {
      const error = new Error('systemd CPUQuota resolution is too coarse for the requested CPU budget')
      error.code = 'ISOLATION_UNAVAILABLE'
      throw error
    }
    const unitId = String(context.runId || `run-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, '-')
    const unit = `clinic-profile-${unitId}-${process.pid}-${Date.now()}.scope`
    const systemdArgs = [
      '--user', '--scope', '--collect', `--unit=${unit}`,
      `--property=MemoryMax=${memoryMb}M`,
      '--property=MemorySwapMax=0',
      '--property=CPUAccounting=yes',
      `--property=CPUQuota=${quotaText}%`,
      '--property=KillMode=control-group',
      '--property=TasksMax=512',
      '--',
      command,
      ...args
    ]
    const stdio = ['ignore', 'pipe', 'pipe']
    for (const item of context.passFds || []) {
      while (stdio.length < item.targetFd) stdio.push('ignore')
      stdio[item.targetFd] = item.fd
    }
    const child = spawnProcess(systemdRun, systemdArgs, { stdio, shell: false, detached: true })
    child.terminateTree = signal => {
      const fallback = () => {
        try { process.kill(-child.pid, `SIG${signal}`) } catch { try { child.kill(`SIG${signal}`) } catch {} }
      }
      let stopper
      try {
        stopper = stopProcess(systemctl, [
          '--user', 'kill', '--kill-whom=all', `--signal=${signal}`, unit
        ], { stdio: 'ignore', shell: false })
      } catch {
        fallback()
        return null
      }
      if (stopper && typeof stopper.once === 'function') {
        stopper.once('error', fallback)
        stopper.once('close', code => { if (code !== 0) fallback() })
      }
      return stopper
    }
    return child
  }
}

module.exports = { createLinuxIsolationProvider, createBubblewrapSupervisor, createSystemdCgroupSupervisor, elfInterpreter, readProfileTransfer }
