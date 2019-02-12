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

test('authenticate', async function (t) {
  let openedUrl = ''
  const opnStub = url => {
    openedUrl = url
  }

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`)
  t.plan(2)
  t.strictEqual(openedUrl.split('/auth/token/')[1].replace('/', ''), cliToken)
  t.strictEqual(jwtToken, 'jwtToken')
})

test('authenticate for private upload', async function (t) {
  let openedUrl = ''
  const opnStub = url => {
    openedUrl = url
  }

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`, {
    private: true
  })
  const [token, askQuery] = openedUrl.split('/auth/token/')[1].split('?')
  t.plan(3)
  t.strictEqual(token.replace('/', ''), cliToken)
  t.strictEqual(askQuery, 'private=1')
  t.strictEqual(jwtToken, 'jwtToken')
})

test('authenticate using ask', async function (t) {
  let openedUrl = ''
  const opnStub = url => {
    openedUrl = url
  }

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`, {
    ask: true
  })
  const [token, askQuery] = openedUrl.split('/auth/token/')[1].split('?')
  t.plan(3)
  t.strictEqual(token.replace('/', ''), cliToken)
  t.strictEqual(askQuery, 'ask=1&private=1')
  t.strictEqual(jwtToken, 'jwtToken')
})

test('authenticate timeout', async function (t) {
  const opnStub = url => url

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening

  simulateTimeout = true

  try {
    await authenticate(`http://127.0.0.1:${server.address().port}`)
    simulateTimeout = false
    t.fail('it should reject')
  } catch (err) {
    t.plan(2)
    t.ok(err)
    t.ok(err.message.includes('Authentication timed out'))
    simulateTimeout = false
  }
})

test('authenticate no auth token', async function (t) {
  const authenticate = proxyquire('../lib/authenticate', { 'opn': url => url }) // mocking the browser opening

  simulateNoToken = true
  try {
    await authenticate(`http://127.0.0.1:${server.address().port}`)
    simulateNoToken = false
    t.fail('it should reject')
  } catch (err) {
    t.plan(2)
    t.ok(err)
    t.ok(err.message.includes('Authentication failed. No token obtained'))
    simulateNoToken = false
  }
})

test('authenticate failure', async function (t) {
  const authenticate = proxyquire(
    '../lib/authenticate',
    {
      'opn': url => url,
      'split2': () => ({ on: () => [] })
    })

  try {
    await authenticate(`http://127.0.0.1:${server.address().port}`)
    t.fail('it should reject')
  } catch (err) {
    t.plan(1)
    t.ok(err)
  }
})

test('After all', function (t) {
  t.plan(0)
  server.close()
})
