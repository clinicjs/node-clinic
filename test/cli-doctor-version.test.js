'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --version', function (t) {
  cli({}, ['clinic', 'doctor', '--version'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/doctor/package.json').version}\n`
    )
    t.end()
  })
})

test('clinic doctor -v', function (t) {
  cli({}, ['clinic', 'doctor', '-v'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/doctor/package.json').version}\n`
    )
    t.end()
  })
})
