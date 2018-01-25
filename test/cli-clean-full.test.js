'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic clean', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)

    fs.readdir(tempdir, function (err, files) {
      t.ifError(err)
      t.equal(files.length, 2) // the folder and html file
      fs.writeFileSync(path.join(tempdir, 'some-other-file'), 'sup')

      cli({cwd: tempdir}, ['clinic', 'clean'], function (err) {
        t.ifError(err)

        fs.readdir(tempdir, function (err, files) {
          t.ifError(err)
          t.deepEqual(files, ['some-other-file'])
          t.end()
        })
      })
    })
  })
})

test('clinic clean on bad dir', function (t) {
  cli({relayStderr: false}, [
    'clinic', 'clean', '--path', 'path/does/not/exist'
  ], function (err, stdout, stderr) {
    t.ok(err)
    t.ok(/ENOENT/.test(stderr))
    t.end()
  })
})
