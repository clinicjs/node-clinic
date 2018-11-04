'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic ask --help', function (t) {
  cli({}, ['clinic', 'ask', '--help'], function (err, stdout) {
    t.ifError(err)
    t.ok(/Clinic Ask[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic ask -h', function (t) {
  cli({}, ['clinic', 'ask', '-h'], function (err, stdout) {
    t.ifError(err)
    t.ok(/Clinic Ask[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
