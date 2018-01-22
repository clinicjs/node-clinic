'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame --all-options', function (t) {
  cli({}, ['clinic', 'flame', '--all-options'], function (err, stdout) {
    t.ifError(err)
    t.ok(/0x (\d+.\d+.\d+)/.test(stdout))
    t.end()
  })
})
