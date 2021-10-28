'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('../test/cli.js')

test('clinic flame --visualize-only - no issues', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const dirname = stdout.match(/(\d+\.clinic-flame)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({ relayStderr: false }, [
      'clinic', 'flame', '--visualize-only', dirpath
    ], function (err, stdout) {
      t.error(err)
      const htmlFilename = stdout.match(/(\d+\.clinic-flame)/)[1]

      // check that HTML file exists
      fs.access(path.resolve(tempdir, htmlFilename), function (err) {
        t.error(err)
        t.end()
      })
    })
  })
})

test('clinic flame --collect-only - missing data', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--visualize-only', 'missing.flamegraph'
  ], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, '')
    t.match(stderr, /Unknown argument "missing\.flamegraph"\. Pattern: {pid}\.clinic-{command}/)
    t.end()
  })
})
