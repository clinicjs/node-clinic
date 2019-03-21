'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic upload --help', function (t) {
  cli({}, ['clinic', 'upload', '--help'], function (err, stdout) {
    t.ifError(err)
    t.ok(/Clinic.js Upload[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic upload -h', function (t) {
  cli({}, ['clinic', 'upload', '-h'], function (err, stdout) {
    t.ifError(err)
    t.ok(/Clinic.js Upload[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
