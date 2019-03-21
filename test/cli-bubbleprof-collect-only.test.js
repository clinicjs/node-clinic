'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof --collect-only - no issues', function (t) {
  cli({}, [
    'clinic', 'bubbleprof', '--collect-only', '--debug',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-bubbleprof/.test(stdout))

    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.ifError(err)

      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.strictEqual(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})

test('clinic bubbleprof --collect-only - bad status code', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--collect-only',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-bubbleprof/.test(stdout))

    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.ifError(err)

      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.strictEqual(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})
