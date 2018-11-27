'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame -- node - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'flame', '--no-open',
    '--', 'node', '-e', 'require("util").inspect(process)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+.clinic-flame)/)[1]

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

test('clinic flame -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const dirname = stdout.match(/(\d+.clinic-flame)/)[1]

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

test('clinic flame --on-port', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--on-port', 'autocannon localhost:$PORT -d 1',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end('ok')).listen(0)
    `
  ], function (err, stdout, stderr) {
    t.ifError(err)
    t.ok(stderr.indexOf('Running 1s test @ http://localhost:') > -1)
    t.strictEqual(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})

test('clinic flame -- node - configure output destination', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--dest', 'test-flame-destination',
    '--', 'node', '-e', 'require("util").inspect(process)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    const basename = stdout.match(/(\d+.clinic-flame)/)[1]
    t.ok(fs.statSync(path.join(tempdir, 'test-flame-destination', basename)).isDirectory())
    t.ok(fs.statSync(path.join(tempdir, 'test-flame-destination', `${basename}.html`)).isFile())
    t.end()
  })
})
