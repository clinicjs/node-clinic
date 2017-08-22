var ric = require('./lib/requestIdleCallback')
var onAsyncHook = require('on-async-hook')
var loopbench = require('loopbench')
var pidUsage = require('pidusage')
var heapdump = require('heapdump')
var path = require('path')
var os = require('os')
var fs = require('fs')

var SNAPSHOT_INTERVAL = 1000 * 60 * 20 // every 20 mins

module.exports = vmStats

// Gather VM stats when process is idle, and at max. 3x per second.
function vmStats (emit) {
  var pid = process.pid

  ric(function gatherStats (remaining) {
    pidUsage.stat(pid, function (_, stat) {
      emit('memory', stat.memory)
      emit('cpu', stat.cpu)

      setTimeout(function () {
        ric(gatherStats)
      }, 300)
    })
  })

  onAsyncHook(function (data) {
    var first = data.spans[0]
    if (first.type === 'TCPWRAP' ||
      first.type === 'TCPCONNECTWRAP' ||
      first.type === 'HTTPPARSER') {
      emit('trace', data)
    }
  })

  var instance = loopbench()
  instance.on('load', function () {
    emit('load', instance.delay)
  })
  instance.on('unload', function () {
    emit('unload', instance.delay)
  })

  // Would be cool if we did a snapshot with an incremental backoff. Account
  // for that if a service is running for a longer time, the chances of failing
  // become increasingly slim.
  setTimeout(function () {
    snapshot(handle)

    setInterval(function () {
      snapshot(handle)
    }, SNAPSHOT_INTERVAL)

    function handle (err, buf) {
      if (err) emit('error', err)
      emit('heapsnapshot', buf)
    }
  })
}

function snapshot (cb) {
  var filename = path.join(os.tmpdir(), Date.now() + '.heapsnapshot')
  heapdump.writeSnapshot(filename, function (err, filename) {
    if (err) return cb(err)
    fs.readFile(filename, function (err, buf) {
      if (err) return cb(err)
      cb(null, buf)
    })
  })
}
