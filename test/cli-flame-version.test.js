'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame --version', function (t) {
  cli({}, ['clinic', 'flame', '--version'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('@clinic/flame/version')}\n`
    )
    t.end()
  })
})

test('clinic flame -v', function (t) {
  cli({}, ['clinic', 'flame', '-v'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('@clinic/flame/version')}\n`
    )
    t.end()
  })
})
