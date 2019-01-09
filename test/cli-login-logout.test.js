'use strict'

const test = require('tap').test
const path = require('path')
const tmp = require('tmp')
const cli = require('./cli.js')
const FakeUploadServer = require('./fake-upload-server.js')
let server
let tempCredentials

// JWT containing test@test.com
const successfulJwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJPbmxpbmUgSldUIEJ1aWxkZXIiLCJpYXQiOjE1NDIyMjI5MzMsImV4cCI6MTg4OTM3ODEzMywiYXVkIjoid3d3LmV4YW1wbGUuY29tIiwic3ViIjoidGVzdCIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.FO0v4OM2V23lAXIcv-qcfFo0snOrOmsrY82kmcYlrJI'

test('Before all', function (t) {
  tempCredentials = tmp.dirSync()
  server = new FakeUploadServer()
  server.listen(function () {
    t.plan(1)
    t.ok(server)
  })
})

test('clinic login', function (t) {
  cli({
    env: {
      CLINIC_CREDENTIALS: path.join(tempCredentials.name, '.clinic-login'),
      CLINIC_JWT: successfulJwt
    }
  }, [
    'clinic', 'login',
    '--upload-url', server.uploadUrl
  ], function (err, stdout) {
    t.plan(2)
    t.ifError(err)

    t.strictDeepEqual(stdout.trim().split('\n'), [
      'Signed in as test@test.com.'
    ])
  })
})

test('clinic user exits with 1 if not authenticated', function (t) {
  cli({
    env: {
      CLINIC_CREDENTIALS: path.join(tempCredentials.name, '.clinic-user')
    }
  }, [
    'clinic', 'user'
  ], function (err, stdout) {
    t.plan(2)
    t.ok(err)
    t.ok(/exited with exit code 1/.test(err.message))
  })
})

test('clinic user lists all authed users', function (t) {
  t.plan(3)

  cli({
    env: {
      CLINIC_CREDENTIALS: path.join(tempCredentials.name, '.clinic-user-all'),
      CLINIC_JWT: successfulJwt
    }
  }, [
    'clinic', 'login',
    '--upload-url', server.uploadUrl
  ], function (err) {
    t.ifError(err)
    cli({
      env: {
        CLINIC_CREDENTIALS: path.join(tempCredentials.name, '.clinic-user-all')
      }
    }, [
      'clinic', 'user'
    ], function (err, stdout) {
      t.ifError(err)
      t.ok(stdout)
    })
  })
})

test('After all', function (t) {
  t.plan(0)
  server.close()
  tempCredentials.removeCallback()
})
