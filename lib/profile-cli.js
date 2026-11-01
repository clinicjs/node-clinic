'use strict'

const fs = require('fs/promises')
const path = require('path')
const { readRepositoryMetadata, hashExecutable, hashDependencyTree, combineToolchainDigest, readHostMeasurementConditions, createMeasurementEnvironment } = require('./profile-reproducibility')
const { createSourceRoots } = require('./profile-source-roots')
const { commandMetadata, parameterMetadata } = require('./profile-command')

function usage () {
  return [
    'Usage: profile-clinic --workload <name> [options]',
    '',
    'Options:',
    '  --manifest <file>       Workload manifest (default: profile-workloads.json)',
    '  --workload <name>       Registered workload key',
    '  --profiler <name>       Profiler (default: clinic-flame)',
    '  --param <name=value>    Workload parameter; may be repeated',
    '  --output <file>         Write report JSON (default: stdout)',
    '  --help                  Show this help'
  ].join('\n')
}

function parseArgs (argv) {
  const result = { params: [], profiler: 'clinic-flame', manifest: 'profile-workloads.json' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`)
    const key = arg.slice(2)
    if (!['manifest', 'workload', 'profiler', 'param', 'output'].includes(key)) throw new Error(`unknown option: --${key}`)
    const value = argv[++i]
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    if (key === 'param') {
      const separator = value.indexOf('=')
      if (separator <= 0) throw new Error('--param must use name=value')
      result.params.push([value.slice(0, separator), value.slice(separator + 1)])
    } else result[key] = value
  }
  if (!result.workload) throw new Error('--workload is required')
  if (!['clinic-doctor', 'clinic-bubbleprof', 'clinic-flame', 'clinic-heapprofiler'].includes(result.profiler)) throw new Error(`unsupported profiler: ${result.profiler}`)
  return result
}

async function loadManifest (manifestPath) {
  const { loadManifest: load } = require('./profile-manifest.js')
  const absolute = path.resolve(manifestPath)
  return load(absolute, { trustedRoot: path.dirname(absolute) })
}

function parameterObject (pairs) {
  const params = {}
  for (const [name, value] of pairs) {
    if (Object.prototype.hasOwnProperty.call(params, name)) throw new Error(`duplicate parameter: ${name}`)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid parameter name: ${name}`)
    if (!/^-?\d+$/.test(value)) throw new Error(`parameter ${name} must be an integer`)
    params[name] = Number(value)
  }
  return params
}

async function runCli (argv, io = {}) {
  const stdout = io.stdout || process.stdout
  const args = parseArgs(argv)
  if (args.help) {
    stdout.write(usage() + '\n')
    return 0
  }
  const loaded = await loadManifest(args.manifest)
  if (!loaded.manifest.profile_workloads[args.workload]) throw new Error(`unknown workload: ${args.workload}`)
  const repository = readRepositoryMetadata(path.dirname(loaded.path))
  const executableDigest = await hashExecutable(process.execPath)
  const dependencyDigest = await hashDependencyTree(path.resolve(__dirname, '../node_modules'))
  const runtime = { node_version: `node-${process.version}`, toolchain_digest: combineToolchainDigest(executableDigest, dependencyDigest) }
  const workload = loaded.manifest.profile_workloads[args.workload]
  const allowedProfilers = Array.isArray(workload.profilers) ? workload.profilers : ['clinic-flame']
  if (!allowedProfilers.includes(args.profiler)) throw new Error(`profiler ${args.profiler} is not enabled for workload ${args.workload}`)
  const conditionsStart = readHostMeasurementConditions()
  const runner = require('./profile-runner.js')
  const run = runner.runProfile || runner.run || runner
  if (typeof run !== 'function') throw new Error('profile runner does not expose runProfile()')
  const parameters = parameterObject(args.params)
  const result = await run({
    manifest: loaded.manifest,
    manifestSource: loaded,
    declaredInputRoot: process.env.CLINIC_PROFILE_INPUT_ROOT || null,
    workload: args.workload,
    profiler: args.profiler,
    parameters,
    collector: options => require('./profile-clinic-collector').collectClinicProfiler(args.profiler, options)
  })
  const { analyzeClinicDiagnostics } = require('./profile-analyzer.js')
  const report = analyzeClinicDiagnostics(args.profiler, {
    ...(result.profile || {}),
    duration_ms: result.finishedAt && result.startedAt ? Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)) : 0
  }, {
    run_id: result.runId,
    workload: args.workload,
    profiler: args.profiler,
    commit: repository.revision,
    repository: repository.identity,
    manifest_hash: loaded.hash,
    source_roots: createSourceRoots(workload, path.dirname(loaded.path), process.env.CLINIC_PROFILE_INPUT_ROOT || null),
    command: commandMetadata(workload),
    parameters: parameterMetadata(parameters),
    input_digest: result.inputDigest,
    measurement_environment: createMeasurementEnvironment({
      isolationMode: 'direct-host',
      schedulerMode: 'host-default',
      start: conditionsStart,
      finish: readHostMeasurementConditions()
    }),
    runtime,
    isolation: {
      provider: 'direct-host',
      version: '1',
      limits: { ...workload.limits, network: workload.network }
    },
    measurement: result.measurement,
    artifact_ref: result.artifactRef,
    exit_code: result.exitCode,
    termination_reason: result.terminationReason,
    now: result.startedAt || new Date().toISOString()
  })
  report.run.status = result.status
  report.run.lifecycle = { created_at: result.startedAt || new Date().toISOString(), finished_at: result.finishedAt || new Date().toISOString() }
  if (result.status !== 'completed') {
    report.run.error = { code: result.status, message: result.stderr || 'profile run failed', retryable: result.status === 'timed_out' }
    report.summary = null
    report.findings = null
    report.artifacts = result.artifact ? report.artifacts : null
  }
  const schemaErrors = require('./profile-runtime-schemas').validatePerformanceReport(report)
  if (schemaErrors.length) throw new Error(`profile report failed schema validation: ${schemaErrors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
  const serialized = JSON.stringify(report, null, 2) + '\n'
  if (args.output) await fs.writeFile(path.resolve(args.output), serialized, { flag: 'wx', mode: 0o600 })
  else stdout.write(serialized)
  return result.status === 'completed' ? 0 : 1
}

module.exports = { parseArgs, loadManifest, parameterObject, runCli, usage }
