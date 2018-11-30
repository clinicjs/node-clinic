'use strict'

const http = require('http')

http.createServer((req, res) => res.end('ok')).listen(0)
