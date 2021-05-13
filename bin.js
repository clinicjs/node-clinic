#! /usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const url = require('url')
const open = require('open')
const ora = require('ora')
const shellEscape = require('any-shell-escape')
const commist = require('commist')
const minimist = require('minimist')
const subarg = require('subarg')
const dargs = require('dargs')
const execspawn = require('execspawn')
const envString = require('env-string')
const xargv = require('cross-argv')
const crypto = require('crypto')
const Insight = require('insight')
const updateNotifier = require('update-notifier')
const { promisify } = require('util')
const pkg = require('./package.json')
const helpFormatter = require('./lib/help-formatter.js')
const clean = require('./lib/clean.js')

const GA_TRACKING_CODE = 'UA-29381785-8'
const DEFAULT_DEST = '.clinic'

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
  .register('doctor', catchify(async function (argv) {
    const version = require('@nearform/doctor/package.json').version

    const args = subarg(argv, {
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
        open: true,
        debug: false,
        dest: DEFAULT_DEST
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-doctor', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      checkArgs('doctor', args, 'clinic-doctor', version)
      await trackTool('doctor', args, version)
      await runTool('doctor', require('@nearform/doctor'), version, args, { color: 'green' })
    } else {
      printHelp('clinic-doctor', version)
      process.exit(1)
    }
  }))
  .register('bubbleprof', catchify(async function (argv) {
    const version = require('@nearform/bubbleprof/package.json').version

    const args = subarg(argv, {
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
        debug: false,
        dest: DEFAULT_DEST
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-bubbleprof', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      checkArgs('bubbleprof', args, 'clinic-bubbleprof', version)
      await trackTool('bubbleprof', args, version)
      await runTool('bubbleprof', require('@nearform/bubbleprof'), version, args, { color: 'blue' })
    } else {
      printHelp('clinic-bubbleprof', version)
      process.exit(1)
    }
  }))
  .register('flame', catchify(async function (argv) {
    const version = require('@nearform/flame/version')

    const args = subarg(argv, {
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
        debug: false,
        dest: DEFAULT_DEST
      },
      '--': true
    })

    if (args.version) {
      printVersion(version)
    } else if (args.help) {
      printHelp('clinic-flame', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      checkArgs('flame', args, 'clinic-flame', version)
      await trackTool('flame', args, version)
      await runTool('flame', require('@nearform/flame'), version, args, { color: 'yellow' })
    } else {
      printHelp('clinic-flame', version)
      process.exit(1)
    }
  }))
  .register('heapprofiler', catchify(async function (argv) {
    const version = require('node-clinic-heap-profiler/package.json').version

    const args = subarg(argv, {
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
      printHelp('clinic-heap-profiler', version)
    } else if (args['visualize-only'] || args['--'].length > 1) {
      checkArgs('heap-profiler', args, 'clinic-heap-profiler', version)
      await trackTool('heap-profiler', args, version)
      await runTool('heap-profiler', require('node-clinic-heap-profiler'), version, args, { color: 'yellow' })
    } else {
      printHelp('clinic-heap-profiler', version)
      process.exit(1)
    }
  }))
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

function catchify (asyncFn) {
  return function (...args) {
    asyncFn(...args).catch((err) => {
      console.error(err.stack)
      process.exit(1)
    })
  }
}

function checkArgs (toolname, args, help, version) {
  if (args['--'] && args['--'].length >= 1 && !/^node(\.exe)?$/.test(path.basename(args['--'][0]))) {
    console.error(`Clinic.js must be called with a \`node\` command line: \`clinic ${toolname} -- node script.js\`\n`)

    printHelp(help, version)
    process.exit(1)
  }
}

function checkMetricsPermission (cb) {
  /* istanbul ignore if: tracking intentionally disabled when running tests */
  if (insight.optOut === undefined) {
    return promisify(insight.askPermission).call(
      insight,
      'May Clinic.js report anonymous usage statistics to improve the tool over time?'
    )
  }
  return Promise.resolve()
}

async function trackTool (toolName, args, toolVersion) {
  let action = 'run'
  if (args['visualize-only']) {
    action = 'visualize-only'
  } else if (args['collect-only']) {
    action = 'collect-only'
  }

  await checkMetricsPermission()
  insight.track(toolName, action)
  insight.trackEvent({
    category: toolName,
    action,
    label: toolVersion
  })
}

async function runTool (toolName, Tool, version, args, uiOptions) {
  const autocannonOpts = typeof args.autocannon === 'string'
    // --autocannon /url
    ? { _: [args.autocannon] }
    // --autocannon [ /url -m POST --flags... ]
    : args.autocannon
  const autocannonPath = require.resolve('autocannon')

  const onPort = autocannonOpts
    ? `node ${shellEscape(autocannonPath)} ${shellEscape(dargs(autocannonOpts))}`
    : args['on-port']

  if (!onPort && !args['visualize-only']) {
    if (args['collect-only']) {
      console.log('To stop data collection press: Ctrl + C')
    } else {
      console.log('To generate the report press: Ctrl + C')
    }
  }

  const openLocalFile = args.open

  const tool = new Tool({
    sampleInterval: parseInt(args['sample-interval'], 10),
    detectPort: !!onPort,
    dest: args.dest,
    debug: args.debug
  })

  const spinner = ora({
    text: 'Analysing data',
    color: uiOptions.color,
    stream: process.stdout,
    spinner: 'bouncingBar'
  })

  /* istanbul ignore next */
  tool.on('warning', function (warning) {
    console.log('Warning: ' + warning)
  })

  tool.on('port', function (port, proc, cb) {
    process.env.PORT = port
    // inline the PORT env to make it easier for cross platform usage
    execspawn(envString(onPort, { PORT: port }), { stdio: 'inherit' }).on('exit', cb)
  })

  tool.on('analysing', function (message = 'Analysing data') {
    if (spinner.isEnabled) {
      spinner.text = message
      if (!spinner.isSpinning) {
        spinner.start()
      }
    } else {
      console.log(message)
    }
  })
  tool.on('status', status)

  function status (message) {
    if (spinner.isEnabled) {
      spinner.text = message
    } else {
      console.log(message)
    }
  }

  function onsigint () {
    status('Received Ctrl+C, closing process...')
    if (!spinner.isSpinning) spinner.start()
  }

  let defer
  const promise = new Promise((resolve, reject) => {
    defer = { resolve, reject }
  })

  if (args['collect-only']) {
    process.once('SIGINT', onsigint)
    tool.collect(args['--'], function (err, filename) {
      if (err) return defer.reject(err)
      if (spinner.isEnabled) {
        spinner.stop()
        spinner.stream.write(`${spinner.text}\n`)
      }

      defer.resolve({ data: filename })
    })
  } else if (args['visualize-only']) {
    const dataPath = args['visualize-only'].replace(/[\\/]$/, '')
    viz(toolName, dataPath, function (err) {
      if (err) return defer.reject(err)

      defer.resolve({ data: dataPath, visualizer: `${dataPath}.html` })
    })
  } else {
    process.once('SIGINT', onsigint)
    tool.collect(args['--'], function (err, filename) {
      if (err) return defer.reject(err)

      viz(toolName, filename, function (err) {
        if (err) return defer.reject(err)
        if (spinner.isEnabled) {
          spinner.stop()
          spinner.stream.write(`${spinner.text}\n`)
        }

        // open HTML file in default browser
        /* istanbul ignore if: we don't want to open a browser in `npm test` */
        if (openLocalFile) {
          open('file://' + path.resolve(filename + '.html'), { wait: false })
        }

        defer.resolve({ data: filename, visualizer: `${filename}.html` })
      })
    })
  }

  const outputs = await promise

  if (outputs.visualizer) {
    console.log(`Generated HTML file is ${url.pathToFileURL(outputs.visualizer)}`)
  } else {
    console.log(`Output file is ${outputs.data}`)
  }

  // rest is util functions

  function viz (toolName, filename, cb) {
    // Before getting to the tool, make sure the filename exists. We don't care whether is a file or a directory.
    fs.access(filename, function (err) {
      if (err) {
        return cb(new Error('No data found.'))
      }

      const html = filename + '.html'
      tool.visualize(filename, html, function (err) {
        if (err) return cb(err)
        hash(html, function (err, h) {
          /* istanbul ignore next */ if (err) return cb(err)

          const info = {
            tool: toolName,
            toolVersion: version,
            hash: h.toString('hex')
          }

          fs.appendFile(html, `<!-- ${JSON.stringify(info)} -->\n`, cb)
        })
      })
    })
  }
}

function hash (filename, cb) {
  const sha = crypto.createHash('sha512')
  sha.update('clinic\n')
  fs.createReadStream(filename)
    .on('data', data => sha.update(data))
    .on('end', () => cb(null, sha.digest()))
    .on('error', cb)
}

function printVersion (version) {
  console.log('v' + version)
}

function printHelp (name, version) {
  const filepath = path.resolve(__dirname, 'docs', name + '.txt')
  const usage = helpFormatter(fs.readFileSync(filepath), version)
  console.log(usage)
}

function checkForUpdates () {
  updateNotifier({
    pkg
  }).notify({
    isGlobal: true,
    defer: false
  })
}
