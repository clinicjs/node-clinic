'use strict'

const http = require('http')

http.createServer(handler).listen(0)

function handler (req, res) {
  // make this slow
  for (let i = 0; i < 1000000; i++) {}
  res.end('ok')
}
