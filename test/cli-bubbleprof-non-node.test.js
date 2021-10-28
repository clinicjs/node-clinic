'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'bubbleprof', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js BubbleProf[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic bubbleprof --collect-only - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'bubbleprof', '--collect-only', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js BubbleProf[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic bubbleprof - should accept full path to node.js', function (t) {
  cli({ relayStderr: false }, ['clinic', 'bubbleprof', '--no-open', '--', process.execPath, '-e', 'setTimeout(() => {}, 10)'], function (err, stdout) {
    t.error(err)
    t.ok(/Generated HTML file is (.*?)\.clinic[/\\](\d+).clinic-bubbleprof/.test(stdout))
    t.end()
  })
})
