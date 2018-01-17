'use strict'

const test = require('tap').test
const path = require('path')
const http = require('http')
const cli = require('./cli.js')
const FakeUploadServer = require('./fake-upload-server.js')

const doctorDirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10000.clinic-doctor'
)

const bubbleprofDirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10000.clinic-bubbleprof'
)

test('clinic upload 10000.clinic-doctor', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({}, [
      'clinic', 'upload',
      '--upload-url', server.uploadUrl,
      doctorDirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorDirectory} and ${doctorDirectory}.html`,
        `The data is stored under the following id: some-id`
      ])

      t.strictDeepEqual(server.requests, [{
        method: 'POST',
        url: '/data',
        files: {
          '10000.clinic-doctor/a.txt': 'a',
          '10000.clinic-doctor/b.txt': 'b',
          '10000.clinic-doctor/c.txt': 'c'
        }
      }])

      server.close(() => t.end())
    })
  })
})

test('clinic upload 10000.clinic-doctor 10000.clinic-bubbleprof', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({}, [
      'clinic', 'upload',
      '--upload-url', server.uploadUrl,
      doctorDirectory, bubbleprofDirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorDirectory} and ${doctorDirectory}.html`,
        `The data is stored under the following id: some-id`,
        `Uploading data for ${bubbleprofDirectory} and ${bubbleprofDirectory}.html`,
        `The data is stored under the following id: some-id`
      ])

      t.strictDeepEqual(server.requests, [{
        method: 'POST',
        url: '/data',
        files: {
          '10000.clinic-doctor/a.txt': 'a',
          '10000.clinic-doctor/b.txt': 'b',
          '10000.clinic-doctor/c.txt': 'c'
        }
      }, {
        method: 'POST',
        url: '/data',
        files: {
          '10000.clinic-bubbleprof/a.txt': 'a',
          '10000.clinic-bubbleprof/b.txt': 'b',
          '10000.clinic-bubbleprof/c.txt': 'c'
        }
      }])

      server.close(() => t.end())
    })
  })
})

test('clinic upload - bad status code', function (t) {
  const server = http.createServer(function (req, res) {
    res.statusCode = 500
    res.end()
  })
  server.listen(function () {
    cli({ relayStderr: false }, [
      'clinic', 'upload',
      '--upload-url', `http://127.0.0.1:${server.address().port}`,
      doctorDirectory
    ], function (err, stdout, stderr) {
      t.strictDeepEqual(err, new Error('process exited with exit code 1'))
      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorDirectory} and ${doctorDirectory}.html`
      ])
      t.ok(stderr.includes('Bad status code: 500'))
      server.close(() => t.end())
    })
  })
})
