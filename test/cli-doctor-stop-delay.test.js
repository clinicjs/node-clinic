'use strict'

const fs = require('fs')
const url = require('url')
const async = require('async')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --stop-delay --on-port - no issues', function (t) {
  cli({}, [
    'clinic', 'doctor', '--no-open', '--stop-delay', '500', '--on-port', 'node -e "setTimeout(() => {}, 0)"',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end('ok')).listen(0)
    `
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)

    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))
    t.equal(stdout.split('\n')[0], 'Waiting to close the process')
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

test('clinic doctor --stop-delay --on-port - exceeding timeout', function (t) {
  const onPortDuration = 500
  setTimeout(() => {
    t.pass('timeout should be called before t.fail')
    t.end()
    process.exit(0)
  }, onPortDuration + 500)
  cli({}, [
    'clinic', 'doctor', '--no-open', '--stop-delay', '2000', '--on-port', `node -e "setTimeout(() => {}, ${onPortDuration})"`,
    '--', 'node', '-e', `
        const http = require('http')

        http.createServer((req, res) => res.end('ok')).listen(0)
      `
  ], function () {
    t.fail('it should not be called once timeout is reached')
  })
})
