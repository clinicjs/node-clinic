const fs = require('fs')
const get = require('simple-get')
const os = require('os')
const path = require('path')
const rimraf = require('rimraf')

const baseUrl = 'https://test-wprl.auth.us-east-2.amazoncognito.com/'
const clientId = '3h21816o70ts9c28vu8guopa07'
const dotFileName = path.join(os.homedir(), '.clinic')
const tokenEndpoint = `${baseUrl}/oauth2/token`
// const userInfoEndpoint = `${baseUrl}/oauth2/userInfo`

module.exports = { clientId, loadTokens, refreshTokens, removeTokens, saveTokens }

function loadTokens (cb) {
  fs.readFile(dotFileName, function (err, text) {
    if (err) return cb(err)

    try {
      cb(null, JSON.parse(text))
    } catch (err) {
      const { code } = err
      // If the file was not there, return an empty object.
      if (code === 'ENOENT') return cb(null, {})
      cb(err)
    }
  })
}

function refreshTokens (cb) {
  loadTokens(function (err, { refreshToken }) {
    if (err) return cb(err)
    if (!refreshToken) return cb()

    const request = {
      body: {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      url: tokenEndpoint
    }

    get(request, function (err, res, body) {
      if (err) return cb(err)

      const { statusCode } = res

      if (statusCode === 200) {
        const { access_token: nextAccessToken } = body
        saveTokens({ accessToken: nextAccessToken, refreshToken }, cb)
      } else if (statusCode === 400) {
        cb()
      } else {
        cb(new Error('Received unexpected response from token endpoint'))
      }
    })
  })
}

function removeTokens (cb) {
  rimraf(dotFileName, cb)
}

function saveTokens ({ accessToken, refreshToken }, cb) {
  try {
    const text = JSON.stringify({ accessToken, refreshToken })
    fs.writeFile(dotFileName, text, cb)
  } catch (err) {
    process.nextTick(function () { cb(err) })
  }
}
