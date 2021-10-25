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
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-doctor/.test(stdout))

    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.error(err)

      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.equal(err.code, 'ENOENT')
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
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-doctor/.test(stdout))

    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.error(err)

      fs.access(path.resolve(tempdir, dirname + '.html'), function (err) {
        t.equal(err.code, 'ENOENT')
        t.end()
      })
    })
  })
})

test('clinic doctor --collect-only - signal', {
  skip: process.platform === 'win32' ? 'SIGKILL cannot be identified on windows' : false
}, function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'process.kill(process.pid, "SIGKILL")'
  ], function (err, stdout, stderr) {
    // check exit code of `clinic doctor` itself
    t.strictSame(err, new Error('process exited with exit code 1'))
    // check exit output for the child process
    t.match(stderr, 'Error: process exited by signal SIGKILL')
    t.equal(stdout, 'To stop data collection press: Ctrl + C\n')
    t.end()
  })
})
