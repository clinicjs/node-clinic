'use strict'

const { spawn } = require('node:child_process')

const MAX_OUTPUT_BYTES = 8192

function median (values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function measurementError (code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function runOnce ({ nodePath, args, cwd, env, spawnProcess, signal }, deadline) {
  return new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return reject(measurementError('MEASUREMENT_TIMEOUT', 'measurement exceeded its wall-clock limit'))

    let child
    try {
      child = (spawnProcess || spawn)(nodePath, args, {
        cwd,
        env: { PATH: process.env.PATH || '', ...(env || {}) },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      return reject(measurementError('MEASUREMENT_SPAWN_FAILED', 'could not start the measurement workload'))
    }

    const stdout = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let oversized = false
    let timedOut = false
    let cancelled = false
    let settled = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, remainingMs)

    function terminate () {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch { try { child.kill('SIGTERM') } catch {} }
      killTimer = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch { try { child.kill('SIGKILL') } catch {} }
      }, 100)
      killTimer.unref()
    }

    function cleanup () {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    function onAbort () {
      cancelled = true
      terminate()
    }

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        oversized = true
        terminate()
      } else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        oversized = true
        terminate()
      }
    })
    child.once('error', () => {
      if (settled) return
      settled = true
      cleanup()
      reject(measurementError('MEASUREMENT_SPAWN_FAILED', 'could not start the measurement workload'))
    })
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (timedOut) return reject(measurementError('MEASUREMENT_TIMEOUT', 'measurement exceeded its wall-clock limit'))
      if (cancelled) return reject(measurementError('PROFILE_CANCELLED', 'measurement workload was cancelled'))
      if (oversized) return reject(measurementError('MEASUREMENT_OUTPUT_LIMIT', 'measurement output exceeded its size limit'))
      if (code !== 0) return reject(measurementError('MEASUREMENT_FAILED', `measurement workload exited with code ${code == null ? signal : code}`))
      resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

async function runMeasurementPlan (options, plan, throughput) {
  if (!plan) return null
  const startedAt = Date.now()
  const deadline = startedAt + plan.max_wall_clock_ms
  const samples = []
  const iterations = plan.warmup_runs + plan.measured_runs
  for (let index = 0; index < iterations; index++) {
    const stdout = await runOnce(options, deadline)
    let record
    try {
      record = JSON.parse(stdout.trim())
    } catch {
      throw measurementError('MEASUREMENT_INVALID_OUTPUT', 'measurement workload must write one JSON object to stdout')
    }
    if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.prototype.hasOwnProperty.call(record, plan.value_field)) {
      throw measurementError('MEASUREMENT_INVALID_OUTPUT', `measurement JSON must contain the declared ${plan.value_field} field`)
    }
    const value = record[plan.value_field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw measurementError('MEASUREMENT_INVALID_VALUE', 'measurement value must be a finite non-negative number')
    }
    if (index >= plan.warmup_runs) samples.push(value)
  }

  return {
    samples,
    sample_count: samples.length,
    warmup_count: plan.warmup_runs,
    value_field: plan.value_field,
    max_wall_clock_ms: plan.max_wall_clock_ms,
    elapsed_ms: Date.now() - startedAt,
    unit: throughput.unit,
    definition: throughput.definition,
    median: median(samples)
  }
}

module.exports = { MAX_OUTPUT_BYTES, median, runMeasurementPlan }
