'use strict'

const fs = require('fs')
const path = require('path')
const stream = require('stream')
const protobuf = require('protocol-buffers')

const messages = protobuf(
  fs.readFileSync(path.resolve(__dirname, 'process-state.proto'))
)

const objectSize = messages.ProcessState.encodingLength({
  timestamp: 0,
  delay: 0,
  cpu: 0,
  memory: {
    rss: 0,
    heapTotal: 0,
    heapUsed: 0,
    external: 0
  },
  handles: 0
})

class ProcessStateDecoder extends stream.Transform {
  constructor (options) {
    super(Object.assign({
      readableObjectMode: true,
      writableObjectMode: false
    }, options))

    this._buffers = []
    this._bufferedLength = 0
  }

  _transform (chunk, encoding, callback) {
    // Join buffers if the concated buffer contains an object
    if (this._bufferedLength > 0 &&
        this._bufferedLength + chunk.length >= objectSize) {
      chunk = Buffer.concat(this._buffers.concat([chunk]))
      this._buffers = []
      this._bufferedLength = 0
    }

    // decode as long as there is an entire object
    while (chunk.length >= objectSize) {
      this.push(messages.ProcessState.decode(chunk.slice(0, objectSize)))
      chunk = chunk.slice(objectSize)
    }

    // add remaining chunk if there is data left
    if (chunk.length > 0) {
      this._buffers.push(chunk)
      this._bufferedLength += chunk.length
    }

    callback(null)
  }
}

module.exports = ProcessStateDecoder
