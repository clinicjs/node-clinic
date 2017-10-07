#! /usr/bin/env node
'use strict'

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
    'visualize-only'
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
  runTool(require('./doctor'))
} else if (tool === 'bubbleprof') {
  runTool(require('./bubbleprof'))
} else if (argv.version) {
  printVersion()
} else if (argv.help) {
  printHelp()
} else {
  printHelp()
  process.exit(1)
}

function runTool (Tool) {
  const tool = new Tool()

  if (argv['collect-only']) {
    tool.collect(extra, handleError)
  } else if (argv['visualize-only']) {
    tool.visualize(handleError)
  } else {
    tool.collect(extra, function (err) {
      if (err) handleError(err)
      tool.visualize(handleError)
    })
  }
}

function handleError (err) {
  if (err) throw err
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
