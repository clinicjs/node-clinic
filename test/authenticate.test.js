'use strict'

const http = require('http')
const test = require('tap').test
const websocket = require('websocket-stream')
const proxyquire = require('proxyquire')
let server, cliToken
let simulateTimeout = false
let simulateNoToken = false

function openSuccess () {
  return Promise.resolve({
    on: (event, fn) => fn(0)
  })
}

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
  const openStub = url => {
    openedUrl = url
    return openSuccess()
  }

  const authenticate = proxyquire('../lib/authenticate', { open: openStub }) // mocking the browser opening

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`)
  t.plan(2)
  t.strictEqual(openedUrl.split('/auth/token/')[1].replace('/', ''), cliToken)
  t.strictEqual(jwtToken, 'jwtToken')
})

test('authenticate for private upload', async function (t) {
  let openedUrl = ''
  const openStub = url => {
    openedUrl = url
    return openSuccess()
  }

  const authenticate = proxyquire('../lib/authenticate', { open: openStub }) // mocking the browser opening

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
  const openStub = url => {
    openedUrl = url
    return openSuccess()
  }

  const authenticate = proxyquire('../lib/authenticate', { open: openStub }) // mocking the browser opening

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`, {
    ask: true
  })
  const [token, askQuery] = openedUrl.split('/auth/token/')[1].split('?')
  t.plan(3)
  t.strictEqual(token.replace('/', ''), cliToken)
  t.strictEqual(askQuery, 'ask=1&private=1')
  t.strictEqual(jwtToken, 'jwtToken')
})

test('authenticate does not try to open browser in SSH session', async function (t) {
  const openStub = url => t.fail('should not try to open browser')

  const origEnv = process.env
  process.env = { ...origEnv, SSH_CLIENT: '127.0.0.1 1234 22' } // IP PID port
  t.on('end', () => { process.env = origEnv })
  const authenticate = proxyquire('../lib/authenticate', { open: openStub })

  const jwtToken = await authenticate(`http://127.0.0.1:${server.address().port}`, {
    ask: true
  })
  t.ok(jwtToken)
})

test('authenticate timeout', async function (t) {
  const openStub = url => openSuccess()

  const authenticate = proxyquire('../lib/authenticate', { open: openStub }) // mocking the browser opening

  simulateTimeout = true
  t.on('end', () => {
    simulateTimeout = false
  })

  try {
    await authenticate(`http://127.0.0.1:${server.address().port}`)
    t.fail('it should reject')
  } catch (err) {
    t.plan(2)
    t.ok(err)
    t.ok(err.message.includes('Authentication timed out'))
  }
})

test('authenticate no auth token', async function (t) {
  const openStub = url => openSuccess()

  const authenticate = proxyquire('../lib/authenticate', { open: openStub }) // mocking the browser opening

  simulateNoToken = true
  t.on('end', () => {
    simulateNoToken = false
  })
  try {
    await authenticate(`http://127.0.0.1:${server.address().port}`)
    t.fail('it should reject')
  } catch (err) {
    t.plan(2)
    t.ok(err)
    t.ok(err.message.includes('Authentication failed. No token obtained'))
  }
})

test('authenticate failure', async function (t) {
  const openStub = url => openSuccess()

  const authenticate = proxyquire(
    '../lib/authenticate',
    {
      open: openStub,
      split2: () => ({ on: () => [] })
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
