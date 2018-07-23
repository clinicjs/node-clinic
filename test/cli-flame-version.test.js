'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame --version', function (t) {
  cli({}, ['clinic', 'flame', '--version'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/flame/version')}\n`
    )
    t.end()
  })
})

test('clinic flame -v', function (t) {
  cli({}, ['clinic', 'flame', '-v'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/flame/version')}\n`
    )
    t.end()
  })
})
