'use strict'

const test = require('tap').test
const ProcessState = require('../collect/process-state.js')
const ProcessStateDecoder = require('../format/decoder.js')
const ProcessStateEncoder = require('../format/encoder.js')

test('basic encoder-decoder works', function (t) {
  const state = new ProcessState(1)

  const encoder = new ProcessStateEncoder()
  const decoder = new ProcessStateDecoder()
  encoder.pipe(decoder)

  const outputSamples = []
  decoder.on('data', (sample) => outputSamples.push(sample))

  const inputSamples = []
  for (let i = 0; i < 1; i++) {
    const sample = state.sample()
    encoder.write(sample)
    inputSamples.push(sample)
  }

  decoder.once('end', function () {
    t.strictDeepEqual(inputSamples, outputSamples)
    t.end()
  })

  encoder.end()
})
