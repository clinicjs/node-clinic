'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor -- node - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 400)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
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

test('clinic doctor -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => { process.exit(1) }, 400)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
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

test('clinic doctor - signal', {
  skip: process.platform === 'win32' ? 'SIGKILL cannot be identified on windows' : false
}, function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'process.kill(process.pid, "SIGKILL")'
  ], function (err, stdout, stderr) {
    // `clinic doctor` exit code
    t.strictSame(err, new Error('process exited with exit code 1'))
    // subprocess should be sigkilled
    t.match(stderr, 'Error: process exited by signal SIGKILL')
    t.match(stdout, 'To generate the report press: Ctrl + C')
    t.end()
  })
})

test('clinic doctor -- node - visualization error', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', `
      const fs = require('fs')
      const path = require('path')

      // Delete the systeminfo file, such that the visualizer fails.
      fs.unlinkSync(path.join(
        '.clinic',
        process.pid + '.clinic-doctor',
        process.pid + '.clinic-doctor-systeminfo'
      ))
    `
  ], function (err, stdout, stderr) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.match(stdout, 'To generate the report press: Ctrl + C')
    t.match(stdout, 'Analysing data')
    t.ok(stderr.includes('ENOENT: no such file or directory'))
    t.end()
  })
})

test('clinic doctor --on-port', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--on-port', 'autocannon localhost:$PORT -d 1',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end('ok')).listen(0)
    `
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 1s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})

test('clinic doctor --autocannon', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--autocannon', '[', '/', '-d', '2', ']',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end('ok')).listen(0)
    `
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 2s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})

test('clinic doctor -- node - configure output destination', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--dest', 'test-doctor-destination',
    '--', 'node', '-e', 'setTimeout(() => {}, 400)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const basename = stdout.match(/(\d+.clinic-doctor)/)[1]
    t.ok(fs.statSync(path.join(tempdir, 'test-doctor-destination', basename)).isDirectory())
    t.ok(fs.statSync(path.join(tempdir, 'test-doctor-destination', `${basename}.html`)).isFile())
    t.end()
  })
})
