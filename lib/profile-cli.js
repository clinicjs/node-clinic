'use strict'

const fs = require('fs/promises')
const path = require('path')

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
  if (result.profiler !== 'clinic-flame') throw new Error('only clinic-flame is supported by the MVP')
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
  const runner = require('./profile-runner.js')
  const run = runner.runProfile || runner.run || runner
  if (typeof run !== 'function') throw new Error('profile runner does not expose runProfile()')
  const result = await run({
    manifest: loaded.manifest,
    manifestPath: loaded.absolute,
    workload: args.workload,
    profiler: args.profiler,
    parameters: parameterObject(args.params),
    collector: args.profiler === 'clinic-flame' ? require('./profile-flame-collector').collectClinicFlame : null
  })
  const { analyzeClinicFlame } = require('./profile-analyzer.js')
  const report = analyzeClinicFlame({
    duration_ms: result.finishedAt && result.startedAt ? Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)) : 0,
    nodes: result.profile && result.profile.nodes ? result.profile.nodes : [],
    sample_count: result.profile && result.profile.sample_count,
    throughput: null
  }, {
    run_id: result.runId,
    workload: args.workload,
    profiler: args.profiler,
    commit: '0000000000000000000000000000000000000000',
    artifact_ref: result.artifactRef,
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
  const serialized = JSON.stringify(report, null, 2) + '\n'
  if (args.output) await fs.writeFile(path.resolve(args.output), serialized, { flag: 'wx', mode: 0o600 })
  else stdout.write(serialized)
  return result.status === 'completed' ? 0 : 1
}

module.exports = { parseArgs, loadManifest, parameterObject, runCli, usage }
