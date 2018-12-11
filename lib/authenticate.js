'use strict'

const opn = require('opn')
const randtoken = require('rand-token')
const websocket = require('websocket-stream')
const split2 = require('split2')
const { ReadableStreamBuffer } = require('stream-buffers')
const { URL } = require('url')
const pump = require('pump')

/**
 * Get the JWT token from the Upload server specified by the URL.
 * - create a random tokens
 * - open a websocket on the server
 * - push the token through the websocket
 * - Open the browser on `http://localhost:3000/?token=${cliToken}`
 * - Get the JWT from the web websocket
 */
const authenticate = url =>
  new Promise((resolve, reject) => {
    const mockJWT = process.env.CLINIC_ASK_JWT
    const mockFail = process.env.CLINIC_ASK_FORCE_FAIL
    if (mockJWT) {
      return resolve(mockJWT)
    }
    if (mockFail) {
      return reject(new Error('Auth artificially failed'))
    }

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

module.exports = authenticate
