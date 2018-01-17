'use strict'

const fs = require('fs')
const test = require('tap').test
const path = require('path')
const http = require('http')
const async = require('async')
const crypto = require('crypto')
const tarAndUpload = require('../lib/tar-and-upload')
const FakeUploadServer = require('./fake-upload-server.js')

testFixtureUpload('doctor', false)
testFixtureUpload('doctor', true)
testFixtureUpload('bubbleprof', false)
testFixtureUpload('bubbleprof', true)

function testFixtureUpload (type, html) {
  const dataDrectory = path.join(
    'fixtures',
    html ? 'html-and-folder' : 'only-folder',
    `10000.clinic-${type}`
  )

  test(`upload ${dataDrectory}`, function (t) {
    const server = new FakeUploadServer()
    server.listen(function () {
      tarAndUpload(
        path.resolve(__dirname, dataDrectory),
        server.uploadUrl,
        function (err, data) {
          t.ifError(err)

          const expectedRequest = {
            method: 'POST',
            url: '/data',
            files: {
              [`10000.clinic-${type}/a.txt`]: 'a',
              [`10000.clinic-${type}/b.txt`]: 'b',
              [`10000.clinic-${type}/c.txt`]: 'c'
            }
          }
          if (html) expectedRequest.files[`10000.clinic-${type}.html`] = 'html'

          t.strictDeepEqual(server.requests, [expectedRequest])
          t.strictDeepEqual(data, { id: 'some-id' })
          server.close(() => t.end())
        }
      )
    })
  })
}

test('upload - bad response', function (t) {
  const dataDirectory = path.resolve(
    __dirname,
    'fixtures',
    'only-folder',
    `10000.clinic-doctor`
  )

  const server = http.createServer(function (req, res) {
    res.destroy()
  })

  server.listen(0, '127.0.0.1', function () {
    const uploadUrl = `http://localhost:${server.address().port}`
    tarAndUpload(dataDirectory, uploadUrl, function (err) {
      t.strictEqual(err.message, 'socket hang up')
      server.close(() => t.end())
    })
  })
})

test('upload - bad body encoding', function (t) {
  const dataDirectory = path.resolve(
    __dirname,
    'fixtures',
    'only-folder',
    `10000.clinic-doctor`
  )

  const server = http.createServer(function (req, res) {
    res.end('not JSON')
  })

  server.listen(0, '127.0.0.1', function () {
    const uploadUrl = `http://localhost:${server.address().port}`
    tarAndUpload(dataDirectory, uploadUrl, function (err) {
      t.strictEqual(err.name, 'SyntaxError')
      server.close(() => t.end())
    })
  })
})

test('upload - bad status code', function (t) {
  const dataDirectory = path.resolve(
    __dirname,
    'fixtures',
    'only-folder',
    `10000.clinic-doctor`
  )

  const server = http.createServer(function (req, res) {
    res.statusCode = 500
    res.end()
  })

  server.listen(0, '127.0.0.1', function () {
    const uploadUrl = `http://localhost:${server.address().port}`
    tarAndUpload(dataDirectory, uploadUrl, function (err) {
      t.strictDeepEqual(err, new Error('Bad status code: 500'))
      server.close(() => t.end())
    })
  })
})

test('upload fixtures/empty-directory.tmp/10000.clinic-doctor', function (t) {
  const emptyDataDirectory = path.resolve(
    __dirname,
    'fixtures',
    'empty-directory.tmp',
    '10000.clinic-doctor'
  )

  let server

  async.parallel({
    createEmptyDirectory (done) {
      fs.mkdir(path.dirname(emptyDataDirectory), function (err) {
        if (err && err.code !== 'EEXIST') return done(err)
        fs.mkdir(emptyDataDirectory, function (err) {
          if (err && err.code !== 'EEXIST') return done(err)
          return done(null)
        })
      })
    },

    createServer (done) {
      server = http.createServer(function (req, res) {
        t.fail('should not request the server')
        res.end()
      })
      server.listen(0, '127.0.0.1', done)
    }
  }, function (err) {
    t.ifError(err)

    const uploadUrl = `http://localhost:${server.address().port}`
    tarAndUpload(emptyDataDirectory, uploadUrl, function (err) {
      t.strictDeepEqual(err, new Error('No data to upload'))
      server.close(() => t.end())
    })
  })
})

test('upload fixtures/too-big-should-fail', function (t) {
  const bigFileDirectory = path.resolve(
    __dirname,
    'fixtures',
    'too-big-should-fail',
    '10000.clinic-doctor'
  )

  let server

  async.parallel({
    createBigFile (done) {
      const bigFilepath = path.resolve(bigFileDirectory, 'big-file.tmp')
      const bigFilesize = 64 * 1024 * 1024

      // make a 64MB file with random data, so it zips to the same size ish
      // we gitignore all .tmp files so, we need to make it before running the test
      // let first stat the filename and see if it is already a 64mb file, if so
      // we do not need to rewrite it (makes the tests run faster)
      fs.stat(bigFilepath, function (_, st) {
        if (st && st.size === bigFilesize) return done(null)
        fs.writeFile(bigFilepath, crypto.randomBytes(bigFilesize), done)
      })
    },

    createServer (done) {
      server = http.createServer(function (req, res) {
        t.fail('should not request the server')
        res.end()
      })
      server.listen(0, '127.0.0.1', done)
    }
  }, function (err) {
    t.ifError(err)

    const uploadUrl = `http://localhost:${server.address().port}`
    tarAndUpload(bigFileDirectory, uploadUrl, function (err) {
      t.strictDeepEqual(err, new Error('Too much data. Should be less than 32MB'))
      server.close(() => t.end())
    })
  })
})
