var http = require('http')
var pino = require('pino')

var log = pino()

http.createServer(function (req, res) {
  log.info('Request for ', req.url)
  res.end('hiiii')
}).listen(8080)
