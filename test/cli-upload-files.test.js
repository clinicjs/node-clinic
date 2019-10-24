'use strict'

const test = require('tap').test
const path = require('path')
const http = require('http')
const cli = require('./cli.js')
const FakeUploadServer = require('./fake-upload-server.js')

// JWT containing test@test.com
const successfulJwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJPbmxpbmUgSldUIEJ1aWxkZXIiLCJpYXQiOjE1NDIyMjI5MzMsImV4cCI6MTg4OTM3ODEzMywiYXVkIjoid3d3LmV4YW1wbGUuY29tIiwic3ViIjoidGVzdCIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.FO0v4OM2V23lAXIcv-qcfFo0snOrOmsrY82kmcYlrJI'

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
    cli({
      env: { CLINIC_JWT: successfulJwt }
    }, [
      'clinic', 'upload',
      '--server', server.uploadUrl,
      '--no-open',
      doctorADirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        'Signed in as test@test.com.',
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
        'The data has been uploaded.',
        'Use this link to share it:',
        `http://127.0.0.1:${server.server.address().port}/public/some-id/${path.basename(doctorADirectory)}.html`
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

test('clinic upload 10000.clinic-doctor privately', function (t) {
  const server = new FakeUploadServer()
  server.listen(function () {
    cli({
      env: { CLINIC_JWT: successfulJwt }
    }, [
      'clinic', 'upload',
      '--private',
      '--server', server.uploadUrl,
      '--no-open',
      doctorADirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        'Signed in as test@test.com.',
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
        'The data has been uploaded to your private area.',
        `http://127.0.0.1:${server.server.address().port}/private/some-id/${path.basename(doctorADirectory)}.html`
      ])

      t.strictDeepEqual(server.requests, [{
        method: 'POST',
        url: '/protected/data',
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
    cli({
      env: { CLINIC_JWT: successfulJwt }
    }, [
      'clinic', 'upload',
      '--server', server.uploadUrl,
      '--no-open',
      doctorADirectory, doctorBDirectory
    ], function (err, stdout) {
      t.ifError(err)

      t.strictDeepEqual(stdout.trim().split('\n'), [
        'Signed in as test@test.com.',
        `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
        `Uploading data for ${doctorBDirectory} and ${doctorBDirectory}.html`,
        'The data has been uploaded.',
        'Use these links to share the profiles:',
        `http://127.0.0.1:${server.server.address().port}/public/some-id/${path.basename(doctorADirectory)}.html`,
        `http://127.0.0.1:${server.server.address().port}/public/some-id/${path.basename(doctorBDirectory)}.html`
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
    cli({
      env: { CLINIC_JWT: successfulJwt },
      relayStderr: false
    }, [
      'clinic', 'upload',
      '--server', `http://127.0.0.1:${server.address().port}`,
      '--no-open',
      doctorADirectory
    ], function (err, stdout, stderr) {
      t.strictDeepEqual(err, new Error('process exited with exit code 1'))
      t.strictDeepEqual(stdout.trim().split('\n'), [
        'Signed in as test@test.com.',
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
    cli({
      env: { CLINIC_JWT: successfulJwt },
      relayStderr: false
    }, [
      'clinic', 'upload',
      '--server', server.uploadUrl,
      '--no-open',
      doctorBadDirectory
    ], function (err, stdout, stderr) {
      t.strictDeepEqual(err, new Error('process exited with exit code 1'))
      t.ok(stderr.includes('No data to upload'))
      server.close(() => t.end())
    })
  })
})
