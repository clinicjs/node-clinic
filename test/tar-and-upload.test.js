'use strict'

const test = require('tap').test
const path = require('path')
const tarAndUpload = require('../lib/tar-and-upload')
const http = require('http')
const zlib = require('zlib')
const tar = require('tar-stream')
const collect = require('stream-collector')
const fs = require('fs')
const crypto = require('crypto')

testFixtureUpload('doctor', false)
testFixtureUpload('doctor', true)
testFixtureUpload('bubbleprof', false)
testFixtureUpload('bubbleprof', true)

test('upload fixtures/too-big-should-fail', function (t) {
  const fixture = path.join(__dirname, 'fixtures/too-big-should-fail/10000.clinic-doctor')

  const server = http.createServer(function (req, res) {
    t.fail('should not request the server')
    res.end()
  })

  server.listen(0, function () {
    const url = `http://localhost:${server.address().port}`
    const bigBuf = crypto.randomBytes(64 * 1024 * 1024)
    const bigFilename = path.join(fixture, 'big-file.tmp')

    // make a 64MB file with random data, so it zips to the same size ish
    // we gitignore all .tmp files so, we need to make it before running the test
    // let first stat the filename and see if it is already a 64mb file, if so
    // we do not need to rewrite it (makes the tests run faster)
    fs.stat(bigFilename, function (_, st) {
      if (st && st.size === bigBuf.length) return run()
      fs.writeFile(bigFilename, bigBuf, run)
    })

    function run (err) {
      t.error(err)
      tarAndUpload(fixture, {url}, function (err) {
        server.close(function () {
          t.ok(err)
          t.strictEqual(err.message, 'Too much data. Should be less than 32MB')
          t.end()
        })
      })
    }
  })
})

function testFixtureUpload (type, html) {
  const fixture = `fixtures/${html ? 'html-and-folder' : 'only-folder'}/10000.clinic-${type}`

  test(`upload ${fixture}`, function (t) {
    const actual = {} // contains a map of the files uploaded

    const server = http.createServer(function (req, res) {
      t.strictEqual(req.method, 'POST')
      t.strictEqual(req.url, '/data')

      req.pipe(zlib.createGunzip()).pipe(tar.extract())
        .on('entry', function (entry, stream, next) {
          if (entry.type === 'file') {
            t.ok(/^10000\.clinic-(doctor|bubbleprof)(\/|\.html$)/.test(entry.name))
            collect(stream, function (_, data) {
              actual[entry.name] = Buffer.concat(data).toString()
            })
          }

          next()
        })
        .on('finish', function () {
          res.end('{"id": "some-id"}')
        })
    })

    server.listen(0, function () {
      const url = `http://localhost:${server.address().port}`

      tarAndUpload(path.join(__dirname, fixture), {url}, function (err, data) {
        server.close(function () {
          const expected = {
            [`10000.clinic-${type}/a.txt`]: 'a',
            [`10000.clinic-${type}/b.txt`]: 'b',
            [`10000.clinic-${type}/c.txt`]: 'c'
          }
          if (html) expected[`10000.clinic-${type}.html`] = 'html'

          t.deepEqual(actual, expected)
          t.deepEqual(data, {id: 'some-id'})
          t.error(err)
          t.end()
        })
      })
    })
  })
}
