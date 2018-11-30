'use strict'

const http = require('http')

http.createServer(handler).listen(0)

function handler (req, res) {
  res.end('ok')
}
