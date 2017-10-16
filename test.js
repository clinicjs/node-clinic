'use strict'

const minimist = require('minimist')

const argv = minimist(process.argv.slice(2), {
  boolean: [
    'collect-only'
  ],
  string: [
    'visualize-only',
    'sample-interval'
  ]
})

console.log(argv)
