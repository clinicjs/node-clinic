'use strict'

const path = require('node:path')

function commandMetadata (workload) {
  const configuredExecutable = workload && workload.executable
  const executable = configuredExecutable === 'node'
    ? 'node'
    : typeof configuredExecutable === 'string' && path.isAbsolute(configuredExecutable) ? 'configured-executable' : (configuredExecutable || 'configured-executable')
  const cwd = workload && workload.cwd && workload.cwd.startsWith('/workspace')
    ? workload.cwd.slice('/workspace'.length).replace(/^\//, '') || '.'
    : '.'
  return {
    executable,
    working_directory: cwd,
    argument_count: workload && Array.isArray(workload.argv) ? workload.argv.length : 0
  }
}

function parameterMetadata (parameters) {
  return Object.fromEntries(Object.entries(parameters || {}).sort(([left], [right]) => left.localeCompare(right)))
}

module.exports = { commandMetadata, parameterMetadata }
