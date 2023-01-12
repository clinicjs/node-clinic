const async = require('async')
const shell = require('shelljs')

module.exports = function (exit) {
  async.waterfall([
    function (next) {
      next()
    },
    function (next) {
      next()
    }
  ], exit)
}

!module.parent && module.exports(shell.exit)
