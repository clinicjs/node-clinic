'use strict'

const test = require('tap').test
const { analyzeClinicFlame } = require('../lib/profile-analyzer')
const { validateToolResponse } = require('../lib/profile-runtime-schemas')

function envelope (data) {
  return { request_id: 'req-1', ok: true, data, error: null, usage: null }
}

test('runtime validation accepts an analyzer report and rejects semantic inconsistencies', t => {
  const report = analyzeClinicFlame({ nodes: [] }, { workload: 'fibonacci' })
  report.summary.measurement_environment = {
    isolation_mode: 'systemd-bubblewrap',
    scheduler_mode: 'systemd-cgroup-cpu-quota',
    start: { cpu_affinity: '0-7', cpu_governor: null, cpu_frequency_khz: null, thermal_millicelsius: null },
    finish: { cpu_affinity: '0-7', cpu_governor: null, cpu_frequency_khz: null, thermal_millicelsius: null },
    limitations: ['host conditions can change during a profile']
  }
  t.same(validateToolResponse('get_profile_status', envelope(report)), [])

  report.summary.measurement = {
    samples: [10, 12],
    sample_count: 2,
    warmup_count: 0,
    value_field: 'throughput',
    max_wall_clock_ms: 1000,
    elapsed_ms: 200
  }
  report.summary.throughput = {
    value: 10,
    unit: 'iterations_per_second',
    definition: 'completed iterations per second'
  }
  const errors = validateToolResponse('get_profile_status', envelope(report))
  t.equal(errors.some(error => error.message.includes('median')), true)
  t.end()
})

test('report validation rejects confidence not supported by recorded adapter evidence', t => {
  const report = analyzeClinicFlame({ nodes: [{ name: 'hot', total_time_pct: 40 }] }, { workload: 'fibonacci', sample_count: 1 })
  report.findings[0].confidence = 'high'
  t.match(validateToolResponse('get_profile_status', envelope(report)), [{ message: /confidence does not match/ }])
  t.end()
})

test('runtime validation checks the formal findings page schema', t => {
  const page = {
    run_id: 'run-1',
    classification: 'sensitive-diagnostic',
    snapshot_id: 'snapshot-1',
    sort: 'impact_desc',
    expires_at: new Date().toISOString(),
    items: [],
    next_cursor: null,
    has_more: false,
    truncated: false,
    low_information: false
  }
  t.same(validateToolResponse('get_profile_findings', envelope(page)), [])
  page.sort = ''
  t.equal(validateToolResponse('get_profile_findings', envelope(page)).length > 0, true)
  page.sort = 'impact_desc'
  page.items = [{ id: 'duplicate' }, { id: 'duplicate' }]
  t.equal(validateToolResponse('get_profile_findings', envelope(page)).some(error => error.message.includes('unique')), true)
  page.items = []
  page.has_more = true
  t.equal(validateToolResponse('get_profile_findings', envelope(page)).some(error => error.message.includes('next_cursor')), true)
  page.has_more = false
  page.truncated = true
  t.equal(validateToolResponse('get_profile_findings', envelope(page)).some(error => error.message.includes('compacted')), true)
  t.end()
})

test('runtime validation checks queued and running status against its formal schema', t => {
  const status = {
    run_id: 'run-1',
    run_capability: 'capability-1',
    status: 'running',
    created_at: new Date().toISOString(),
    progress_pct: 25,
    phase: 'profiling'
  }
  t.same(validateToolResponse('get_profile_status', envelope(status)), [])
  status.wait_timed_out = true
  status.elapsed_ms = 100
  status.next_poll_after_ms = 50
  t.same(validateToolResponse('wait_profile_run', envelope(status)), [])
  delete status.wait_timed_out
  delete status.elapsed_ms
  delete status.next_poll_after_ms
  status.phase = 'arbitrary-phase'
  t.equal(validateToolResponse('get_profile_status', envelope(status)).length > 0, true)
  t.end()
})
