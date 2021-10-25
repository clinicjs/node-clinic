'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --help', function (t) {
  cli({}, ['clinic', 'doctor', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Doctor[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic doctor -h', function (t) {
  cli({}, ['clinic', 'doctor', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Doctor[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
