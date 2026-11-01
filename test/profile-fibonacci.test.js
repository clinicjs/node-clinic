'use strict'

const test = require('tap').test
const { fibonacci, run } = require('../bench/profile-fibonacci')

test('fibonacci profiling workload reports bounded deterministic work', t => {
  const report = run(2)
  t.equal(fibonacci(22), 17711)
  t.equal(report.iterations, 2)
  t.equal(report.checksum, 35422)
  t.ok(report.throughput > 0)
  t.end()
})
