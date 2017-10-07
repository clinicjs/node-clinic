'use strict'

const fs = require('fs')
const path = require('path')
const ProcessState = require('./collect/process-state.js')
const ProcessStateEncoder = require('./format/encoder.js')
const getSampleFilename = require('./collect/get-sample-filename.js')

// setup encoded states file
const encoder = new ProcessStateEncoder()
encoder.pipe(
  fs.createWriteStream(path.resolve(getSampleFilename(process.pid)))
)

// sample every 10ms
const state = new ProcessState(10)

// keep sample time unrefed such it doesn't interfer too much
let timer = null
function scheduleSample () {
  timer = setTimeout(saveSample, state.sampleInterval)
  timer.unref()
}

function saveSample () {
  const sample = state.sample()
  encoder.write(sample)
  state.refresh()

  scheduleSample()
}

// start sampler
scheduleSample()

// before process exists, flush the encoded data to the sample file
process.once('beforeexit', function () {
  clearTimeout(timer)
  encoder.end()
})
