'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic clean --help', function (t) {
  cli({}, ['clinic', 'clean', '--help'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Clean[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic clean -h', function (t) {
  cli({}, ['clinic', 'clean', '-h'], function (err, stdout) {
    t.error(err)
    t.ok(/Clinic.js Clean[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
