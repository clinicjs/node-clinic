'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof --version', function (t) {
  cli({}, ['clinic', 'bubbleprof', '--version'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/bubbleprof/package.json').version}\n`
    )
    t.end()
  })
})

test('clinic bubbleprof -v', function (t) {
  cli({}, ['clinic', 'bubbleprof', '-v'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(
      stdout,
      `v${require('@nearform/bubbleprof/package.json').version}\n`
    )
    t.end()
  })
})
