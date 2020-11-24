'use strict'

const http = require('http')

http.createServer(handler).listen(0)

function handler (req, res) {
  // make this slow
  /* eslint-disable no-empty */
  for (let i = 0; i < 1000000; i++) {}
  /* eslint-enable no-empty */
  res.end('ok')
}
