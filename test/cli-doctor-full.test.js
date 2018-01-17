'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor -- node - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+.clinic-doctor)/)[1]

    t.strictEqual(stdout.split('\n')[0], 'analysing data')
    t.ok(stdout.split('\n')[1], `generated HTML file is ${dirname}.html`)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, dirname + '.html'), done)
      }
    }, function (err) {
      t.ifError(err)
      t.end()
    })
  })
})

test('clinic doctor -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, '')
    t.ok(stderr.includes('process exited with exit code 1'))
    t.end()
  })
})

test('clinic doctor -- node - visualization error', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', `
      const fs = require('fs')
      const path = require('path')

      // Delete the systeminfo file, such that the visualizer fails.
      fs.unlinkSync(path.join(
        process.pid + '.clinic-doctor',
        process.pid + '.clinic-doctor-systeminfo'
      ))
    `
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, 'analysing data\n')
    t.ok(stderr.includes('ENOENT: no such file or directory'))
    t.end()
  })
})
