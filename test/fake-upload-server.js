'use strict'

const tar = require('tar-stream')
const http = require('http')
const zlib = require('zlib')
const collect = require('stream-collector')

class FakeUploadServer {
  constructor () {
    const self = this
    this.requests = []
    this.uploadUrl = null

    this.server = http.createServer(function (req, res) {
      const request = {
        method: req.method,
        url: req.url
      }

      if (request.url === '/ask' && request.method === 'POST') {
        self.requests.push(request)
        res.end('{"message": "ok"}')
        return
      }

      request.files = {}
      let filename
      req.pipe(zlib.createGunzip()).pipe(tar.extract())
        .on('entry', function (entry, stream, next) {
          if (entry.type === 'file') {
            if (entry.name.endsWith('.html')) {
              filename = entry.name
            }
            collect(stream, function (_, data) {
              request.files[entry.name] = Buffer.concat(data).toString()
            })
          }

          next()
        })
        .on('finish', function () {
          res.end(`{"id": "some-id", "html": "/public/some-id/${filename}"}`)
          self.requests.push(request)
        })
    })
  }

  listen (callback) {
    const self = this
    this.server.listen(0, '127.0.0.1', function () {
      self.uploadUrl = `http://127.0.0.1:${self.server.address().port}`
      callback()
    })
  }

  close (callback) {
    this.server.close(callback)
  }
}

module.exports = FakeUploadServer
