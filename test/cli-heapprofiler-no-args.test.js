'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler', function (t) {
  cli({}, ['clinic', 'heapprofiler'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Heap Profiler[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
