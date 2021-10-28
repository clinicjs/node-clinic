'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('../test/cli.js')

test('clinic flame --name', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open', '--name', 'custom-name',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)

    const htmlFilename = stdout.match(/(\d+\.custom-name)/)[1]
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

test('clinic flame --output-html', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open', '--output-html', '{name}-{pid}-{timestamp}.html',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stderr.match(/\/(clinic-flame-)(\d+)(-)(\d+)(\.html)/)
    const htmlFilename = match.slice(1).join('')
    const pid = match[2]
    const dirname = path.join(path.dirname(htmlFilename), pid + '.clinic-flame')

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

test('clinic flame --output-dir', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open', '--output-dir', '{name}-{pid}',
    '--', 'node', '-e', 'setTimeout(() => {}, 300)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stderr.match(/\/(\d+)(\.)(clinic-flame)(\.html)/)
    const htmlFilename = match.slice(1).join('')
    const pid = match[1]
    const dirname = path.join(path.dirname(htmlFilename), 'clinic-flame-' + pid)
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
