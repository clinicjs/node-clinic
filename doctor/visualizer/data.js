
const data = require('./data.json') // base64 encoded source file
const startpoint = require('startpoint')
const ProcessStateDecoder = require('../format/decoder.js')

function loaddata (callback) {
  const parsed = []

  startpoint(Buffer.from(data, 'base64'))
    .pipe(new ProcessStateDecoder())
    .on('data', function (state) {
      parsed.push(state)
    })
    .once('end', function () {
      callback(null, new Data(parsed))
    })
}
module.exports = loaddata

// Analyse parsed data
class Data {
  constructor (parsed) {
    this.data = parsed

    this.cpu = parsed.map((point) => ({
      x: new Date(point.timestamp),
      y: [point.cpu * 100]
    }))

    this.delay = parsed.map((point) => ({
      x: new Date(point.timestamp),
      y: [point.delay]
    }))

    const GB = Math.pow(1024, 3)
    this.memory = parsed.map((point) => ({
      x: new Date(point.timestamp),
      y: [
        point.memory.rss / GB,
        point.memory.heapTotal / GB,
        point.memory.heapUsed / GB
      ]
    }))

    this.handles = parsed.map((point) => ({
      x: new Date(point.timestamp),
      y: [point.handles]
    }))
  }
}
