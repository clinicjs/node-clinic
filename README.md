# node-clinic
[![npm version][2]][3] [![build status][4]][5]
[![downloads][8]][9] [![js-standard-style][10]][11]

Aggregate stats from the Node VM, and expose them for later analysis.

## Usage
```txt
  $ node-clinic <entry-file> [options]

  Options:

    -h, --help        print usage
    -v, --version     print version

  Examples:

    Debug a node application
    $ node-clinic

  Running into trouble? Feel free to file an issue:
  https://github.com/nearform/node-clinic/issues/new

  Do you enjoy using this software? nearForm is hiring!
  https://www.nearform.com/careers/
```

## Example Output
```txt
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805287,"msg":"stats","type":"memory","data":0.004611492156982422,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805290,"msg":"stats","type":"cpu","data":95.5,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805601,"msg":"stats","type":"memory","data":0.004633903503417969,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805602,"msg":"stats","type":"cpu","data":32.4,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805913,"msg":"stats","type":"memory","data":0.004634857177734375,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668805913,"msg":"stats","type":"cpu","data":14.1,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668806223,"msg":"stats","type":"memory","data":0.004637718200683594,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668806223,"msg":"stats","type":"cpu","data":5.3,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668806537,"msg":"stats","type":"gc","data":{"pause":3239663,"pauseMS":3,"gctype":1,"before":{"totalHeapSize":17301504,"totalHeapExecutableSize":4194304,"usedHeapSize":9891544,"heapSizeLimit":1501560832,"totalPhysicalSize":12279336,"totalAvailableSize":1484219240,"mallocedMemory":8192,"peakMallocedMemory":11065664},"after":{"totalHeapSize":17825792,"totalHeapExecutableSize":4194304,"usedHeapSize":8735832,"heapSizeLimit":1501560832,"totalPhysicalSize":12635648,"totalAvailableSize":1485225960,"mallocedMemory":8192,"peakMallocedMemory":11065664},"diff":{"totalHeapSize":524288,"totalHeapExecutableSize":0,"usedHeapSize":-1155712,"heapSizeLimit":0,"totalPhysicalSize":356312,"totalAvailableSize":1006720,"mallocedMemory":0,"peakMallocedMemory":0}},"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668806537,"msg":"stats","type":"memory","data":0.004637718200683594,"v":1}
{"pid":86684,"hostname":"anons-MacBook.local","level":10,"time":1503668806537,"msg":"stats","type":"cpu","data":3.5,"v":1}
```

## See Also
- [nearform/node-clinic-parser](https://github.com/nearform/node-clinic-parser)

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
