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

async function main () {
  const manifestPath = process.env.CLINIC_PROFILE_MANIFEST || 'profile-workloads.json'
  const loaded = loadManifest(manifestPath, { trustedRoot: process.cwd() })
  const workspaceRoot = path.resolve(process.env.CLINIC_PROFILE_WORKSPACE || process.cwd())
  const runRoot = path.resolve(process.env.CLINIC_PROFILE_RUN_ROOT || path.join(process.cwd(), '.clinic-runs'))
  const strictIsolation = process.env.CLINIC_PROFILE_ISOLATION !== 'disabled'
  const isolationProvider = strictIsolation && process.env.CLINIC_PROFILE_SUPERVISOR === 'systemd-bwrap'
    ? createLinuxIsolationProvider({
      supervisor: createBubblewrapSupervisor({
        workspaceRoot,
        runtimeRoot: path.dirname(process.execPath),
        cgroupSupervisor: createSystemdCgroupSupervisor()
      })
    })
    : undefined
  const server = new ProfileMcpServer({
    workloads: loaded.manifest.profile_workloads,
    isolationProvider,
    strictIsolation,
    runner: {
      start: async options => {
        const profiler = options.profiler || 'clinic-flame'
        if (!PROFILERS.includes(profiler)) throw new Error(`unsupported Clinic profiler: ${profiler}`)
        const result = await runner.start({
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
            artifact_ref: result.artifactRef,
            input: JSON.stringify(options.parameters || {}),
            sample_count: result.profile.sample_count,
            started_at: result.startedAt,
            finished_at: result.finishedAt
          })
        }
        return result
      },
      status: async () => null,
      cancel: async () => {}
    },
    analyzer: {
      compare: compareReports,
      detail: findingDetail
    }
  })
  await serveSdk(server)
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
