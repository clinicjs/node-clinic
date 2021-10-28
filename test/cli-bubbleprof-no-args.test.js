'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof', function (t) {
  cli({}, ['clinic', 'bubbleprof'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js BubbleProf[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
