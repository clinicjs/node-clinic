var pino = require('pino')

var nodeClinic = require('./')
var log = pino({ level: 'trace' })
log = log.child({ msg: 'stats' })

nodeClinic(function (type, data) {
  if (type === 'heapsnapshot') {
    log.trace({
      type: type,
      data: data.path
    })
  } else {
    log.trace({
      type: type,
      data: data
    })
  }
})
