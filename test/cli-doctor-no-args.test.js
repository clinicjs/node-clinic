'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor', function (t) {
  cli({}, ['clinic', 'doctor'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Doctor[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
