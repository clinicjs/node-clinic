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

test('partial decoding', function (t) {
  const state = new ProcessState(1)

  const encoder = new ProcessStateEncoder()
  const decoder = new ProcessStateDecoder()

  // encode a sample
  const sample = state.sample()
  encoder.write(sample)
  const sampleEncoded = encoder.read()

  // No data, chunk is too small
  decoder.write(sampleEncoded.slice(0, 20))
  t.strictEqual(t.read(), null)

  // Ended previuse sample, but a partial remains
  decoder.write(Buffer.concat([
    sampleEncoded.slice(20),
    sampleEncoded.slice(0, 30)
  ]))
  t.strictDeepEqual(decoder.read(), sample)
  t.strictDeepEqual(decoder.read(), null)

  // Ended previuse, no partial remains
  decoder.write(Buffer.concat([
    sampleEncoded.slice(30),
    sampleEncoded
  ]))
  t.strictDeepEqual(decoder.read(), sample)
  t.strictDeepEqual(decoder.read(), sample)

  // No previuse ended
  decoder.write(sampleEncoded)
  t.strictDeepEqual(decoder.read(), sample)

  // No more data
  t.strictEqual(decoder.read(), null)
  t.end()
})
