'use strict'

const http = require('http')
const test = require('tap').test
const websocket = require('websocket-stream')
const proxyquire = require('proxyquire')
let server, cliToken
let simulateTimeout = false
let simulateNoToken = false

test('Before all', function (t) {
  server = http.createServer(() => {})

  websocket.createServer({ server }, conn => {
    conn.on('data', token => {
      cliToken = token.toString('utf8')
      if (simulateTimeout) {
        conn.write('timeout\n')
      } else if (simulateNoToken) {
        conn.write('\n')
      } else {
        conn.write('jwtToken\n')
      }
      conn.end()
    })
  })

  server.listen(0, function () {
    t.plan(1)
    t.ok(server)
  })
})

test('authenticate', function (t) {
  let openedUrl
  const opnStub = url => {
    openedUrl = url
  }

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  return authenticate(`http://127.0.0.1:${server.address().port}`)
    .then(jwtToken => {
      t.plan(2)
      t.strictEqual(openedUrl.split('token=')[1], cliToken)
      t.strictEqual(jwtToken, 'jwtToken')
    })
})

test('authenticate timeout', function (t) {
  const opnStub = url => url

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  simulateTimeout = true
  return authenticate(`http://127.0.0.1:${server.address().port}`)
    .then(() => {
      simulateTimeout = false
      t.fail('it should reject')
    })
    .catch(err => {
      t.plan(2)
      t.ok(err)
      t.ok(err.message.includes('Authentication timed out'))
      simulateTimeout = false
    })
})

test('authenticate no auth token', function (t) {
  const authenticate = proxyquire('../lib/authenticate', { 'opn': url => url }) // mocking the browser opening

  simulateNoToken = true
  return authenticate(`http://127.0.0.1:${server.address().port}`)
    .then(() => {
      simulateNoToken = false
      t.fail('it should reject')
    })
    .catch(err => {
      t.plan(2)
      t.ok(err)
      t.ok(err.message.includes('Authentication failed. No token obtained'))
      simulateNoToken = false
    })
})

test('After all', function (t) {
  t.plan(0)
  server.close()
})
