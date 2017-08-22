var pretty = require('prettier-bytes')

var vmStats = require('./')

vmStats(function (name, data) {
  if (name === 'memory') {
    console.log('memory used', pretty(data))
  } else if (name === 'cpu') {
    console.log('cpu used', data + '%')
  } else if (name === 'load') {
    console.log('event loop delay high', data + 'ms')
  } else if (name === 'unload') {
    console.log('event loop delay low', data + 'ms')
  } else {
    console.log(name, data)
  }
})

setInterval(function () {
  var i = 10000
  while (--i) console.log(Math.random())
}, 3000)
