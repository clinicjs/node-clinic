'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic ask', function (t) {
  cli({}, ['clinic', 'ask'], function (err, stdout) {
    console.log('stdout', stdout)
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic Ask[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})
