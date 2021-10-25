'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler --help', function (t) {
  cli({}, ['clinic', 'heapprofiler', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Heap Profiler[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic heapprofiler -h', function (t) {
  cli({}, ['clinic', 'heapprofiler', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Heap Profiler[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
