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

const unlink = promisify(fs.unlink)
const readFile = promisify(fs.readFile)
const writeFile = promisify(fs.writeFile)

const credentialsPath = process.env.CLINIC_CREDENTIALS ||
  path.join(homedir(), '.node-clinic-rc')

const CUSTOM_CLAIM_NAMESPACE = 'https://upload.clinicjs.org/'
const ASK_CLAIM_KEY = `${CUSTOM_CLAIM_NAMESPACE}askTermsAccepted`

/**
 * Load the JWT for an Upload Server URL.
 */
async function loadToken (url) {
  let tokens
  try {
    const data = await readFile(credentialsPath)
    tokens = JSON.parse(data)
  } catch (err) {}
  return tokens && tokens[url]
}

/**
 * Check that a JWT has not expired.
 */
function validateToken (token) {
  const header = jwt.decode(token)
  const now = Math.floor(Date.now() / 1000)
  return header && header.exp > now
}

/**
 * Check that a JWT has Ask terms accepted.
 */
function validateAskPermission (token) {
  const header = jwt.decode(token)

  return validateToken(token) && header[ASK_CLAIM_KEY]
}

/**
 * Get the session data for an Upload Server URL.
 */
async function getSession (url) {
  const token = await loadToken(url)
  if (!token) return null
  const header = jwt.decode(token)
  if (!header) return null
  const now = Math.floor(Date.now() / 1000)
  if (header.exp <= now) return null
  return header
}

/**
 * Store the JWT for an Upload Server URL in the credentials file.
 */
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
 * - Open the browser on `http://localhost:3000/auth/token/${cliToken}/(?ask=1)(&private=1)`
 * - Get the JWT from the web websocket
 */
function authenticateViaBrowser (url, isAskFlow = false, isPrivate = false, clearSession = false) {
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
      const cliLoginUrl = generateBrowserLoginUrl(url, cliToken, {
        isAskFlow,
        isPrivate,
        clearSession
      })
      opn(cliLoginUrl, { wait: false })
    })
  })
}

async function authenticate (url, opts = {}) {
  const mockJWT = process.env.CLINIC_JWT
  const mockFail = process.env.CLINIC_MOCK_AUTH_FAIL
  if (mockJWT) {
    // store it if we ALSO specified a credentials file,
    // Normally, you shouldn't use both CLINIC_JWT and CLINIC_CREDENTIALS at the same time,
    // but this is a useful case for our tests
    if (process.env.CLINIC_CREDENTIALS) {
      await saveToken(url, mockJWT)
    }
    return mockJWT
  }
  if (mockFail) {
    throw new Error('Auth artificially failed')
  }

  // Use cached token if it's not expired
  const existingJWT = await loadToken(url)
  let clearSession = false
  if (existingJWT && validateToken(existingJWT)) {
    if (!opts.ask || validateAskPermission(existingJWT)) {
      return existingJWT
    } else if (opts.ask) {
      clearSession = true
    }
  }

  const newJWT = await authenticateViaBrowser(url, opts.ask, opts.private, clearSession)
  await saveToken(url, newJWT)
  return newJWT
}

async function getSessions () {
  let tokens = {}
  try {
    const data = await readFile(credentialsPath)
    tokens = JSON.parse(data)
  } catch (err) {}
  const sessions = {}
  Object.keys(tokens).forEach((url) => {
    sessions[url] = validateToken(tokens[url])
      ? jwt.decode(tokens[url])
      : null
  })
  return sessions
}

function logout (url) {
  return saveToken(url, undefined)
}

function removeSessions () {
  return unlink(credentialsPath)
}

function generateBrowserLoginUrl (base, token, opts = {}) {
  const url = new URL(`${base}/auth/token/${token}/`)

  if (opts.isAskFlow) {
    url.searchParams.append('ask', '1')
  }

  if (opts.isPrivate || opts.isAskFlow) {
    url.searchParams.append('private', '1')
  }

  if (opts.clearSession) {
    url.searchParams.append('clearSession', '1')
  }

  return url.toString()
}

module.exports = authenticate
module.exports.getSessions = getSessions
module.exports.getSession = getSession
module.exports.removeSessions = removeSessions
module.exports.logout = logout
