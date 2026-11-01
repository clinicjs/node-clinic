#!/usr/bin/env node
'use strict'

const { loadManifest } = require('../lib/profile-manifest')
const { ProfileMcpServer } = require('../lib/profile-mcp')
const { serveSdk } = require('../lib/profile-mcp-sdk')
const runner = require('../lib/profile-runner')
const { collectClinicProfiler, PROFILERS } = require('../lib/profile-clinic-collector')
const path = require('node:path')
const { compareReports, findingDetail, analyzeClinicDiagnostics } = require('../lib/profile-analyzer')
const { createLinuxIsolationProvider, createBubblewrapSupervisor, createSystemdCgroupSupervisor } = require('../lib/profile-isolation-provider')
const { readRepositoryMetadata, hashDependencyTree, combineToolchainDigest, readHostMeasurementConditions, createMeasurementEnvironment } = require('../lib/profile-reproducibility')
const { pinExecutable } = require('../lib/profile-executable')
const { createSourceRoots } = require('../lib/profile-source-roots')
const { commandMetadata, parameterMetadata } = require('../lib/profile-command')

async function main () {
  const manifestPath = process.env.CLINIC_PROFILE_MANIFEST || 'profile-workloads.json'
  const loaded = loadManifest(manifestPath, { trustedRoot: process.cwd() })
  const workspaceRoot = path.resolve(process.env.CLINIC_PROFILE_WORKSPACE || process.cwd())
  const declaredInputRoot = process.env.CLINIC_PROFILE_INPUT_ROOT ? path.resolve(process.env.CLINIC_PROFILE_INPUT_ROOT) : null
  const sourceRootsForWorkload = workloadId => createSourceRoots(loaded.manifest.profile_workloads[workloadId], workspaceRoot, declaredInputRoot)
  const repository = readRepositoryMetadata(workspaceRoot)
  const workerExecutablePin = await pinExecutable(process.execPath)
  const clinicDependencies = path.resolve(__dirname, '../node_modules')
  const dependencyDigest = await hashDependencyTree(clinicDependencies)
  const toolchainDigest = combineToolchainDigest(workerExecutablePin.hash, dependencyDigest)
  const runtimeRoot = path.dirname(workerExecutablePin.path)
  const runtime = { node_version: `node-${process.version}`, toolchain_digest: toolchainDigest }
  const runRoot = path.resolve(process.env.CLINIC_PROFILE_RUN_ROOT || path.join(process.cwd(), '.clinic-runs'))
  await runner.recoverArtifactStaging(runRoot)
  await runner.cleanupExpiredArtifactRuns(runRoot)
  const retentionSweep = setInterval(() => {
    runner.cleanupExpiredArtifactRuns(runRoot).catch(error => {
      process.stderr.write(`profile-mcp: expired artifact cleanup failed (${error.code || 'ARTIFACT_CLEANUP_FAILED'})\n`)
    })
  }, 60 * 60 * 1000)
  retentionSweep.unref()
  // MCP-triggered runs always require the declared isolation policy. Manual
  // host profiling remains available through the profile:clinic CLI.
  const strictIsolation = true
  let isolationProvider
  if (strictIsolation && process.env.CLINIC_PROFILE_ISOLATION_PROVIDER) {
    const providerModule = require(path.resolve(process.env.CLINIC_PROFILE_ISOLATION_PROVIDER))
    isolationProvider = typeof providerModule.createProvider === 'function'
      ? providerModule.createProvider({ workspaceRoot, runtimeRoot, runRoot, declaredInputRoot, workerExecutablePin })
      : providerModule
  } else if (strictIsolation && process.env.CLINIC_PROFILE_SUPERVISOR === 'systemd-bwrap') {
    isolationProvider = createLinuxIsolationProvider({
      name: 'systemd-bubblewrap',
      version: '1',
      atomicExec: true,
      atomicTargetExec: true,
      completeInputFilesystem: true,
      supervisor: createBubblewrapSupervisor({
        workspaceRoot,
        runtimeRoot,
        declaredInputRoot,
        workerExecutablePin,
        cgroupSupervisor: createSystemdCgroupSupervisor()
      })
    })
  }
  const runManager = runner.createRunManager(async options => {
    const profiler = options.profiler || 'clinic-flame'
    if (!PROFILERS.includes(profiler)) throw new Error(`unsupported Clinic profiler: ${profiler}`)
    const conditionsStart = readHostMeasurementConditions()
    const result = await runner.runWorkload({
      ...options,
      manifest: loaded.manifest,
      manifestSource: loaded,
      rootDir: workspaceRoot,
      runtimeRoot,
      runRoot,
      collector: collectorOptions => collectClinicProfiler(profiler, collectorOptions)
    })
    if (result && result.status === 'completed' && result.profile) {
      const elapsed = result.startedAt && result.finishedAt
        ? Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt))
        : 0
      const duration = Number.isFinite(result.profile.duration_ms) ? result.profile.duration_ms : elapsed
      result.report = analyzeClinicDiagnostics(profiler, { ...result.profile, duration_ms: duration }, {
        run_id: result.runId,
        workload: result.workload,
        profiler,
        command: commandMetadata(loaded.manifest.profile_workloads[options.workload]),
        parameters: parameterMetadata(options.parameters),
        source_roots: sourceRootsForWorkload(options.workload),
        manifest_hash: loaded.hash,
        commit: repository.revision,
        repository: repository.identity,
        runtime,
        isolation: createIsolationMetadata({ isolationProvider, workload: loaded.manifest.profile_workloads[options.workload] }),
        artifact_ref: result.artifactRef,
        input_digest: result.inputDigest,
        input: JSON.stringify(options.parameters || {}),
        measurement_environment: createMeasurementEnvironment({
          isolationMode: isolationProvider ? isolationProvider.name : 'direct-host',
          schedulerMode: isolationProvider && isolationProvider.name === 'systemd-bubblewrap' ? 'systemd-cgroup-cpu-quota' : isolationProvider ? 'provider-defined' : 'host-default',
          start: conditionsStart,
          finish: readHostMeasurementConditions()
        }),
        sample_count: result.profile.sample_count,
        measurement: result.measurement,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        exit_code: result.exitCode,
        termination_reason: result.terminationReason
      })
    }
    return result
  })
  const server = new ProfileMcpServer({
    workloads: loaded.manifest.profile_workloads,
    manifestHash: loaded.hash,
    artifactRoot: runRoot,
    isolationProvider,
    strictIsolation,
    runner: {
      start: options => runManager.start(options),
      status: runId => runManager.status(runId),
      cancel: runId => runManager.cancel(runId)
    },
    analyzer: {
      compare: compareReports,
      detail: (report, finding, options) => findingDetail(report, finding, { ...options, source_roots: sourceRootsForWorkload(report.run.workload) })
    }
  })
  await serveSdk(server)
}

function createIsolationMetadata ({ isolationProvider, workload }) {
  const provider = isolationProvider
  if (!provider || !provider.name || !provider.version) return null
  const limits = workload && workload.limits
  if (!limits || !workload.network) return null
  return {
    provider: provider.name,
    version: String(provider.version),
    limits: {
      wall_clock_ms: limits.wall_clock_ms,
      cpu_ms: limits.cpu_ms,
      memory_mb: limits.memory_mb,
      artifact_mb: limits.artifact_mb,
      network: workload.network
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
