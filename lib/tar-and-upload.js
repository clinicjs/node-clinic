'use strict'

const tar = require('tar-fs')
const collect = require('stream-collector')
const get = require('simple-get')
const path = require('path')
const zlib = require('zlib')

module.exports = tarAndUpload

function tarAndUpload (filePrefix, uploadUrl, cb) {
  const parentDirectory = path.dirname(filePrefix)

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

      if (entry === filePrefix + '.html') return false
      if (entry === filePrefix) return false
      return !entry.startsWith(filePrefix + path.sep)
    }
  })

  stream.on('data', limitSize)
  collect(stream, ontarred)

  function limitSize (data) {
    limit -= data.length
    if (limit < 0) stream.destroy(new Error('Too much data. Should be less than 32MB'))
  }

  function ontarred (err, data) {
    if (err) return cb(err)
    if (empty) return cb(new Error('No data to upload'))

    zlib.gzip(Buffer.concat(data), function (err, zipped) {
      /* istanbul ignore if: no known failure path for gzip */
      if (err) return cb(err)

      get.concat({
        method: 'POST',
        url: uploadUrl + '/data',
        body: zipped
      }, onupload)
    })
  }

  function onupload (err, res, body) {
    if (err) return cb(err)
    if (!/^2\d\d$/.test(res.statusCode)) {
      return cb(new Error('Bad status code: ' + res.statusCode))
    }
    try {
      var reply = JSON.parse(body)
    } catch (err) {
      return cb(err)
    }
    cb(null, reply)
  }
}
