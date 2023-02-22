const async = require('async')

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

!module.parent && module.exports(process.exit)
