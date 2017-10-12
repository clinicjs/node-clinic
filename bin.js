#! /usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const commist = require('commist')
const minimist = require('minimist')

const result = commist()
  .register('doctor', function (args) {
    const argv = minimist(args, {
      boolean: [
        'collect-only'
      ],
      string: [
        'visualize-only'
      ]
    })

    runTool(argv, require('clinic-doctor'))
  })
  .register('bubbleprof', function (args) {
    const argv = minimist(args, {
      boolean: [
        'collect-only'
      ],
      string: [
        'visualize-only'
      ]
    })

    runTool(argv, require('clinic-doctor'))
  })
  .parse(process.argv.slice(2))

// not `clinic doctor` and not `clinic bubbleprof`
if (result !== null) {
  const argv = minimist(process.argv.slice(1), {
    alias: {
      help: 'h',
      version: 'v'
    },
    boolean: [
      'help',
      'version'
    ]
  })

  if (argv.version) {
    printVersion()
  } else if (argv.help) {
    printHelp()
  } else {
    printHelp()
    process.exit(1)
  }
}

function runTool (argv, Tool) {
  // Get executable parameters, by removeing everything before the first
  // unrecognized option. Note, this only works because there are only
  // boolean parameters when collecting data.
  const executeArgs = process.argv.slice(process.argv.indexOf(argv._[0], 2))

  const tool = new Tool()

  if (argv['collect-only']) {
    tool.collect(executeArgs, function (err, filename) {
      if (err) throw err
      console.log(`output file is ${filename}`)
    })
  } else if (argv['visualize-only']) {
    tool.visualize(
      argv['visualize-only'],
      argv['visualize-only'] + '.html',
      function (err) {
        if (err) throw err
      }
    )
  } else {
    tool.collect(executeArgs, function (err, filename) {
      if (err) throw err
      tool.visualize(filename, filename + '.html', function (err) {
        if (err) throw err
      })
    })
  }
}

function printVersion () {
  console.log('v' + require('./package.json').version)
}

function printHelp () {
  const usage = fs.readFileSync(path.resolve(__dirname, './usage.txt'))
    .toString()
    .replace('{{version}}', require('./package.json').version)
  console.log(usage)
}
