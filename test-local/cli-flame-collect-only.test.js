'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('../test/cli.js')

test('clinic flame --collect-only - no issues', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+\.clinic-flame)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.ifError(err)
      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.strictEqual(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})

test('clinic flame --collect-only - bad status code', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--collect-only',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, 'To stop data collection press: Ctrl + C\n')
    t.ok(stderr.includes('subprocess error, code: 1'))
    t.end()
  })
})
