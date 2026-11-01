'use strict'

const fs = require('fs')
const url = require('url')
const async = require('async')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof --stop-delay --on-port - no issues', function (t) {
  cli({ timeoutMs: 45000 }, [
    'clinic', 'bubbleprof', '--no-open', '--stop-delay', '500', '--on-port', 'node -e "setTimeout(() => {}, 0)"',
    '--', 'node', '-e', `
      const http = require('http')

      const server = http.createServer((req, res) => res.end('ok'))
      server.listen(0, '127.0.0.1')
      process.once('beforeExit', () => server.close())
    `
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    if (err) return t.end()

    const match = stdout && stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)
    if (!match) {
      t.fail('expected generated Bubbleprof output, got stdout: ' + JSON.stringify(stdout) + '\nstderr: ' + JSON.stringify(stderr))
      return t.end()
    }

    const dirname = match[1]
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
