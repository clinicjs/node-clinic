'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame --help', function (t) {
  cli({}, ['clinic', 'flame', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Flame[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic flame -h', function (t) {
  cli({}, ['clinic', 'flame', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Flame[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
