'use strict'

const test = require('tap').test
const cli = require('./cli.js')
const raw = String.raw

test('clinic --autocannon with $PORT', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--autocannon', '[', 'localhost:$PORT', '-d', '1', ']',
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

test('clinic --autocannon with escaped $', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--autocannon', '[', raw`localhost:$PORT/\$PORT?\$page=10`, '-d', '1', ']',
    '--', 'node', '-e', `
      const http = require('http')

      let first = true
      http.createServer((req, res) => {
        if (first) console.log(req.url)
        first = false
        res.end('ok')
      }).listen(0)
    `
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 1s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], '/$PORT?$page=10')
    t.equal(stdout.split('\n')[1], 'Analysing data')
    t.end()
  })
})

test('clinic --autocannon with /path', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--no-open',
    '--autocannon', '[', '/path', '-d', '1', ']',
    '--', 'node', '-e', `
      const http = require('http')

      http.createServer((req, res) => res.end(req.url)).listen(0)
    `
  ], function (err, stdout, stderr) {
    t.error(err)
    t.ok(stderr.indexOf('Running 1s test @ http://localhost:') > -1)
    t.equal(stdout.split('\n')[0], 'Analysing data')
    t.end()
  })
})
