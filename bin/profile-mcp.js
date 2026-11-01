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
const { readRepositoryMetadata, hashExecutable } = require('../lib/profile-reproducibility')

async function main () {
  const manifestPath = process.env.CLINIC_PROFILE_MANIFEST || 'profile-workloads.json'
  const loaded = loadManifest(manifestPath, { trustedRoot: process.cwd() })
  const workspaceRoot = path.resolve(process.env.CLINIC_PROFILE_WORKSPACE || process.cwd())
  const repository = readRepositoryMetadata(workspaceRoot)
  const runtime = { node_version: `node-${process.version}`, toolchain_digest: await hashExecutable(process.execPath) }
  const runRoot = path.resolve(process.env.CLINIC_PROFILE_RUN_ROOT || path.join(process.cwd(), '.clinic-runs'))
  const strictIsolation = process.env.CLINIC_PROFILE_ISOLATION !== 'disabled'
  let isolationProvider
  if (strictIsolation && process.env.CLINIC_PROFILE_ISOLATION_PROVIDER) {
    const providerModule = require(path.resolve(process.env.CLINIC_PROFILE_ISOLATION_PROVIDER))
    isolationProvider = typeof providerModule.createProvider === 'function'
      ? providerModule.createProvider({ workspaceRoot, runtimeRoot: path.dirname(process.execPath), runRoot })
      : providerModule
  } else if (strictIsolation && process.env.CLINIC_PROFILE_SUPERVISOR === 'systemd-bwrap') {
    isolationProvider = createLinuxIsolationProvider({
      supervisor: createBubblewrapSupervisor({
        workspaceRoot,
        runtimeRoot: path.dirname(process.execPath),
        cgroupSupervisor: createSystemdCgroupSupervisor()
      })
    })
  }
  const runManager = runner.createRunManager(async options => {
    const profiler = options.profiler || 'clinic-flame'
    if (!PROFILERS.includes(profiler)) throw new Error(`unsupported Clinic profiler: ${profiler}`)
    const result = await runner.runWorkload({
      ...options,
      manifest: loaded.manifest,
      rootDir: workspaceRoot,
      runRoot,
      collector: collectorOptions => collectClinicProfiler(profiler, collectorOptions)
    })
    if (result && result.status === 'completed' && result.profile) {
      const elapsed = result.startedAt && result.finishedAt
        ? Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt))
        : 0
      const duration = Number.isFinite(result.profile.duration_ms) ? result.profile.duration_ms : elapsed
      result.report = analyzeClinicDiagnostics(profiler, { ...result.profile, duration_ms: duration }, {
        workload: result.workload,
        profiler,
        manifest_hash: loaded.hash,
        commit: repository.revision,
        repository: repository.identity,
        runtime,
        isolation: createIsolationMetadata({ strictIsolation, isolationProvider, workload: loaded.manifest.profile_workloads[options.workload] }),
        artifact_ref: result.artifactRef,
        input: JSON.stringify(options.parameters || {}),
        sample_count: result.profile.sample_count,
        started_at: result.startedAt,
        finished_at: result.finishedAt
      })
    }
    return result
  })
  const server = new ProfileMcpServer({
    workloads: loaded.manifest.profile_workloads,
    isolationProvider,
    strictIsolation,
    runner: {
      start: options => runManager.start(options),
      status: runId => runManager.status(runId),
      cancel: runId => runManager.cancel(runId)
    },
    analyzer: {
      compare: compareReports,
      detail: findingDetail
    }
  })
  await serveSdk(server)
}

function createIsolationMetadata ({ strictIsolation, isolationProvider, workload }) {
  const provider = strictIsolation ? isolationProvider : { name: 'direct-host', version: '1' }
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
