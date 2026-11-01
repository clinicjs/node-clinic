'use strict'

const fs = require('node:fs')
const path = require('node:path')
const pumpify = require('pumpify')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fsp = fs.promises
const getLoggingPaths = require('@clinic/clinic-common').getLoggingPaths

const PROFILERS = ['clinic-doctor', 'clinic-bubbleprof', 'clinic-flame', 'clinic-heapprofiler']

function collectWith (Tool, options) {
  const tool = new Tool({ dest: options.dest, name: options.name, sampleInterval: options.sampleInterval })
  return new Promise((resolve, reject) => {
    tool.collect([options.nodePath, ...options.args], (error, artifactDir) => {
      if (error) return reject(error)
      resolve(artifactDir)
    })
  })
}

async function readObjectStream (stream, maxItems = 10000) {
  const items = []
  for await (const item of stream) {
    if (items.length >= maxItems) {
      const error = new Error('profiler analysis exceeded the item limit')
      error.code = 'ANALYSIS_LIMIT'
      throw error
    }
    items.push(item)
  }
  return items
}

async function analyzeDoctor (artifactDir) {
  const paths = getLoggingPaths('doctor')({ path: artifactDir })
  const doctorRoot = path.dirname(require.resolve('@clinic/doctor'))
  const systemInfoReader = pumpify.obj(
    fs.createReadStream(paths['/systeminfo']),
    new (require(path.join(doctorRoot, 'format/system-info-decoder.js')))()
  )
  const traceEventReader = pumpify.obj(
    fs.createReadStream(paths['/traceevent']),
    new (require(path.join(doctorRoot, 'format/trace-event-decoder.js')))(systemInfoReader)
  )
  const processStatReader = pumpify.obj(
    fs.createReadStream(paths['/processstat']),
    new (require(path.join(doctorRoot, 'format/process-stat-decoder.js')))()
  )
  const Analysis = require(path.join(doctorRoot, 'analysis/index.js'))
  const results = await readObjectStream(new Analysis(systemInfoReader, traceEventReader, processStatReader), 1)
  return results[0]
}

async function analyzeBubbleprof (artifactDir) {
  const paths = getLoggingPaths('bubbleprof')({ path: artifactDir })
  const bubbleRoot = path.dirname(require.resolve('@clinic/bubbleprof'))
  const SystemInfoDecoder = require(path.join(bubbleRoot, 'format/system-info-decoder.js'))
  const StackTraceDecoder = require(path.join(bubbleRoot, 'format/stack-trace-decoder.js'))
  const TraceEventDecoder = require(path.join(bubbleRoot, 'format/trace-event-decoder.js'))
  const systemInfoReader = fs.createReadStream(paths['/systeminfo']).pipe(new SystemInfoDecoder())
  const stackTraceReader = fs.createReadStream(paths['/stacktrace']).pipe(new StackTraceDecoder())
  const traceEventReader = fs.createReadStream(paths['/traceevent']).pipe(new TraceEventDecoder())
  const analysis = require(path.join(bubbleRoot, 'analysis/index.js'))(systemInfoReader, stackTraceReader, traceEventReader)
  const clusters = await readObjectStream(analysis, 10000)
  const nodes = clusters.map(cluster => typeof cluster.toJSON === 'function' ? cluster.toJSON() : cluster)
  const sourceNodeCount = nodes.reduce((count, cluster) => count + (cluster.nodes || []).reduce((sum, node) => sum + (node.sources || []).length, 0), 0)
  return { nodes, source_node_count: sourceNodeCount, runtime_ms: analysis.runtime, http_requests: analysis.httpRequests || [] }
}

async function analyzeHeapProfiler (snapshotPath) {
  const { analyse } = require('@clinic/heap-profiler/src/analysis/index.js')
  const data = await new Promise((resolve, reject) => analyse(snapshotPath, (error, result) => error ? reject(error) : resolve(result)))
  return { data: data.data, node_count: countHeapNodes(data.data), total_retained_bytes: Number(data.data && data.data.value) || 0 }
}

function countHeapNodes (root) {
  let count = 0
  const stack = root ? [root] : []
  while (stack.length) {
    const node = stack.pop()
    count++
    for (const child of node.children || []) stack.push(child)
  }
  return count
}

