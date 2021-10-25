'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --visualize-only - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 500)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-doctor/.test(stdout))
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({}, [
      'clinic', 'doctor', '--visualize-only', dirpath
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

test('clinic doctor --visualize-only - missing data', function (t) {
  const arg = 'missing.clinic-doctor'
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--visualize-only', arg
  ], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, '')
    t.ok(stderr.includes('No data found.'))
    t.end()
  })
})

test('clinic doctor --visualize-only - supports trailing slash', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 500)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    t.ok(/Output file is \.clinic[/\\](\d+).clinic-doctor/.test(stdout))
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({}, [
      'clinic', 'doctor', '--visualize-only', `${dirpath}${path.sep}`
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
