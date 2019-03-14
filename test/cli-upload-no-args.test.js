'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic upload', function (t) {
  cli({}, ['clinic', 'upload'], function (err, stdout) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Upload[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
