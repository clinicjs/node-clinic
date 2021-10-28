'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic --version', function (t) {
  cli({}, ['clinic', '--version'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('../package.json').version}\n`
    )
    t.end()
  })
})

test('clinic -v', function (t) {
  cli({}, ['clinic', '-v'], function (err, stdout) {
    t.error(err)
    t.equal(
      stdout,
      `v${require('../package.json').version}\n`
    )
    t.end()
  })
})
