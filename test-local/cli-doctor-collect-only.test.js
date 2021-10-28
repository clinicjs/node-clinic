'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('../test/cli.js')

test('clinic doctor --collect-only --dest \'./foo\' - no issues', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only', '--dest', './foo',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const dirname = stdout.match(/(\d+\.clinic.doctor)/)[1]
    fs.access(path.resolve(tempdir, 'foo', dirname), function (err) {
      t.error(err)
      fs.access(path.resolve(tempdir, 'foo', dirname + '.html'), function (err) {
        t.equal(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})

test('clinic doctor --collect-only - bad status code', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only', '--dest', './foo',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr, tempdir) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, 'To stop data collection press: Ctrl + C\n')
    t.ok(stderr.includes('process exited with exit code 1'))
    t.end()
  })
})
