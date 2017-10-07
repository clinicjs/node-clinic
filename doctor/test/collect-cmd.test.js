'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const rimraf = require('rimraf')
const ClinicDoctor = require('../index.js')
const ProcessStateDecoder = require('../format/decoder.js')

test('collect command', function (t) {
  fs.mkdirSync(path.resolve(__dirname, 'temp'))

  const tool = new ClinicDoctor()
  tool.collect(
    [process.execPath, '-e', 'setTimeout(() => {}, 200)'],
    function (err, filename) {
      if (err) {
        t.error(err)
        return end()
      }

      t.ok(filename.match(/^[0-9]+\.clinic-doctor-sample$/),
           'filename is correct')

      let dataOutputted = 0
      fs.createReadStream(filename)
        .pipe(new ProcessStateDecoder())
        .on('data', function (state) {
          t.type(state, 'object', 'state samples are objects')
          dataOutputted += 1
        })
        .once('end', function () {
          t.ok(dataOutputted > 0, 'data is outputted')
          end()
        })
    }
  )

  function end () {
    // It is not super important that this cleanup is done, but let's make
    // an effort.
    rimraf.sync(path.resolve(__dirname, 'temp'))
    t.end()
  }
})
