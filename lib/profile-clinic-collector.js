'use strict'

const fs = require('node:fs')
const path = require('node:path')
const pumpify = require('pumpify')
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
  return { ...results[0], sample_count: 0 }
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
  const sampleCount = nodes.reduce((count, cluster) => count + (cluster.nodes || []).reduce((sum, node) => sum + (node.sources || []).length, 0), 0)
  return { nodes, sample_count: sampleCount, runtime_ms: analysis.runtime, http_requests: analysis.httpRequests || [] }
}

async function analyzeHeapProfiler (snapshotPath) {
  const { analyse } = require('@clinic/heap-profiler/src/analysis/index.js')
  const data = await new Promise((resolve, reject) => analyse(snapshotPath, (error, result) => error ? reject(error) : resolve(result)))
  return { data: data.data, sample_count: countHeapNodes(data.data), total_retained_bytes: Number(data.data && data.data.value) || 0 }
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

async function collectClinicProfiler (profiler, options) {
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

module.exports = { PROFILERS, collectClinicProfiler, analyzeDoctor, analyzeBubbleprof, analyzeHeapProfiler }
