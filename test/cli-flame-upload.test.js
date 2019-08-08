'use strict'

const fs = require('fs')
const path = require('path')
const async = require('async')
const { afterEach, beforeEach, test } = require('tap')
const FakeUploadServer = require('./fake-upload-server.js')
const cli = require('./cli.js')

// JWT containing test@test.com
const successfulJwt = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJPbmxpbmUgSldUIEJ1aWxkZXIiLCJpYXQiOjE1NDIyMjI5MzMsImV4cCI6MTg4OTM3ODEzMywiYXVkIjoid3d3LmV4YW1wbGUuY29tIiwic3ViIjoidGVzdCIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.FO0v4OM2V23lAXIcv-qcfFo0snOrOmsrY82kmcYlrJI'
let server
beforeEach(function (done) {
  server = new FakeUploadServer()
  server.listen(done)
})
afterEach(function (done) {
  server.close(done)
  server = null
})

test('clinic flame --upload -- node - no issues', function (t) {
  // collect data
  cli({
    env: { CLINIC_JWT: successfulJwt }
  }, [
    'clinic', 'flame', '--no-open',
    '--upload', '--server', server.uploadUrl,
    '--', 'node', '-e', 'require("util").inspect(process)'
  ], function (err, stdout, stderr) {
    t.ifError(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-flame)/)[1]

    t.strictEqual(stdout.split('\n')[1], 'Analysing data')
    t.strictEqual(stdout.split('\n')[2], `Uploading result ${dirname}.html...`)
    t.strictEqual(stdout.split('\n')[3], `Signed in as test@test.com.`)
    t.strictEqual(stdout.split('\n')[4], `Uploading data for ${dirname} and ${dirname}.html`)
    t.strictEqual(stdout.split('\n')[5], `The data has been uploaded to your private area.`)

    t.strictEqual(server.requests[0].method, 'POST')
    t.strictEqual(server.requests[0].url, '/protected/data', 'upload is private')
    const basename = path.basename(dirname)
    t.same(Object.keys(server.requests[0].files).sort(), [
      `${basename}.html`,
      `${basename}/${basename}-inlinedfunctions`,
      `${basename}/${basename}-samples`,
      `${basename}/${basename}-systeminfo`,
    ])

    t.throws(() => fs.accessSync(dirname), 'directory is removed')

    t.end()
  })
})

test('clinic flame --upload --autocannon', function (t) {
  cli({
    relayStderr: false,
    env: { CLINIC_JWT: successfulJwt }
  }, [
    'clinic', 'flame', '--no-open',
    '--upload', '--server', server.uploadUrl,
    '--autocannon', '[', '-d2', '/test', ']',
    '--', 'node', path.join(__dirname, 'server.js')
  ], function (err, stdout, stderr) {
    t.ifError(err)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-flame)/)[1]

    t.ok(stderr.indexOf('Running 2s test @ http://localhost:') > -1)
    t.strictEqual(stdout.split('\n')[0], 'Analysing data')
    t.strictEqual(stdout.split('\n')[1], `Uploading result ${dirname}.html...`)
    t.strictEqual(stdout.split('\n')[2], `Signed in as test@test.com.`)
    t.strictEqual(stdout.split('\n')[3], `Uploading data for ${dirname} and ${dirname}.html`)
    t.strictEqual(stdout.split('\n')[4], `The data has been uploaded to your private area.`)

    t.strictEqual(server.requests[0].method, 'POST')
    t.strictEqual(server.requests[0].url, '/protected/data', 'upload is private')
    const basename = path.basename(dirname)
    t.same(Object.keys(server.requests[0].files).sort(), [
      `${basename}.html`,
      `${basename}/${basename}-inlinedfunctions`,
      `${basename}/${basename}-samples`,
      `${basename}/${basename}-systeminfo`,
    ])

    t.throws(() => fs.accessSync(dirname), 'directory is removed')

    t.end()
  })
})
