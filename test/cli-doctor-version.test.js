'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --version', function (t) {
  cli({}, ['clinic', 'doctor', '--version'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('@clinic/doctor/package.json').version}\n`
    )
    t.end()
  })
})

test('clinic doctor -v', function (t) {
  cli({}, ['clinic', 'doctor', '-v'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('@clinic/doctor/package.json').version}\n`
    )
    t.end()
  })
})
