'use strict'

const url = require('url')
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
    t.error(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-flame)/)[1]
    const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

    t.equal(stdout.split('\n')[1], 'Analysing data')
    t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, dirname + '.html'), done)
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
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-flame)/)[1]
    const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

    t.equal(stdout.split('\n')[1], 'Analysing data')
    t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, dirname + '.html'), done)
      }
    }, function (err) {
      t.error(err)
      t.end()
    })
  })
})

test('clinic flame --on-port', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--on-port', 'autocannon localhost:$PORT -d 2',
    '--', 'node', path.join(__dirname, 'server.js')
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 2s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})

test('clinic flame --autocannon', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    // this defaults to 10s which is a long time but need to make sure that
    // using this flag without [] works
    '--autocannon', '/test',
    '--', 'node', path.join(__dirname, 'server.js')
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 10s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})

test('clinic flame -- node - configure output destination', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'flame', '--no-open',
    '--dest', 'test-flame-destination',
    '--', 'node', '-e', 'require("util").inspect(process)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const basename = stdout.match(/(\d+.clinic-flame)/)[1]
    t.ok(fs.statSync(path.join(tempdir, 'test-flame-destination', basename)).isDirectory())
    t.ok(fs.statSync(path.join(tempdir, 'test-flame-destination', `${basename}.html`)).isFile())
    t.end()
  })
})
