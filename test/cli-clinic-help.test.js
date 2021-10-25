'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic --help', function (t) {
  cli({}, ['clinic', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic -h', function (t) {
  cli({}, ['clinic', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
