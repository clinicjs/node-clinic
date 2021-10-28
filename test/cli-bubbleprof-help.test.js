'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof --help', function (t) {
  cli({}, ['clinic', 'bubbleprof', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js BubbleProf[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic bubbleprof -h', function (t) {
  cli({}, ['clinic', 'bubbleprof', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js BubbleProf[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
