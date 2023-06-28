'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const async = require('async')
const { test } = require('tap')
const cli = require('./cli.js')

test('clinic heapprofiler -- node - no issues', function (t) {
  // collect data
  cli(
    {},
    ['clinic', 'heapprofiler', '--no-open', '--', 'node', '-e', 'require("util").inspect(process)'],
    function (err, stdout, stderr, tempdir) {
      t.error(err)

      const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

      t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

      // check that files exists
      async.parallel(
        {
          sourceData (done) {
            fs.access(path.resolve(tempdir, dirname), done)
          },
          htmlFile (done) {
            fs.access(path.resolve(tempdir, dirname + '.html'), done)
          }
        },
        function (err) {
          t.error(err)
          t.end()
        }
      )
    }
  )
})

test('clinic heapprofiler -- node - bad status code', function (t) {
  // collect data
  cli(
    { relayStderr: true },
    ['clinic', 'heapprofiler', '--no-open', '--', 'node', '-e', 'process.exitCode = 1'],
    function (err, stdout, stderr, tempdir) {
      t.error(err)
      const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

      t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

      // check that files exists
      async.parallel(
        {
          sourceData (done) {
            fs.access(path.resolve(tempdir, dirname), done)
          },
          htmlFile (done) {
            fs.access(path.resolve(tempdir, dirname + '.html'), done)
          }
        },
        function (err) {
          t.error(err)
          t.end()
        }
      )
    }
  )
})

test('clinic heapprofiler --on-port', function (t) {
  cli(
    { relayStderr: false },
    [
      'clinic',
      'heapprofiler',
      '--no-open',
      '--on-port',
      'node -p "\'Hello world\'"',
      '--',
      'node',
      path.join(__dirname, 'server.js')
    ],
    function (err, stdout, stderr, tempdir) {
      t.error(err)

      const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

      const [hello, analysing, generated] = stdout.split('\n')
      t.equal(hello, 'Hello world')
      t.equal(analysing, 'Analysing data')
      t.equal(generated, `Generated HTML file is ${fullpath}.html`)
      t.end()
    }
  )
})

test('clinic heapprofiler --autocannon', function (t) {
  cli(
    { relayStderr: false },
    [
      'clinic',
      'heapprofiler',
      '--no-open',
      // this defaults to 10s which is a long time but need to make sure that
      // using this flag without [] works
      '--autocannon',
      '/test',
      '--',
      'node',
      path.join(__dirname, 'server.js')
    ],
    function (err, stdout, stderr, tempdir) {
      t.error(err)

      const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

      t.ok(stderr.indexOf('Running 10s test @ http://localhost:') > -1)
      t.equal(stdout.split('\n')[0], 'Analysing data')
      t.equal(stdout.split('\n')[1], `Generated HTML file is ${fullpath}.html`)
      t.end()
    }
  )
})

test('clinic heapprofiler -- node - configure output destination', function (t) {
  cli(
    { relayStderr: false },
    [
      'clinic',
      'heapprofiler',
      '--no-open',
      '--dest',
      'test-heapprofiler-destination.clinic-heapprofiler',
      '--',
      'node',
      '-e',
      'require("util").inspect(process)'
    ],
    function (err, stdout, stderr, tempdir) {
      t.error(err)

      t.ok(fs.statSync(path.join(tempdir, 'test-heapprofiler-destination.clinic-heapprofiler')).isDirectory())
      t.end()
    }
  )
})

test('clinic heapprofiler -- node - configure output destination and name', function (t) {
  cli(
    { relayStderr: false },
    [
      'clinic',
      'heapprofiler',
      '--no-open',
      '--dest',
      'test-heapprofiler-destination.clinic-heapprofiler',
      '--name',
      'test-name',
      '--',
      'node',
      '-e',
      'require("util").inspect(process)'
    ],
    function (err, stdout, stderr, tempdir) {
      t.error(err)

      t.ok(fs.statSync(
        path.join(
          tempdir,
          'test-heapprofiler-destination.clinic-heapprofiler',
          'test-name.clinic-heapprofiler.html'
        )).isFile())
      t.end()
    }
  )
})
