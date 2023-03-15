'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler --visualize-only - no issues', function (t) {
  // collect data
  cli(
    {},
    ['clinic', 'heapprofiler', '--collect-only', '--', 'node', '-e', 'require("util").inspect(process)'],
    function (err, stdout, stderr, tempdir) {
      t.error(err)
      t.ok(/Output file is \.clinic[/\\](\d+).clinic-heapprofiler/.test(stdout))

      const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const dirpath = path.resolve(tempdir, dirname)

      // visualize data
      cli({}, ['clinic', 'heapprofiler', '--visualize-only', dirpath], function (err, stdout) {
        t.error(err)
        t.equal(stdout.trim(), `Generated HTML file is ${url.pathToFileURL(dirpath)}.html`)

        // check that HTML file exists
        fs.access(dirpath + '.html', function (err) {
          t.error(err)
          t.end()
        })
      })
    }
  )
})

test('clinic heapprofiler --visualize-only - missing data', function (t) {
  const arg = 'missing.clinic-heapprofiler'
  cli({ relayStderr: false }, ['clinic', 'heapprofiler', '--visualize-only', arg], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.equal(stdout, '')
    t.ok(stderr.includes('No data found.'))
    t.end()
  })
})

test('clinic heapprofiler --visualize-only - supports trailing slash', function (t) {
  // collect data
  cli(
    {},
    ['clinic', 'heapprofiler', '--collect-only', '--', 'node', '-e', 'require("util").inspect(process)'],
    function (err, stdout, stderr, tempdir) {
      t.error(err)
      t.ok(/Output file is \.clinic[/\\](\d+).clinic-heapprofiler/.test(stdout))
      const filename = stdout.match(/(\.clinic[/\\]\d+.clinic-heapprofiler)/)[1]
      const dirpath = path.resolve(tempdir, filename)

      // visualize data
      cli({}, ['clinic', 'heapprofiler', '--visualize-only', `${dirpath}${path.sep}`], function (err, stdout) {
        t.error(err)
        t.equal(stdout.trim(), `Generated HTML file is ${url.pathToFileURL(dirpath)}.html`)

        // check that HTML file exists
        fs.access(dirpath + '.html', function (err) {
          t.error(err)
          t.end()
        })
      })
    }
  )
})
