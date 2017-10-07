'use strict'

const test = require('tap').test
const ProcessState = require('../collect/process-state.js')

test('timestamp', function (t) {
  const state = new ProcessState(1)
  const sample = state.sample()
  t.ok(sample.timestamp > Date.now() - 100 && sample.timestamp <= Date.now())
  t.end()
})

test('number of handles', function (t) {
  const state = new ProcessState(1)
  const sample = state.sample()
  t.strictEqual(sample.handles, process._getActiveHandles().length)
  t.end()
})

test('memory usage', function (t) {
  const state = new ProcessState(1)
  const sample = state.sample()
  t.ok(sample.memory.rss > 0)
  t.ok(sample.memory.heapTotal > 0)
  t.ok(sample.memory.heapUsed > 0)
  t.ok(sample.memory.external > 0)

  t.end()
})

function sleep (time) {
  const future = Date.now() + time
  while (Date.now() < future);
}

test('delay usage', function (t) {
  const state = new ProcessState(10)
  state.refresh()
  sleep(20)
  const sample = state.sample()
  t.ok(sample.delay < 11 && sample.delay > 9)

  t.end()
})

test('cpu usage', function (t) {
  const state = new ProcessState(10)
  state.refresh()
  sleep(20)
  const sample = state.sample()
  t.ok(sample.cpu >= 0.6 && sample.cpu <= 1, 'sleep has high usage')

  state.refresh()
  setTimeout(function () {
    const sample = state.sample()
    t.ok(sample.cpu >= 0 && sample.cpu <= 0.4, 'timeout has low usage')
    t.end()
  }, 10)
})
