'use strict'

const opn = require('opn')
const path = require('path')
const fs = require('fs')
const { promisify } = require('util')
const { homedir } = require('os')
const randtoken = require('rand-token')
const websocket = require('websocket-stream')
const split2 = require('split2')
const { ReadableStreamBuffer } = require('stream-buffers')
const { URL } = require('url')
const pump = require('pump')
const jwt = require('jsonwebtoken')

const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

const credentialsPath = path.join(homedir(), '.node-clinic-rc')

async function loadToken (url) {
  let tokens
  try {
    const data = await readFile(credentialsPath)
    tokens = JSON.parse(data)
  } catch (err) {}
  return tokens && tokens[url]
}

async function saveToken (url, token) {
  let tokens
  try {
    const data = await readFile(credentialsPath)
    tokens = JSON.parse(data)
  } catch (err) {}

  // if it was empty or contained `null` for some reason
  if (typeof tokens !== 'object' || !tokens) {
    tokens = {}
  }

  tokens[url] = token

  await writeFile(credentialsPath, JSON.stringify(tokens, null, 2))
}

/**
 * Get the JWT token from the Upload server specified by the URL.
 * - create a random tokens
 * - open a websocket on the server
 * - push the token through the websocket
 * - Open the browser on `http://localhost:3000/?token=${cliToken}`
 * - Get the JWT from the web websocket
 */
function authenticateViaBrowser (url) {
  return new Promise((resolve, reject) => {
    const cliToken = randtoken.generate(128)
    const parsedURL = new URL(url)
    /* istanbul ignore next */
    parsedURL.protocol = url && url.toLowerCase().includes('https') ? 'wss:/' : 'ws:/'
    const wsUrl = parsedURL.toString()
    const ws = websocket(wsUrl)

    const readBuffer = new ReadableStreamBuffer()
    readBuffer.put(cliToken)
    pump(readBuffer, ws, split2(), err => err ? reject(err) : /* istanbul ignore next */ null)
      .on('data', (authToken) => {
        let err
        if (!authToken) {
          err = new Error('Authentication failed. No token obtained.')
        } else if (typeof authToken === 'string' && authToken.toLowerCase() === 'timeout') {
          err = new Error('Authentication timed out.')
        }

        err ? reject(err) : resolve(authToken)
        ws.destroy()
      })

    ws.once('connect', () => {
      console.log('Authentication required. Opening the login page in a browser...')
      // Open the url in the default browser
      const cliLoginUrl = `${url}?token=${cliToken}`
      opn(cliLoginUrl, { wait: false })
    })
  })
}

async function authenticate (url) {
  const mockJWT = process.env.CLINIC_JWT
  const mockFail = process.env.CLINIC_MOCK_AUTH_FAIL
  if (mockJWT) {
    return mockJWT
  }
  if (mockFail) {
    throw new Error('Auth artificially failed')
  }

  // Use cached token if it's not expired
  try {
    const existingJWT = await loadToken(url)
    if (existingJWT) {
      const header = jwt.decode(existingJWT)
      if (header && header.exp > Math.floor(Date.now() / 1000)) {
        return existingJWT
      }
    }
  } catch (err) {}

  const newJWT = await authenticateViaBrowser(url)
  await saveToken(url, newJWT)
  return newJWT
}

module.exports = authenticate