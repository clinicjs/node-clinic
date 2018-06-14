#! /usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const opn = require('opn')
const async = require('async')
const commist = require('commist')
const minimist = require('minimist')
const execspawn = require('execspawn')
const envString = require('env-string')
const tarAndUpload = require('./lib/tar-and-upload.js')
const helpFormatter = require('./lib/help-formatter.js')
const clean = require('./lib/clean')

const result = commist()
  .register('upload', function (argv) {
    const args = minimist(argv, {
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

    if (args.help) {
      printHelp('clinic-upload')
    } else if (args._.length > 0) {
      async.eachSeries(args._, function (filename, done) {
        // filename may either be .clinic-doctor.html or the data directory
        // .clinic-doctor
        const filePrefix = path.join(filename).replace(/\.html$/, '')
        const htmlFile = path.basename(filename) + '.html'

        console.log(`Uploading data for ${filePrefix} and ${filePrefix}.html`)
        tarAndUpload(
          path.resolve(filePrefix),
          args['upload-url'],
          function (err, reply) {
            if (err) return done(err)
            console.log('The data has been uploaded')
            console.log('Use this link to share it:')
            console.log(`${args['upload-url']}/public/${reply.id}/${htmlFile}`)
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
  .register('clean', function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      }
    })

    if (args.help) {
      printHelp('clinic-clean')
    } else {
      // support --path to support failure testing
      clean(args.path || '.', function (err) {
        if (err) throw err
      })
    }
  })
  .register('doctor', function (argv) {
    const version = require('@nearform/clinic-doctor/package.json').version
    const args = minimist(argv, {
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
        'sample-interval',
        'on-port'
      ],
      default: {
        'sample-interval': '10',
        'open': true
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-doctor', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      runTool(args, require('@nearform/clinic-doctor'))
    } else {
      printHelp('clinic-doctor', version)
      process.exit(1)
    }
  })
  .register('bubbleprof', function (argv) {
    const version = require('@nearform/clinic-bubbleprof/package.json').version
    const args = minimist(argv, {
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
        'visualize-only'
      ],
      default: {
        'open': true
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-bubbleprof', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      runTool(args, require('@nearform/clinic-bubbleprof'))
    } else {
      printHelp('clinic-bubbleprof', version)
      process.exit(1)
    }
  })
  .register('flame', function (argv) {
    const version = require('0x/package.json').version
    const args = minimist(argv, {
      alias: {
        help: 'h',
        version: 'v',
        'output-dir': 'outputDir',
        D: 'outputDir',
        'output-html': 'outputHtml',
        F: 'outputHtml'
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

    /* istanbul ignore else */
    if (!args.name) {
      argv = ['--name', 'clinic-flame', ...argv]
    }
    /* istanbul ignore else */
    if (!args.outputHtml) {
      argv = ['--output-html', '{pid}.{name}.html', ...argv]
    }
    /* istanbul ignore else */
    if (!args.outputDir) {
      argv = ['--output-dir', '{pid}.{name}', ...argv]
    }

    if (args.version) {
      printVersion(version)
    } else if (args['all-options']) {
      require('0x/cmd')(['-h'])
    } else if (args.help) {
      printHelp('clinic-flame', version)
    } /* istanbul ignore next */ else if (args['visualize-only']) {
      require('0x/cmd')(argv)
    } /* istanbul ignore next */ else if (args['collect-only'] && args['--'].length > 1) {
      require('0x/cmd')(argv)
    } /* istanbul ignore next */ else if (args['--'].length > 1) {
      require('0x/cmd')(args.open ? ['-o', ...argv] : argv)
    } else {
      printHelp('clinic-flame', version)
      process.exit(1)
    }
  })
  .parse(process.argv.slice(2))

// not `clinic doctor` and not `clinic bubbleprof`
if (result !== null) {
  const version = require('./package.json').version
  const args = minimist(process.argv.slice(1), {
    alias: {
      help: 'h',
      version: 'v'
    },
    boolean: [
      'help',
      'version'
    ]
  })

  if (args.version) {
    printVersion(version)
  } else if (args.help) {
    printHelp('clinic', version)
  } else {
    printHelp('clinic', version)
    process.exit(1)
  }
}

function runTool (args, Tool) {
  const onPort = args['on-port']

  const tool = new Tool({
    sampleInterval: parseInt(args['sample-interval'], 10),
    detectPort: !!onPort
  })

  tool.on('port', function (port, proc) {
    process.env.PORT = port
    // inline the PORT env to make it easier for cross platform usage
    execspawn(envString(onPort, {PORT: port}), {stdio: 'inherit'})
      .on('exit', () => proc.kill('SIGINT'))
  })

  if (args['collect-only']) {
    tool.collect(args['--'], function (err, filename) {
      if (err) throw err
      console.log(`output file is ${filename}`)
    })
  } else if (args['visualize-only']) {
    tool.visualize(
      args['visualize-only'],
      args['visualize-only'] + '.html',
      function (err) {
        if (err) throw err

        console.log(`generated HTML file is ${args['visualize-only']}.html`)
      }
    )
  } else {
    tool.collect(args['--'], function (err, filename) {
      if (err) throw err
      console.log('analysing data')

      tool.visualize(filename, filename + '.html', function (err) {
        if (err) throw err

        console.log(`generated HTML file is ${filename}.html`)

        // open HTML file in default browser
        /* istanbul ignore if: we don't want to open a browser in `npm test` */
        if (args.open) opn('file://' + path.resolve(filename + '.html'), {wait: false})
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
