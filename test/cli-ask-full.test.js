'use strict'

const test = require('tap').test
const path = require('path')
const cli = require('./cli.js')
const FakeUploadServer = require('./fake-upload-server.js')
let server

const doctorADirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10000.clinic-doctor'
)

// JWT containing test@test.com
const successfulJwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJPbmxpbmUgSldUIEJ1aWxkZXIiLCJpYXQiOjE1NDIyMjI5MzMsImV4cCI6MTg4OTM3ODEzMywiYXVkIjoid3d3LmV4YW1wbGUuY29tIiwic3ViIjoidGVzdCIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.FO0v4OM2V23lAXIcv-qcfFo0snOrOmsrY82kmcYlrJI'

test('Before all', function (t) {
  t.plan(1)
  server = new FakeUploadServer()
  server.listen(function () {
    t.ok(server)
  })
})

test('clinic ask 10000.clinic-doctor with custom upload url', function (t) {
  cli({
    env: { CLINIC_JWT: successfulJwt }
  }, [
    'clinic', 'ask',
    '--server', server.uploadUrl,
    '--no-open',
    doctorADirectory
  ], function (err, stdout) {
    t.plan(3)
    t.ifError(err)

    t.strictDeepEqual(stdout.trim().split('\n'), [
      'Signed in as test@test.com.',
      `Uploading data for ${doctorADirectory} and ${doctorADirectory}.html`,
      `The data has been uploaded to your private area.`,
      `${server.uploadUrl}/private/some-id/10000.clinic-doctor.html`,
      '',
      `Thanks for contacting NearForm, we will reply as soon as possible.`
    ])

    t.strictDeepEqual(server.requests, [{
      method: 'POST',
      url: '/protected/data',
      files: {
        '10000.clinic-doctor/a.txt': 'a',
        '10000.clinic-doctor/b.txt': 'b',
        '10000.clinic-doctor/c.txt': 'c'
      }
    }, {
      method: 'POST',
      url: '/ask'
    }])
  })
})

test('clinic ask 10000.clinic-doctor auth failure', function (t) {
  cli({
    env: { CLINIC_MOCK_AUTH_FAIL: 'true' }
  }, [
    'clinic', 'ask',
    '--server', server.uploadUrl,
    '--no-open',
    doctorADirectory
  ], function (err, stdout, stderr) {
    t.plan(2)
    t.ok(err)
    t.ok(stderr.includes('Auth artificially failed'))
  })
})

test('After all', function (t) {
  t.plan(0)
  server.close(() => t.endAll())
})
