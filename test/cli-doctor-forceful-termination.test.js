'use strict'

const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor throws error when process is forcefully closed before processstat file is generated', { skip: process.version.startsWith('v14') }, function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', path.join(__dirname, 'forceful-termination.js')
  ], function (err, stdout, stderr) {
    t.ok(err)
    t.ok(stderr.includes('Process forcefully closed before processstat file generation'))
    t.end()
  })
})
