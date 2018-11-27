'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof -- node - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'bubbleprof', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+.clinic-bubbleprof)/)[1]

    t.strictEqual(stdout.split('\n')[1], 'Analysing data')
    t.strictEqual(stdout.split('\n')[2], `Generated HTML file is ${dirname}.html`)

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

test('clinic bubbleprof -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--no-open',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+.clinic-bubbleprof)/)[1]

    t.strictEqual(stdout.split('\n')[1], 'Analysing data')
    t.strictEqual(stdout.split('\n')[2], `Generated HTML file is ${dirname}.html`)

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

test('clinic bubbleprof -- node - visualization error', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--no-open',
    '--', 'node', '-e', `
      const fs = require('fs')
      const path = require('path')

      // Delete the systeminfo file, such that the visualizer fails.
      fs.unlinkSync(path.join(
        process.pid + '.clinic-bubbleprof',
        process.pid + '.clinic-bubbleprof-systeminfo'
      ))
    `
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, 'To generate the report press: Ctrl + C\nAnalysing data\n')
    t.ok(stderr.includes('ENOENT: no such file or directory'))
    t.end()
  })
})

test('clinic bubbleprof -- node - configure output destination', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--no-open',
    '--dest', 'test-bubbleprof-destination',
    '--', 'node', '-e', 'setTimeout(() => {}, 200)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const basename = stdout.match(/(\d+.clinic-bubbleprof)/)[1]
    t.ok(fs.statSync(path.join(tempdir, 'test-bubbleprof-destination', basename)).isDirectory())
    t.ok(fs.statSync(path.join(tempdir, 'test-bubbleprof-destination', `${basename}.html`)).isFile())
    t.end()
  })
})
