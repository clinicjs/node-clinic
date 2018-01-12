# node-clinic
[![npm version][2]][3] [![build status][4]][5]
[![downloads][8]][9] [![js-standard-style][10]][11]

Aggregate stats from the Node VM, and expose them for later analysis.

## Usage
```txt
  Clinic

  As a first step, run the clinic doctor:

    clinic doctor -- node server.js

  To debug asynchronous issues and event loop issues, use clinic bubbleprof:

    clinic bubbleprof -- node server.js

  To help us improve the tool, upload your data to the clinic cloud:

    clinic upload 1000.clinic-doctor

  For more information use the --help option:

    clinic doctor --help
    clinic bubbleprof --help
    clinic upload --help

  Flags
  -h | --help                Display Help
  -v | --version             Display Version
```

## License
[MIT](https://tldrlegal.com/license/mit-license)

[0]: https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square
[1]: https://nodejs.org/api/documentation.html#documentation_stability_index
[2]: https://img.shields.io/npm/v/node-clinic.svg?style=flat-square
[3]: https://npmjs.org/package/node-clinic
[4]: https://img.shields.io/travis/nearform/node-clinic/master.svg?style=flat-square
[5]: https://travis-ci.org/nearform/node-clinic
[6]: https://img.shields.io/codecov/c/github/nearform/node-clinic/master.svg?style=flat-square
[7]: https://codecov.io/github/nearform/node-clinic
[8]: http://img.shields.io/npm/dm/node-clinic.svg?style=flat-square
[9]: https://npmjs.org/package/node-clinic
[10]: https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat-square
[11]: https://github.com/feross/standard
