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
const xargv = require('cross-argv')
const crypto = require('crypto')
const Insight = require('insight')
const updateNotifier = require('update-notifier')
const pkg = require('./package.json')
const tarAndUpload = require('./lib/tar-and-upload.js')
const helpFormatter = require('./lib/help-formatter.js')
const clean = require('./lib/clean')

const GA_TRACKING_CODE = 'UA-29381785-8'

const insight = new Insight({
  trackingCode: GA_TRACKING_CODE,
  pkg
})

/* istanbul ignore else: Always used in tests to avoid polluting data */
if ('NO_INSIGHT' in process.env) {
  Object.defineProperty(insight, 'optOut', {
    get: () => true
  })
}

checkForUpdates()

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
        'upload-url': 'https://upload.clinicjs.org'
      }
    })

    if (args.help) {
      printHelp('clinic-upload')
    } else if (args._.length > 0) {
      checkMetricsPermission(() => {
        insight.trackEvent({
          category: 'upload',
          action: 'public'
        })

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
    const version = require('@nearform/doctor/package.json').version
    const args = minimist(argv, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'visualize-only',
        'sample-interval',
        'on-port',
        'dest'
      ],
      default: {
        'sample-interval': '10',
        'open': true,
        'debug': false
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-doctor', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      trackTool('doctor', args, version, () => {
        runTool(args, require('@nearform/doctor'), version)
      })
    } else {
      printHelp('clinic-doctor', version)
      process.exit(1)
    }
  })
  .register('bubbleprof', function (argv) {
    const version = require('@nearform/bubbleprof/package.json').version
    const args = minimist(argv, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'visualize-only',
        'dest'
      ],
      default: {
        open: true,
        debug: false
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-bubbleprof', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      trackTool('bubbleprof', args, version, () => {
        runTool(args, require('@nearform/bubbleprof'), version)
      })
    } else {
      printHelp('clinic-bubbleprof', version)
      process.exit(1)
    }
  })
  .register('flame', function (argv) {
    const version = require('@nearform/flame/version')
    const args = minimist(argv, {
      alias: {
        help: 'h',
        version: 'v'
      },
      boolean: [
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'visualize-only',
        'dest'
      ],
      default: {
        open: true,
        debug: false
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-flame', version)
    } /* istanbul ignore next */
    else if (args['visualize-only'] || args['--'].length > 1) {
      /* istanbul ignore next */
      trackTool('flame', args, version, () => {
        runTool(args, require('@nearform/flame'))
      })
    } else {
      printHelp('clinic-flame', version)
      process.exit(1)
    }
  })
  .parse(xargv(process.argv.slice(2)))

// not `clinic doctor`, `clinic flame`, and not `clinic bubbleprof`
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

function checkMetricsPermission(cb) {
  /* istanbul ignore if: tracking intentionally disabled when running tests */
  if (insight.optOut === undefined) {
    insight.askPermission(
      'May Clinic report anonymous usage statistics to improve the tool over time?',
      cb
    )
  } else {
    cb()
  }
}

function trackTool(toolName, args, toolVersion, cb) {
  let action = 'run'
  if (args['visualize-only']) {
    action = 'visualize-only'
  } else if (args['collect-only']) {
    action = 'collect-only'
  }

  checkMetricsPermission(() => {
    insight.trackEvent({
      category: toolName,
      action,
      label: toolVersion
    })

    cb()
  })
}

function runTool(args, Tool, version) {
  const onPort = args['on-port']

  if (!onPort && !args['visualize-only']) {
    if (args['collect-only']) {
      console.log('To stop data collection press: Ctrl + C')
    } else {
      console.log('To generate the report press: Ctrl + C')
    }
  }

  const tool = new Tool({
    sampleInterval: parseInt(args['sample-interval'], 10),
    detectPort: !!onPort,
    dest: args.dest,
    debug: args.debug
  })

  /* istanbul ignore next */
  tool.on('warning', function (warning) {
    console.log('Warning: ' + warning)
  })

  tool.on('port', function (port, proc, cb) {
    process.env.PORT = port
    // inline the PORT env to make it easier for cross platform usage
    execspawn(envString(onPort, {
      PORT: port
    }), {
      stdio: 'inherit'
    }).on('exit', cb)
  })

  if (args['collect-only']) {
    tool.collect(args['--'], function (err, filename) {
      if (err) throw err
      console.log(`Output file is ${filename}`)
    })
  } else if (args['visualize-only']) {
    const dataPath = args['visualize-only'].replace(/[\\/]$/, '')
    viz(dataPath, function (err) {
      if (err) throw err

      console.log(`Generated HTML file is ${dataPath}.html`)
      console.log('You can use this command to upload it:')
      console.log(`clinic upload ${dataPath}`)
    })
  } else {
    tool.collect(args['--'], function (err, filename) {
      if (err) throw err
      console.log('Analysing data')

      viz(filename, function (err) {
        if (err) throw err

        console.log(`Generated HTML file is ${filename}.html`)
        console.log('You can use this command to upload it:')
        console.log(`clinic upload ${filename}`)

        // open HTML file in default browser
        /* istanbul ignore if: we don't want to open a browser in `npm test` */
        if (args.open) opn('file://' + path.resolve(filename + '.html'), {
          wait: false
        })
      })
    })
  }

  function viz(filename, cb) {
    if (!/\d+\.clinic-.+$/.test(filename)) {
      return cb(new Error(`Unknown argument "${filename}". Pattern: {pid}.clinic-{command}`))
    }
    const html = filename + '.html'
    const name = filename.match(/clinic-([^-]+)/)[1]
    tool.visualize(filename, html, function (err) {
      if (err) return cb(err)
      hash(html, function (err, h) {
        /* istanbul ignore next */
        if (err) return cb(err)

        const info = {
          tool: name,
          toolVersion: version,
          hash: h.toString('hex')
        }

        fs.appendFile(html, `<!-- ${JSON.stringify(info)} -->\n`, cb)
      })
    })
  }
}

function hash(filename, cb) {
  const sha = crypto.createHash('sha512')
  sha.update('clinic\n')
  fs.createReadStream(filename)
    .on('data', data => sha.update(data))
    .on('end', () => cb(null, sha.digest()))
    .on('error', cb)
}

function printVersion(version) {
  console.log('v' + version)
}

function printHelp(name, version) {
  const filepath = path.resolve(__dirname, 'docs', name + '.txt')
  const usage = helpFormatter(fs.readFileSync(filepath), version)
  console.log(usage)
}

function checkForUpdates() {
  updateNotifier({
    pkg
  }).notify({
    isGlobal: true,
    defer: false
  })
}