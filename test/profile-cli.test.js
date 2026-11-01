'use strict'

const test = require('tap').test
const { parseArgs, parameterObject } = require('../lib/profile-cli.js')

test('profile CLI parses bounded workload parameters', t => {
  t.same(parseArgs(['--workload', 'tokenizer', '--param', 'iterations=10', '--param', 'warmup_iterations=2']), {
    manifest: 'profile-workloads.json',
    profiler: 'clinic-flame',
    workload: 'tokenizer',
    params: [['iterations', '10'], ['warmup_iterations', '2']]
  })
  t.same(parameterObject([['iterations', '10']]), { iterations: 10 })
  for (const profiler of ['clinic-doctor', 'clinic-bubbleprof', 'clinic-flame', 'clinic-heapprofiler']) {
    t.equal(parseArgs(['--workload', 'fibonacci', '--profiler', profiler]).profiler, profiler)
  }
  t.throws(() => parseArgs(['--workload', 'fibonacci', '--profiler', 'arbitrary-profiler']), /unsupported profiler/)
  t.throws(() => parseArgs(['--workload', 'x', '--param', 'bad']), /name=value/)
  t.throws(() => parameterObject([['iterations', '1.5']]), /integer/)
  t.end()
})
