'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic flame - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'flame', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Flame[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic flame --collect-only - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'flame', '--collect-only', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Flame[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic flame - should accept full path to node.js', function (t) {
  cli({ relayStderr: false }, ['clinic', 'flame', '--no-open', '--', process.execPath, '-e', 'setTimeout(() => {}, 10)'], function (err, stdout) {
    t.error(err)
    t.ok(/Generated HTML file is (.*?)\.clinic[/\\](\d+).clinic-flame/.test(stdout))
    t.end()
  })
})
