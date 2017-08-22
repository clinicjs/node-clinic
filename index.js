var ric = require('./lib/requestIdleCallback')
var loopbench = require('loopbench')
var pidUsage = require('pidusage')

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

  var instance = loopbench()
  instance.on('load', function () {
    emit('load', instance.delay)
  })
  instance.on('unload', function () {
    emit('unload', instance.delay)
  })
}
