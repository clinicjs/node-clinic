var defaults = require('dat-swarm-defaults')
var swarm = require('discovery-swarm')
var hyperdrive = require('hyperdrive')
var pretty = require('prettier-bytes')
var vmStats = require('./')

var id = 'cat-server-01'

var archive = hyperdrive('/tmp/stats')
var sw = swarm(defaults({
  id: archive.id,
  hash: false,
  tcp: false,
  stream: () => archive.replicate({ live: true })
}))

sw.listen(3282)
archive.on('ready', function () {
  sw.join(archive.discoveryKey)
  console.log('\nkey is', archive.discoveryKey.toString('hex') + '\n')
})

vmStats(function (name, data) {
  var now = ms(process.hrtime())

  archive.writeFile(`/${id}/${name}/${now}`, JSON.stringify(data))

  if (name === 'memory') {
    console.log('memory used', pretty(data))
  } else if (name === 'cpu') {
    console.log('cpu used', data + '%')
  } else if (name === 'load') {
    console.log('event loop delay high', data + 'ms')
  } else if (name === 'unload') {
    console.log('event loop delay low', data + 'ms')
  } else if (name === 'heapsnapshot') {
    console.log('snapshot taken', pretty(data.length))
  } else {
    console.log(name, data)
  }
})

require('http').createServer(function (req, res) {
  res.end('hiiii')
}).listen(8080)

function ms (ts) {
  return (ts[0] * 1e3) + (ts[1] / 1e6)
}
