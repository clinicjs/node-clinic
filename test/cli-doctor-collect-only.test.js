'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --collect-only - no issues', function (t) {
  cli({}, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    t.ok(/Output file is (\d+).clinic-doctor/.test(stdout))

    const dirname = stdout.match(/(\d+.clinic-doctor)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.ifError(err)

      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.strictEqual(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})

test('clinic doctor --collect-only - bad status code', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, 'To generate the report press: Ctrl + C\n')
    t.ok(stderr.includes('process exited with exit code 1'))
    t.end()
  })
})
