'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler - should error early if non-node script', function (t) {
  cli({ relayStderr: false }, ['clinic', 'heapprofiler', '--', 'sh', 'wrapper.sh'], function (err, stdout) {
    t.strictSame(err, new Error('process exited with exit code 1'))
    t.ok(/Clinic.js Heap Profiler[^\w ]/.test(stdout.split('\n')[1]))
    t.end()
  })
})

test('clinic heapprofiler --collect-only - should error early if non-node script', function (t) {
  cli(
    { relayStderr: false },
    ['clinic', 'heapprofiler', '--collect-only', '--', 'sh', 'wrapper.sh'],
    function (err, stdout) {
      t.strictSame(err, new Error('process exited with exit code 1'))
      t.ok(/Clinic.js Heap Profiler[^\w ]/.test(stdout.split('\n')[1]))
      t.end()
    }
  )
})

test('clinic heapprofiler - should accept full path to node.js', function (t) {
  cli(
    { relayStderr: false },
    ['clinic', 'heapprofiler', '--no-open', '--', process.execPath, '-e', 'setTimeout(() => {}, 10)'],
    function (err, stdout) {
      t.error(err)
      t.ok(/Generated HTML file is (.*?)\.clinic[/\\](\d+).clinic-heapprofiler/.test(stdout))
      t.end()
    }
  )
})
