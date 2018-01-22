#! /usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const open = require('open')
const async = require('async')
const commist = require('commist')
const minimist = require('minimist')
const tarAndUpload = require('./lib/tar-and-upload.js')
const helpFormatter = require('./lib/help-formatter.js')

const result = commist()
  .register('upload', function (args) {
    const argv = minimist(args, {
      alias: {
        help: 'h'
      },
      string: [
        'upload-url'
      ],
      boolean: [
        'help'
      ],
      default: {
        'upload-url': 'https://clinic-submit.nearform.net'
      }
    })

    if (argv.help) {
      printHelp('clinic-upload')
    } else if (argv._.length > 0) {
      async.eachSeries(argv._, function (filename, done) {
        // filename may either be .clinic-doctor.html or the data directory
        // .clinic-doctor
        const filePrefix = path.join(filename).replace(/\.html$/, '')

        console.log(`Uploading data for ${filePrefix} and ${filePrefix}.html`)
        tarAndUpload(
          path.resolve(filePrefix),
          argv['upload-url'],
          function (err, reply) {
            if (err) return done(err)
            console.log(`The data is stored under the following id: ${reply.id}`)
            done(null)
          }
        )
      }, function (err) {
        if (err) throw err
      })
    } else {
      printHelp('clinic-upload')
      process.exit(1)
    }
  })
  .register('doctor', function (args) {
    const version = require('@nearform/clinic-doctor/package.json').version
    const argv = minimist(args, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only',
        'open'
      ],
      string: [
        'visualize-only',
        'sample-interval'
      ],
      default: {
        'sample-interval': '10',
        'open': true
      },
      '--': true
    })

    if (argv.version) {
      printVersion(version)
    } else if (argv.help) {
      printHelp('clinic-doctor', version)
    } else if (argv['visualize-only'] || argv['--'].length > 1) {
      runTool(argv, require('@nearform/clinic-doctor'))
    } else {
      printHelp('clinic-doctor', version)
      process.exit(1)
    }
  })
  .register('flame', function (args) {
    const version = require('0x/package.json').version
    const argv = minimist(args, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'all-options',
        'open'
      ],
      default: {
        open: true
      },
      '--': true
    })

    if (argv.version) {
      printVersion(version)
    } else if (argv['all-options']) {
      require('0x/cmd')(['-h'])
    } else if (argv.help) {
      printHelp('clinic-flame', version)
    } /* istanbul ignore next */ else if (argv['visualize-only']) {
      require('0x/cmd')(args)
    } /* istanbul ignore next */ else if (argv['collect-only'] && argv['--'].length > 1) {
      require('0x/cmd')(args)
    } /* istanbul ignore next */ else if (argv['--'].length > 1) {
      require('0x/cmd')(argv.open ? ['-o', ...args] : args)
    } else {
      printHelp('clinic-flame', version)
      process.exit(1)
    }
  })
  .parse(process.argv.slice(2))

// not `clinic doctor` and not `clinic upload`
if (result !== null) {
  const version = require('./package.json').version
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
      console.log('analysing data')

      tool.visualize(filename, filename + '.html', function (err) {
        if (err) throw err

        console.log(`generated HTML file is ${filename}.html`)

        // open HTML file in default browser
        /* istanbul ignore if: we don't want to open a browser in `npm test` */
        if (argv.open) open('file://' + path.resolve(filename + '.html'))
      })
    })
  }
}

function printVersion (version) {
  console.log('v' + version)
}

function printHelp (name, version) {
  const filepath = path.resolve(__dirname, 'docs', name + '.txt')
  const usage = helpFormatter(fs.readFileSync(filepath), version)
  console.log(usage)
}
