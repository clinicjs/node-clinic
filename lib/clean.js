const fs = require('fs')
const rimraf = require('rimraf')
const path = require('path')
const async = require('async')

module.exports = clean

function clean (dir, cb) {
  fs.readdir(dir, function (err, entries) {
    if (err) return cb(err)

    const pathsToRemove = entries
      .filter(entry => /^(\.clinic|\d+\.clinic-\w+(\.html)?|node_trace\.\d+\.log)$/.test(entry))
      .map(entry => path.join(dir, entry))

    async.eachSeries(
      pathsToRemove,
      (entry, next) => rimraf(entry, { disableGlob: true }, next),
      cb
    )
  })
}