async function collectClinicProfilerDirect (profiler, options) {
  if (!PROFILERS.includes(profiler)) {
    const error = new Error(`unsupported Clinic profiler: ${profiler}`)
    error.code = 'UNSUPPORTED_PROFILER'
    throw error
  }
  if (profiler === 'clinic-flame') return require('./profile-flame-collector').collectClinicFlame(options)

  if (profiler === 'clinic-doctor') {
    const artifactDir = await collectWith(require('@clinic/doctor'), options)
    return { artifactDir, profiler, profile: await analyzeDoctor(artifactDir) }
  }
  if (profiler === 'clinic-bubbleprof') {
    const artifactDir = await collectWith(require('@clinic/bubbleprof'), options)
    return { artifactDir, profiler, profile: await analyzeBubbleprof(artifactDir) }
  }

  const snapshotPath = await collectWith(require('@clinic/heap-profiler'), options)
  return { artifactDir: path.dirname(snapshotPath), artifactPath: snapshotPath, profiler, profile: await analyzeHeapProfiler(snapshotPath) }
}

function collectClinicProfiler (profiler, options = {}) {
  if (!PROFILERS.includes(profiler)) {
    const error = new Error(`unsupported Clinic profiler: ${profiler}`)
    error.code = 'UNSUPPORTED_PROFILER'
    return Promise.reject(error)
  }
  const nonce = crypto.randomBytes(8).toString('hex')
  const dest = path.resolve(options.dest || process.cwd())
  const inputPath = path.join(dest, `.clinic-worker-${nonce}.json`)
  const resultPath = path.join(dest, `.clinic-worker-${nonce}.result.json`)
  const workerPath = path.resolve(__dirname, '../bin/profile-clinic-worker.js')
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000

  return (async () => {
    await fsp.writeFile(inputPath, JSON.stringify({ profiler, options: { ...options, signal: undefined } }), { mode: 0o600, flag: 'wx' })
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath, inputPath, resultPath], {
          cwd: process.cwd(),
          env: { PATH: `${path.dirname(options.nodePath)}:/usr/bin:/bin`, ...(options.env || {}) },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'pipe']
        })
        let stderr = ''
        let settled = false
        let timedOut = false
        let cancelled = false
        child.stderr.on('data', chunk => { stderr += chunk.toString() })
        const terminate = () => {
          try {
            if (process.platform === 'win32') child.kill('SIGTERM')
            else process.kill(-child.pid, 'SIGTERM')
          } catch {}
          const killTimer = setTimeout(() => {
            try {
              if (process.platform === 'win32') child.kill('SIGKILL')
              else process.kill(-child.pid, 'SIGKILL')
            } catch {}
          }, 250)
          killTimer.unref()
        }
        const onAbort = () => {
          cancelled = true
          terminate()
        }
        if (options.signal) {
          if (options.signal.aborted) onAbort()
          else options.signal.addEventListener('abort', onAbort, { once: true })
        }
        const timer = setTimeout(() => {
          timedOut = true
          terminate()
        }, timeoutMs)
        child.once('error', error => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (options.signal) options.signal.removeEventListener('abort', onAbort)
          reject(error)
        })
        child.once('close', async (code, signal) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (options.signal) options.signal.removeEventListener('abort', onAbort)
          if (timedOut || cancelled || code !== 0) {
            if (timedOut || cancelled) {
              const error = new Error(timedOut ? 'Clinic profiler timed out' : 'Clinic profiling was cancelled')
              error.code = timedOut ? 'PROFILE_TIMEOUT' : 'PROFILE_CANCELLED'
              return reject(error)
            }
          }
          try {
            const result = JSON.parse(await fsp.readFile(resultPath, 'utf8'))
            if (result.error) {
              const error = new Error(result.error.message)
              error.code = result.error.code || 'PROFILE_FAILED'
              throw error
            }
            if (code !== 0) throw new Error(stderr.trim() || `Clinic profiler exited with code ${code || signal}`)
            resolve(result.value)
          } catch (error) {
            if (error.code === 'ENOENT' && code !== 0) {
              error.message = stderr.trim() || `Clinic profiler exited with code ${code || signal}`
              error.code = 'PROFILE_FAILED'
            }
            reject(error)
          }
        })
      })
    } finally {
      await Promise.all([fsp.rm(inputPath, { force: true }), fsp.rm(resultPath, { force: true })])
    }
  })()
}

module.exports = { PROFILERS, collectClinicProfiler, collectClinicProfilerDirect, analyzeDoctor, analyzeBubbleprof, analyzeHeapProfiler }
