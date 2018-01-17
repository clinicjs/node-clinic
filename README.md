# node-clinic
[![npm version][2]][3] [![build status][4]][5]
[![downloads][8]][9] [![js-standard-style][10]][11]

## Install

```
npm install -g clinic
```

## Getting started
As a first step, run the <code>clinic doctor</code>:

  <code>clinic doctor -- node server.js</code>

Then benchmark your server with <code>wrk</code> or <code>autocannon</code>:

```
wrk http://localahost:3000
autocannon http://localahost:3000
```

Finally shut down your server (Ctrl+C). Once the server process has shutdown
<code>clinic doctor</code> will analyse the collected data and detect what type of issue
you are having. Based on the issue type, it will provide a recommendation for
you.

For example, to debug I/O issues, use <code>clinic bubbleprof</code>:

```
clinic bubbleprof -- node server.js
```

Then benchmark your server again, just like you did with <code>clinic doctor</code>.

## Report an issue
If you encounter any issue, feel free to send us an issue report at:

```
https://github.com/nearform/node-clinic/issues
```

When creating an issue, it will be a huge help for us if you upload your
data to the clinic cloud. To do this, use <code>clinic upload</code>:

```
clinic upload 1000.clinic-doctor
```

## More information
For more information use the <code>--help</code> option:

```
clinic doctor --help
clinic bubbleprof --help
clinic upload --help
```

## Flags
```
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
