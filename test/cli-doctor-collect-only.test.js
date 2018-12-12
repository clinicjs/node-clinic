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

test('clinic doctor --collect-only - signal', {
  skip: process.platform === 'win32' ? 'SIGKILL cannot be identified on windows' : false
}, function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'process.kill(process.pid, "SIGKILL")'
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited by signal SIGKILL'))
    t.strictEqual(stdout, 'To stop data collection press: Ctrl + C\n')
    t.end()
  })
})

test('clinic doctor --collect-only - stop early using SIGINT', { timeout: 30000 }, function (t) {
  cli({}, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'console.log("SIGINT me"); setTimeout(() => {}, 60000)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    t.ok(/Output file is (\d+).clinic-doctor/.test(stdout))
    t.ok(/Received Ctrl\+C/.test(stdout))

    const dirname = stdout.match(/(\d+.clinic-doctor)/)[1]
    fs.access(path.resolve(tempdir, dirname), function (err) {
      t.ifError(err)
      t.end()
    })
  }).on('spawn', (program) => {
    program.stdout.on('data', function ondata (line) {
      if (/SIGINT me/.test(line + '')) {
        program.stdout.removeListener('data', ondata)
        program.kill('SIGINT')
      }
    })
  })
})
