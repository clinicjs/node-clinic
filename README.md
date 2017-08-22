# vm-stats
[![npm version][2]][3] [![build status][4]][5]
[![downloads][8]][9] [![js-standard-style][10]][11]

Aggregate stats from the Node VM.

## Usage
```js
var vmStats = require('vm-stats')

vmStats(function (eventName, data) {
  console.log(eventName, data)
})
```

## License
[MIT](https://tldrlegal.com/license/mit-license)

[0]: https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square
[1]: https://nodejs.org/api/documentation.html#documentation_stability_index
[2]: https://img.shields.io/npm/v/vm-stats.svg?style=flat-square
[3]: https://npmjs.org/package/vm-stats
[4]: https://img.shields.io/travis/nearform/vm-stats/master.svg?style=flat-square
[5]: https://travis-ci.org/nearform/vm-stats
[6]: https://img.shields.io/codecov/c/github/nearform/vm-stats/master.svg?style=flat-square
[7]: https://codecov.io/github/nearform/vm-stats
[8]: http://img.shields.io/npm/dm/vm-stats.svg?style=flat-square
[9]: https://npmjs.org/package/vm-stats
[10]: https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat-square
[11]: https://github.com/feross/standard
