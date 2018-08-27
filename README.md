![banner](logo.png)

# node-clinic

[![Greenkeeper badge](https://badges.greenkeeper.io/nearform/node-clinic.svg)](https://greenkeeper.io/)

[![npm version][2]][3] [![build status][4]][5] [![build status][12]][13]
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
wrk http://localhost:3000
autocannon http://localhost:3000
```

If you want to run autocannon or wrk as soon as your server starts listening you can
use the `--on-port` option

```sh
# $PORT is the port the server is listening on
clinic doctor --on-port 'autocannon http://localhost:$PORT' -- node server.js
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

Note that when looking at the CPU graph you might notice that it doesn't
necessarily go from 0-100 but might go from 0-200 or higher. This is because the
percentage reflects the total amount of CPU cores your computer has. Node.js
itself uses more than one thread behind the scene even though JavaScript is
single threaded. V8 (The JavaScript engine) runs the garbage collector and some
optimizations on background threads. With worker threads, the CPU will also
utilize more than 100%. The visible percentage is always the combination of all
these factors together.

## Supported Node.js versions

Clinic relies heavily on Node.js core instrumentation available in later versions.
Currently the supported Node.js versions are `^10.0.0` and `^8.9.4`.

## Examples and Demos

- [A set of simple Doctor examples](https://github.com/nearform/node-clinic-doctor-examples)
- [A set of simple Bubbleprof examples](https://github.com/nearform/node-clinic-bubbleprof-examples)
- [A MongoDB-based Bubbleprof demo/example](https://github.com/nearform/node-clinic-bubbleprof-demo)
- [A Flame demo/example](https://github.com/nearform/node-clinic-flame-demo)

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

and include the URL that it returns.

## More information

For more information use the <code>--help</code> option:

```
clinic doctor --help
clinic bubbleprof --help
clinic flame --help
clinic upload --help
```

- The Doctor functionality is provided by the [clinic-doctor](https://github.com/nearform/node-clinic-doctor) module.
- The Bubbleprof functionality is provided by [clinic-bubbleprof](https://github.com/nearform/node-clinic-bubbleprof).
- The Flame functionality is provided by [clinic-flame](https://github.com/nearform/node-clinic-flame).

## Flags

```
-h | --help                Display Help
-v | --version             Display Version
--debug                    Do not minify generated files
```

## Programmable Interfaces

Each of the tools has a programmable interface which you can read about in their repos.

- [Node Clinic Doctor](https://github.com/nearform/node-clinic-doctor)
- [Node Clinic Bubbleprof](https://github.com/nearform/node-clinic-bubbleprof)
- [Node Clinic Flame](https://github.com/nearform/node-clinic-flame)

## License

[GPL 3.0](LICENSE)

[0]: https://img.shields.io/badge/stability-experimental-orange.svg?style=flat-square
[1]: https://nodejs.org/api/documentation.html#documentation_stability_index
[2]: https://img.shields.io/npm/v/clinic.svg?style=flat-square
[3]: https://npmjs.org/package/clinic
[4]: https://circleci.com/gh/nearform/node-clinic/tree/master.svg?style=shield&circle-token=898867ce2715cb4b51018bb20c7798c1dd306250
[5]: https://circleci.com/gh/nearform/node-clinic
[6]: https://img.shields.io/codecov/c/github/nearform/node-clinic/master.svg?style=flat-square
[7]: https://codecov.io/github/nearform/node-clinic
[8]: http://img.shields.io/npm/dm/clinic.svg?style=flat-square
[9]: https://www.npmjs.org/package/clinic
[10]: https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat-square
[11]: https://github.com/feross/standard
[12]: https://ci.appveyor.com/api/projects/status/ex654mc4b3dq3vf4?svg=true
[13]: https://ci.appveyor.com/project/nearForm/node-clinic
