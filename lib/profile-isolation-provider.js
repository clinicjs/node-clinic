'use strict'

const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

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
      if (options.atomicExec !== true) {
        const error = new Error('isolation provider must guarantee atomic executable selection')
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
          atomic_exec: true
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
    const workspaceRoot = path.resolve(options.workspaceRoot || process.cwd())
    const runtimeRoot = path.resolve(options.runtimeRoot || path.dirname(context.executable))
    const executable = context.executable.startsWith(runtimeRoot + path.sep)
      ? `/runtime/${path.relative(runtimeRoot, context.executable).replaceAll(path.sep, '/')}`
      : context.executable
    const cwd = context.cwd.startsWith(workspaceRoot + path.sep)
      ? `/workspace/${path.relative(workspaceRoot, context.cwd).replaceAll(path.sep, '/')}`
      : '/workspace'
    const args = [
      '--clearenv',
      '--die-with-parent',
      '--unshare-net',
      '--unshare-pid',
      '--proc', '/proc',
      '--dev', '/dev',
      '--ro-bind', workspaceRoot, '/workspace'
    ]
    const fs = require('node:fs')
    for (const systemPath of ['/usr', '/lib', '/lib64']) {
      if (fs.existsSync(systemPath)) {
        const source = fs.realpathSync(systemPath)
        args.push('--ro-bind', source, systemPath)
      }
    }
    args.push('--ro-bind', runtimeRoot, '/runtime')
    if (context.profileWorker) {
      args.push('--ro-bind', context.profileWorker.clinicRoot, '/clinic')
    }
    args.push('--bind', context.sandboxDir, '/run/profile', '--tmpfs', '/tmp', '--chdir', cwd)
    args.push('--setenv', 'PATH', '/runtime:/usr/bin:/bin')
    for (const [name, value] of Object.entries(context.env || {})) args.push('--setenv', name, value)
    if (context.profileWorker) {
      args.push('--', executable, '/clinic/bin/profile-clinic-worker.js', context.profileWorker.inputPath, context.profileWorker.resultPath)
    } else {
      const childArgs = context.args.map(argument => argument.startsWith(workspaceRoot + path.sep)
        ? `/workspace/${path.relative(workspaceRoot, argument).replaceAll(path.sep, '/')}`
        : argument)
      args.push('--', executable, ...childArgs)
    }
    const launch = typeof options.cgroupSupervisor === 'function'
      ? options.cgroupSupervisor
      : (command, commandArgs) => spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
    return new Promise((resolve, reject) => {
      const child = launch(bwrap, args, context)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', data => { stdout += data.toString() })
      child.stderr.on('data', data => { stderr += data.toString() })
      let timedOut = false
      let settled = false
      const terminate = () => {
        try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
        const killTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
        }, 250)
        killTimer.unref()
      }
      const onAbort = () => terminate()
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
        clearTimeout(timer)
        if (context.signal) context.signal.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (context.signal) context.signal.removeEventListener('abort', onAbort)
        resolve({ status: timedOut ? 'timed_out' : context.signal && context.signal.aborted ? 'cancelled' : code === 0 ? 'completed' : 'failed', exitCode: code, signal, stdout, stderr })
      })
    })
  }
}

function createSystemdCgroupSupervisor (options = {}) {
  const systemdRun = options.systemdRunPath || 'systemd-run'
  return (command, args, context) => {
    const limits = context.limits || {}
    const systemdArgs = [
      '--user', '--scope', '--collect',
      '-p', `MemoryMax=${limits.memory_mb || 1}M`,
      '-p', `CPUQuota=${Math.max(1, Math.ceil((limits.cpu_ms || 1) / Math.max(1, limits.wall_clock_ms || 1) * 100))}%`,
      command,
      ...args
    ]
    return spawn(systemdRun, systemdArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true })
  }
}

module.exports = { createLinuxIsolationProvider, createBubblewrapSupervisor, createSystemdCgroupSupervisor }
