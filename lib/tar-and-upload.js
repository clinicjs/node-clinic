'use strict'

const tar = require('tar-fs')
const collect = require('stream-collector')
const pumpify = require('pumpify')
const get = require('simple-get')
const path = require('path')
const zlib = require('zlib')

module.exports = tarAndUpload

function tarAndUpload (filePrefix, uploadUrl, authToken, opts, cb) {
  const parentDirectory = path.dirname(filePrefix)
  const isPrivate = opts && opts.private

  let empty = true
  let limit = 32 * 1024 * 1024 // 32MB

  const stream = tar.pack(parentDirectory, {
    map: function (entry) {
      if (entry.type === 'file') empty = false
      return entry
    },
    filter: function (entry) {
      // Tar both the raw data directory and the html file, for example:
      //
      //   1000.clinic-doctor.html
      //   1000.clinic-doctor
      //
      // filter provides the dirname or filename and should return
      // true if you want to filter out and entry and false if you want to
      // keep it

      if (!/(\/|\\|^)\d+\.clinic-\w+(\/|\\|\.html$|$)/.test(entry)) return true
      if (entry === filePrefix + '.html') return false
      if (entry === filePrefix) return false
      return !entry.startsWith(filePrefix + path.sep)
    }
  })

  const zip = pumpify(stream, zlib.createGzip())
  zip.on('data', limitSize)
  collect(zip, ontarred)

  function limitSize (data) {
    limit -= data.length
    if (limit < 0) stream.destroy(new Error('Too much data. Should be less than 32MB'))
  }

  function ontarred (err, zipped) {
    if (err) return cb(err)
    if (empty) return cb(new Error('No data to upload'))

    const opts = {
      method: 'POST',
      url: `${uploadUrl}${isPrivate ? '/protected/data' : '/data'}`,
      body: Buffer.concat(zipped)
    }

    opts.headers = {
      'Authorization': `Bearer ${authToken}`
    }

    get.concat(opts, onupload)
  }

  function onupload (err, res, body) {
    if (err) return cb(err)
    if (!/^2\d\d$/.test(res.statusCode)) {
      var error = new Error('Bad status code: ' + res.statusCode)
      try {
        error.reply = JSON.parse(body)
      } catch (err) {}
      return cb(error)
    }
    try {
      var reply = JSON.parse(body)
    } catch (err) {
      return cb(err)
    }
    cb(null, reply)
  }
}
