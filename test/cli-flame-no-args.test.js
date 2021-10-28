'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame', function (t) {
  cli({}, ['clinic', 'flame'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Flame[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
