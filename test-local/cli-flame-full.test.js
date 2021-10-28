'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('../test/cli.js')

test('clinic flame -- node - no issues', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)

    const htmlFilename = stdout.match(/(\d+\.clinic-flame\.html)/)[1]
    const dirname = path.dirname(htmlFilename)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, htmlFilename), done)
      }
    }, function (err) {
      t.error(err)
      t.end()
    })
  })
})

test('clinic flame -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, 'To generate the report press: Ctrl + C\n')
    t.ok(stderr.includes('subprocess error, code: 1'))
    t.end()
  })
})
