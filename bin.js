#! /usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const open = require('open')
const commist = require('commist')
const minimist = require('minimist')

const result = commist()
  .register('doctor', function (args) {
    const version = require('clinic-doctor/package.json').version;
    const argv = minimist(args, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only'
      ],
      string: [
        'visualize-only',
        'sample-interval'
      ],
      default: {
        'sample-interval': '10'
      },
      '--': true
    })

    if (argv.version) {
      printVersion(version)
    } else if (argv.help) {
      printHelp('clinic-doctor', version)
    } else if (argv['visualize-only'] || argv['--'].length > 1) {
      runTool(argv, require('clinic-doctor'))
    } else {
      printHelp('clinic-doctor', version)
      process.exit(1)
    }
  })
  .register('bubbleprof', function (args) {
    const version = require('clinic-bubbleprof/package.json').version;
    const argv = minimist(args, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only'
      ],
      string: [
        'visualize-only'
      ],
      '--': true
    })

    if (argv.version) {
      printVersion(version)
    } else if (argv.help) {
      printHelp('clinic-bubbleprof', version)
    } else if (argv['visualize-only'] || argv['--'].length > 1) {
      runTool(argv, require('clinic-bubbleprof'))
    } else {
      printHelp('clinic-bubbleprof', version)
      process.exit(1)
    }
  })
  .parse(process.argv.slice(2))

// not `clinic doctor` and not `clinic bubbleprof`
if (result !== null) {
  const version = require('./package.json').version;
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
    printVersion(version)
  } else if (argv.help) {
    printHelp('clinic', version)
  } else {
    printHelp('clinic', version)
    process.exit(1)
  }
}

function runTool (argv, Tool) {
  const tool = new Tool({
    sampleInterval: parseInt(argv['sample-interval'], 10)
  })

  if (argv['collect-only']) {
    tool.collect(argv['--'], function (err, filename) {
      if (err) throw err
      console.log(`output file is ${filename}`)
    })
  } else if (argv['visualize-only']) {
    tool.visualize(
      argv['visualize-only'],
      argv['visualize-only'] + '.html',
      function (err) {
        if (err) throw err

        console.log(`generated HTML file is ${argv['visualize-only']}.html`)
      }
    )
  } else {
    tool.collect(argv['--'], function (err, filename) {
      if (err) throw err
      tool.visualize(filename, filename + '.html', function (err) {
        if (err) throw err

        console.log(`generated HTML file is ${filename}.html`)

        // open HTML file in default browser
        open('file://' + path.resolve(filename + '.html'));
      })
    })
  }
}

function printVersion (version) {
  console.log('v' + version)
}

function printHelp (name, version) {
  const filepath = path.resolve(__dirname, 'docs', name + '.txt')

  const usage = fs.readFileSync(filepath)
    .toString()
    .replace(/<title>/g, '\x1B[37m\x1B[1m\x1B[4m')
    .replace(/<\/title>/g, '\x1B[24m\x1B[22m\x1B[39m')
    .replace(/<h1>/g, '\x1B[36m\x1B[1m')
    .replace(/<\/h1>/g, '\x1B[22m\x1B[39m')
    .replace(/<code>/g, '\x1B[33m')
    .replace(/<\/code>/g, '\x1B[39m')
    .replace('{{version}}', version)
  console.log(usage)
}
