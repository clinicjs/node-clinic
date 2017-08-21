var ric = require('./lib/requestIdleCallback')
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
}
