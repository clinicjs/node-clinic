'use strict'

const http = require('http')
const test = require('tap').test
const websocket = require('websocket-stream')
const proxyquire = require('proxyquire')
const jwt = require('jsonwebtoken')
let server, cliToken
let simulateTimeout = false
let simulateNoToken = false

let testToken = jwt.sign({
  email: 'xyz@abc.def'
}, Buffer.alloc(64), {
  expiresIn: '10 seconds'
})

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
        conn.write(`${testToken}\n`)
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
  await authenticate.logout(`http://127.0.0.1:${server.address().port}`)

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`)
  t.plan(2)
  t.strictEqual(openedUrl.split('token=')[1], cliToken)
  t.strictEqual(jwtToken, testToken)
})

test('authenticate without cache', async function (t) {
  t.plan(6)
  let openedUrl = ''
  let calls = 0
  const opnStub = url => {
    calls += 1
    openedUrl = url
  }

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening
  await authenticate.logout(`http://127.0.0.1:${server.address().port}`)

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`)
  t.strictEqual(jwtToken, testToken)
  t.strictEqual(calls, 1)
  const jwtToken2 = await authenticate(`http://127.0.0.1:${server.address().port}`)
  t.strictEqual(jwtToken2, testToken)
  t.strictEqual(calls, 1)
  const jwtToken3 = await authenticate(`http://127.0.0.1:${server.address().port}`, {
    useCached: false
  })
  t.strictEqual(jwtToken3, testToken)
  t.strictEqual(calls, 2)
})

test('authenticate timeout', async function (t) {
  const opnStub = url => url

  const authenticate = proxyquire('../lib/authenticate', { 'opn': opnStub }) // mocking the browser opening
  await authenticate.logout(`http://127.0.0.1:${server.address().port}`)

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
  await authenticate.logout(`http://127.0.0.1:${server.address().port}`)

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
  await authenticate.logout(`http://127.0.0.1:${server.address().port}`)

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
