'use strict'

const fs = require('fs')
const path = require('path')
const stream = require('stream')
const protobuf = require('protocol-buffers')

const messages = protobuf(
  fs.readFileSync(path.resolve(__dirname, 'process-state.proto'))
)

class ProcessStateEncoder extends stream.Transform {
  constructor (options) {
    super(Object.assign({
      readableObjectMode: false,
      writableObjectMode: true
    }, options))
  }

  _transform (state, encoding, callback) {
    callback(null, messages.ProcessState.encode(state))
  }
}

module.exports = ProcessStateEncoder
