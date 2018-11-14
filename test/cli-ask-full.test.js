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

test('Before all', function (t) {
  server = new FakeUploadServer()
  server.listen(function () {
    t.plan(1)
    t.ok(server)
  })
})

test('clinic ask 10000.clinic-doctor with custom upload url', function (t) {
  cli({}, [
    'clinic', 'ask',
    '--upload-url', server.uploadUrl,
    '--auth-method', 'simpleSuccess',
    doctorADirectory
  ], function (err, stdout) {
    t.plan(3)
    t.ifError(err)

    t.strictDeepEqual(stdout.trim().split('\n'), [
      `Uploading private data for user test@test.com for ${doctorADirectory} and ${doctorADirectory}.html to ${server.uploadUrl}`,
      `The data has been uploaded to private area for user test@test.com`,
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
    }])
  })
})

test('clinic ask 10000.clinic-doctor with default upload url', function (t) {
  cli({}, [
    'clinic', 'ask',
    '--auth-method', 'simpleSuccess',
    doctorADirectory
  ], function (err, stdout) {
    t.plan(2)
    // error is expected because the actual server on upload.clinicjs.org will return 404
    t.ok(err)
    t.strictDeepEqual(stdout.trim().split('\n'), [
      `Uploading private data for user test@test.com for ${doctorADirectory} and ${doctorADirectory}.html to https://upload.clinicjs.org`
    ])
  })
})

test('clinic ask 10000.clinic-doctor auth failure', function (t) {
  cli({}, [
    'clinic', 'ask',
    '--upload-url', server.uploadUrl,
    '--auth-method', 'fail',
    doctorADirectory
  ], function (err, stdout, stderr) {
    t.plan(2)
    t.notOk(err)
    t.ok(stderr.includes('Auth artificially failed'))
  })
})

test('After all', function (t) {
  t.plan(0)
  server.close()
})
