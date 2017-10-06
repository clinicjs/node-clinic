#! /usr/bin/env node

const fs = require('fs')
const path = require('path')
const minimist = require('minimist')

// The first parameter is special and indicates the tool
const tool = process.argv[2]
const slice = (typeof tool === 'string' && tool[0] === '-') ? 2 : 3
const args = process.argv.slice(slice)

// parse options
const argv = minimist(args, {
  alias: {
    help: 'h',
    version: 'v'
  },
  boolean: [
    'help',
    'version',
    'collect-only',
    'visualize'
  ]
})

// get executable parameters, by removeing everything before the first
// unrecognized option. Note, this only works because there are only
// boolean parameters.
const extra = process.argv.slice(process.argv.indexOf(argv._[0], 2))

// First check the tool, then check the --version and --help arguments.
// This is to prevent `clinic doctor node script.js --help` from printing
// the help text.
if (tool === 'doctor') {
  require('./doctor/bin.js')(argv, extra)
} else if (tool === 'bubbleprof') {
  require('./bubbleprof/bin.js')(argv, extra)
} else if (argv.version) {
  printVersion()
} else if (argv.help) {
  printHelp()
} else {
  printHelp()
  process.exit(1)
}

function printVersion () {
  console.log('v' + require('../package.json').version)
}

function printHelp () {
  const usage = fs.readFileSync(path.resolve(__dirname, './usage.txt'))
    .toString()
    .replace('{{version}}', require('../package.json').version)
  console.log(usage)
}
