var defaults = require('dat-swarm-defaults')
var swarm = require('discovery-swarm')
var hyperdrive = require('hyperdrive')
var vmStats = require('./')

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
  archive.writeFile(`/${name}/${now}`, JSON.stringify(data))
})

function ms (ts) {
  return (ts[0] * 1e3) + (ts[1] / 1e6)
}
