'use strict'

const path = require('node:path')
const fs = require('node:fs/promises')
const ClinicFlame = require('@clinic/flame')
const analyse = require('@clinic/flame/analysis')

async function analyzeFlameArtifact (artifactDir) {
  const entries = await fs.readdir(artifactDir)
  const sampleName = entries.find(entry => entry.endsWith('.clinic-flame-samples'))
  const systemName = entries.find(entry => entry.endsWith('.clinic-flame-systeminfo'))
  const inlineName = entries.find(entry => entry.endsWith('.clinic-flame-inlinedfunctions'))
  if (!sampleName || !systemName || !inlineName) {
    const error = new Error('clinic-flame artifact is incomplete')
    error.code = 'PROFILE_NO_DATA'
    throw error
  }
  const data = await analyse({
    '/samples': path.join(artifactDir, sampleName),
    '/systeminfo': path.join(artifactDir, systemName),
    '/inlinedfunctions': path.join(artifactDir, inlineName)
  })
  const rootTotal = Number(data.merged && data.merged.onStack) || 0
  const samples = JSON.parse(await fs.readFile(path.join(artifactDir, sampleName), 'utf8'))
  let lastSampleTime = 0
  for (const stack of samples) {
    for (const frame of stack) {
      if (Number.isFinite(frame.tm)) lastSampleTime = Math.max(lastSampleTime, frame.tm)
    }
  }
  const nodes = []
  let nextNodeId = 0
  function visit (node, depth) {
    if (!node || depth > 100) return null
    const nodeId = `flame-node-${nextNodeId++}`
    const total = Number(node.onStack) || 0
    const self = (node.onStackTop && Number(node.onStackTop.base)) || 0
    const treeNode = {
      node_id: nodeId,
      name: node.functionName || node.name || 'anonymous',
      file: node.fullFileName || node.fileName || null,
      line: Number.isInteger(node.lineNumber) ? node.lineNumber : null,
      self_time_pct: rootTotal > 0 ? (self / rootTotal) * 100 : 0,
      total_time_pct: rootTotal > 0 ? (total / rootTotal) * 100 : 0,
      children: []
    }
    if (depth > 0) {
      nodes.push({
        ...treeNode,
        children: undefined,
        depth
      })
    }
    for (const child of node.children || []) {
      const childNode = visit(child, depth + 1)
      if (childNode) treeNode.children.push(childNode)
    }
    return treeNode
  }
  const callTree = visit(data.merged, 0)
  return { nodes, call_tree: callTree, sample_count: rootTotal, duration_ms: lastSampleTime / 1000, appName: data.appName }
}

function collectClinicFlame (options = {}) {
  if (typeof options.nodePath !== 'string' || !options.nodePath) throw new TypeError('nodePath is required')
  if (!Array.isArray(options.args)) throw new TypeError('args must be an array')
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120000
  const destination = path.resolve(options.dest || process.cwd())
  const flame = new ClinicFlame({
    dest: destination,
    name: options.name
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const originalWrite = process.stdout.write
    process.stdout.write = () => true
    const restoreStdout = () => {
      process.stdout.write = originalWrite
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      restoreStdout()
      const error = new Error('clinic-flame collection timed out')
      error.code = 'PROFILE_TIMEOUT'
      reject(error)
    }, timeoutMs)
    flame.collect([options.nodePath, ...options.args], (error, artifactDir) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      restoreStdout()
      if (error) return reject(error)
      const resolved = path.resolve(artifactDir)
      fs.readdir(resolved).then(entries => {
        const sampleName = entries.find(entry => entry.endsWith('.clinic-flame-samples'))
        if (!sampleName) {
          const missing = new Error('clinic-flame produced no samples')
          missing.code = 'PROFILE_NO_DATA'
          throw missing
        }
        return fs.readFile(path.join(resolved, sampleName), 'utf8').then(contents => {
          let samples
          try { samples = JSON.parse(contents) } catch { samples = null }
          if (!Array.isArray(samples) || samples.length === 0) {
            const missing = new Error('clinic-flame produced an empty sample set')
            missing.code = 'PROFILE_NO_DATA'
            throw missing
          }
          analyzeFlameArtifact(resolved).then(profile => resolve({ artifactDir: resolved, profiler: 'clinic-flame', profile })).catch(reject)
        })
      }).catch(reject)
    })
  })
}

module.exports = { collectClinicFlame, analyzeFlameArtifact }
