var TICK_DURATION = 16   // Amount of time a tick should take
var IDLE_THRESHOLD = 5   // Amount of idle time a tick needs

module.exports = requestIdleCallback

function requestIdleCallback (cb) {
  setImmediate(loop.bind(null, cb))

  function loop (cb) {
    var start = process.hrtime()

    // Push to the end of the call stack
    process.nextTick(function schedule () {
      process.nextTick(function end () {
        var elapsed = ms(process.hrtime(start))
        var remaining = TICK_DURATION - elapsed
        if (remaining > IDLE_THRESHOLD) {
          cb(remaining)
        } else {
          setImmediate(loop.bind(null, cb))
        }
      })
    })
  }
}

function ms (ts) {
  return (ts[0] * 1e3) + (ts[1] / 1e6)
}
