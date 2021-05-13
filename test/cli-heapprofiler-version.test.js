'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler --version', function (t) {
  cli({}, ['clinic', 'heapprofiler', '--version'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(stdout, `v${require('@nearform/heap-profiler/package.json').version}\n`)
    t.end()
  })
})

test('clinic heapprofiler -v', function (t) {
  cli({}, ['clinic', 'heapprofiler', '-v'], function (err, stdout) {
    t.ifError(err)
    t.strictEqual(stdout, `v${require('@nearform/heap-profiler/package.json').version}\n`)
    t.end()
  })
})
