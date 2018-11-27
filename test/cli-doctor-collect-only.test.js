'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')
const os = require('os')

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

test('clinic doctor --collect-only - signal', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'process.kill(process.pid, 9)'
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited by signal SIGKILL'))
    t.strictEqual(stdout, 'To stop data collection press: Ctrl + C\n')
    if (os.platform().indexOf('win') !== 0) {
      t.ok(stderr.includes('process exited by signal SIGKILL'))
    }
    t.end()
  })
})
