const opn = require('opn')
const randtoken = require('rand-token')
const websocket = require('websocket-stream')
const split2 = require('split2')
const { ReadableStreamBuffer } = require('stream-buffers')
const { URL } = require('url')

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
    const cliToken = randtoken.generate(128)
    const parsedURL = new URL(url)
    parsedURL.protocol = 'ws:/'
    const wsUrl = parsedURL.toString()
    const ws = websocket(wsUrl)
    const readBuffer = new ReadableStreamBuffer()
    readBuffer.put(cliToken + '\n')
    readBuffer.pipe(ws).pipe(split2()).on('data', auth0Token => resolve(auth0Token))
    // Open the url in the default browser
    const cliLoginUrl = `${url}?token=${cliToken}`
    opn(cliLoginUrl, { wait: false })
  })

module.exports = authenticate
