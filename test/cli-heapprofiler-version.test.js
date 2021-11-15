'use strict'

const test = require('tap').test
const cli = require('./cli.js')

test('clinic heapprofiler --version', function (t) {
  cli({}, ['clinic', 'heapprofiler', '--version'], function (err, stdout) {
    t.error(err)
    t.equal(stdout, `v${require('@clinic/heap-profiler/package.json').version}\n`)
    t.end()
  })
})

test('clinic heapprofiler -v', function (t) {
  cli({}, ['clinic', 'heapprofiler', '-v'], function (err, stdout) {
    t.error(err)
    t.equal(stdout, `v${require('@clinic/heap-profiler/package.json').version}\n`)
    t.end()
  })
})
