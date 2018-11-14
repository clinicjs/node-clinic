'use strict'

const http = require('http')
const test = require('tap').test
const websocket = require('websocket-stream')
const proxyquire = require('proxyquire')
const split2 = require('split2')
const { ReadableStreamBuffer } = require('stream-buffers')

test('authenticate', function (t) {
  let openedUrl, cliToken
  const opnStub = url => {
    openedUrl = url
  }
  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  const server = http.createServer(() => {})
  websocket.createServer({ server }, conn => {
    conn.pipe(split2())
      .on('data', token => {
        cliToken = token
        const readBuffer = new ReadableStreamBuffer()
        readBuffer.pipe(conn)
        readBuffer.put('jwtToken\n')
        readBuffer.stop()
      })
  })

  server.listen(0, () => {
    authenticate(`http://127.0.0.1:${server.address().port}`)
      .then(jwtToken => {
        t.strictEqual(openedUrl.split('token=')[1], cliToken)
        t.strictEqual(jwtToken, 'jwtToken')
        server.close(() => t.end())
      })
  })
})
