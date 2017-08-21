var pretty = require('prettier-bytes')

var vmStats = require('./')

vmStats(function (name, data) {
  if (name === 'memory') {
    console.log('memory used', pretty(data))
  }

  if (name === 'cpu') {
    console.log('cpu used', data + '%')
  }
})
