'use strict'

const test = require('tap').test
const path = require('path')
const cli = require('./cli.js')

const doctorADirectory = path.resolve(
  __dirname,
  'fixtures',
  'only-folder',
  '10000.clinic-doctor'
)

test('clinic upload 10000.clinic-doctor', function (t) {
  cli({}, [ 'clinic', 'upload', doctorADirectory ], function (err, stdout) {
    t.ok(err)

    t.strictDeepEqual(stdout.trim().split('\n'), [
      `This version of clinic is incompatible with the Upload Server.`,
      `Please update clinic using`,
      `  \x1B[33mnpm install -g clinic@latest\x1B[39m`,
      `and try again.`
    ])
    t.end()
  })
})
