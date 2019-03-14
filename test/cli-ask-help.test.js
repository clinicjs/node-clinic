'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic ask --help', function (t) {
  cli({}, ['clinic', 'ask', '--help'], function (err, stdout) {
    t.plan(2)
    t.ifError(err)
    t.ok(/Clinic.js Ask[^\w ]/.test(stdout.split('\n')[1]))
  })
})

test('clinic ask -h', function (t) {
  cli({}, ['clinic', 'ask', '-h'], function (err, stdout) {
    t.plan(2)
    t.ifError(err)
    t.ok(/Clinic.js Ask[^\w ]/.test(stdout.split('\n')[1]))
  })
})
