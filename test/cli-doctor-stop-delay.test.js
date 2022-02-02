'use strict'

const fs = require('fs')
const url = require('url')
const async = require('async')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --stop-delay --on-port - no issues', function (t) {
  cli({}, [
    'clinic', 'doctor', '--no-open', '--stop-delay', '2000', '--on-port', 'node -e "setTimeout(() => {}, 1000)"',
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

// TODO: skipping until the above statement is fulfilled
test('clinic doctor --stop-delay --on-port - exceeding timeout', { skip: true }, function (t) {
  // TODO: rafaelgss
  // Not sure yet how to make it work
  // Looks like node-tap doesn't accept a assertion when timeout is expected
  t.timeout(2000)
  t.on('timeout', () => {
    t.pass()
    t.end()
  })
  cli({}, [
    'clinic', 'doctor', '--no-open', '--stop-delay', '6000', '--on-port', 'node -e "setTimeout(() => {}, 1000)"',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end('ok')).listen(0)
    `
  ], function () {
    t.fail('it should not be called once timeout is reached')
  })
})
