'use strict'

const test = require('tap').test
const path = require('path')
const http = require('http')
const cli = require('./cli.js')
const FakeUploadServer = require('./fake-upload-server.js')

const doctorADirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10000.clinic-doctor'
)

const doctorBDirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10001.clinic-doctor'
)

const doctorBadDirectory = path.resolve(
  __dirname,
  'fixtures',
  'html-and-folder',
  'bad-folder'
)

test('clinic upload 10000.clinic-doctor', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({}, [
      'clinic', 'upload',
      '--upload-url', server.uploadUrl,
      doctorADirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
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

test('clinic upload 10000.clinic-doctor 10001.clinic-doctor', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({}, [
      'clinic', 'upload',
      '--upload-url', server.uploadUrl,
      doctorADirectory, doctorBDirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
        `The data is stored under the following id: some-id`,
        `Uploading data for ${doctorBDirectory} and ${doctorBDirectory}.html`,
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
          '10001.clinic-doctor/a.txt': 'a',
          '10001.clinic-doctor/b.txt': 'b',
          '10001.clinic-doctor/c.txt': 'c'
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
      doctorADirectory
    ], function (err, stdout, stderr) {
      t.strictDeepEqual(err, new Error('process exited with exit code 1'))
      t.strictDeepEqual(stdout.trim().split('\n'), [
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`
      ])
      t.ok(stderr.includes('Bad status code: 500'))
      server.close(() => t.end())
    })
  })
})

test('clinic upload bad-folder', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({relayStderr: false}, [
      'clinic', 'upload',
      '--upload-url', server.uploadUrl,
      doctorBadDirectory
    ], function (err, stdout, stderr) {
      t.strictDeepEqual(err, new Error('process exited with exit code 1'))
      t.ok(stderr.includes('No data to upload'))
      server.close(() => t.end())
    })
  })
})
