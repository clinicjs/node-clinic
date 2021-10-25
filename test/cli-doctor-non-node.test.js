'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'doctor', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Doctor[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic doctor --collect-only - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'doctor', '--collect-only', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Doctor[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic doctor - should accept full path to node.js', function (t) {
  cli({ relayStderr: false }, ['clinic', 'doctor', '--no-open', '--', process.execPath, '-e', 'setTimeout(() => {}, 10)'], function (err, stdout) {
    t.error(err)
    t.ok(/Generated HTML file is (.*?)\.clinic[/\\](\d+).clinic-doctor/.test(stdout))
    t.end()
  })
})
