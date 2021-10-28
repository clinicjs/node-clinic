'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof --collect-only - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'bubbleprof', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-bubbleprof/.test(stdout))
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({}, [
      'clinic', 'bubbleprof', '--visualize-only', dirpath
    ], function (err, stdout) {
      t.error(err)
      t.equal(
        stdout,
        `Generated HTML file is ${url.pathToFileURL(dirpath)}.html
`)

      // check that HTML file exists
      fs.access(dirpath + '.html', function (err) {
        t.error(err)
        t.end()
      })
    })
  })
})

test('clinic bubbleprof --collect-only - missing data', function (t) {
  const arg = 'missing.clinic-bubbleprof'
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--visualize-only', arg
  ], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, '')
    t.ok(stderr.includes('No data found.'))
    t.end()
  })
})

test('clinic bubbleprof --visualize-only - with trailing /', function (t) {
  // collect data
  cli({}, [
    'clinic', 'bubbleprof', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-bubbleprof/.test(stdout))
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({}, [
      'clinic', 'bubbleprof', '--visualize-only', `${dirpath}${path.sep}`
    ], function (err, stdout) {
      t.error(err)
      t.equal(
        stdout,
        `Generated HTML file is ${url.pathToFileURL(dirpath)}.html
`)

      // check that HTML file exists
      fs.access(dirpath + '.html', function (err) {
        t.error(err)
        t.end()
      })
    })
  })
})
