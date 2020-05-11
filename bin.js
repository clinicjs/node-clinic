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
const jwt = require('jsonwebtoken')
const Insight = require('insight')
const updateNotifier = require('update-notifier')
const { promisify } = require('util')
const get = promisify(require('simple-get').concat)
const rimraf = require('rimraf')
const pkg = require('./package.json')
const tarAndUpload = require('./lib/tar-and-upload.js')
const helpFormatter = require('./lib/help-formatter.js')
const clean = require('./lib/clean.js')
const authenticate = require('./lib/authenticate.js')
const getAskMessage = require('./lib/get-ask-message.js')
const tarAndUploadPromisified = promisify(tarAndUpload)

const GA_TRACKING_CODE = 'UA-29381785-8'
const DEFAULT_UPLOAD_URL = 'https://upload.clinicjs.org'
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
  .register('user', function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      },
      string: [
        'server'
      ]
    })

    if (args.h) {
      printHelp('clinic-user')
      process.exit(0)
    }

    function printUser (user) {
      if (user) {
        if (user.name) {
          console.log(`Authenticated as ${user.name} (${user.email}).`)
        } else {
          console.log(`Authenticated as ${user.email}.`)
        }
      } else {
        console.log('Not authenticated')
      }
    }

    if (args.server) {
      authenticate.getSession(args.server).then((user) => {
        if (!user) throw new Error('Expired')
        printUser(user)
      }).catch(() => {
        printUser(null)
        process.exit(1)
      })
    } else {
      authenticate.getSessions().then((users) => {
        const urls = Object.keys(users)
        if (urls.length === 0) process.exit(1)
        urls.forEach((url) => {
          console.log(helpFormatter(`<link>${url}</link>`))
          printUser(users[url])
          console.log('')
        })
      }).catch((err) => {
        console.error('Could not list sessions:', err.message)
        process.exit(1)
      })
    }
  })
  .register('login', function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      },
      string: [
        'server'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL
      }
    })

    if (args.h) {
      printHelp('clinic-login')
      process.exit(0)
    }

    authenticate(args.server).then((authToken) => {
      const header = jwt.decode(authToken)
      if (header.name) {
        console.log(`Signed in as ${header.name} (${header.email}).`)
      } else {
        console.log(`Signed in as ${header.email}.`)
      }
    }).catch((err) => {
      console.error('Authentication failure:', err.message)
      process.exit(1)
    })
  })
  .register('logout', function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      },
      string: [
        'server'
      ],
      boolean: [
        'all'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL
      }
    })

    if (args.h) {
      printHelp('clinic-logout')
      process.exit(0)
    }

    if (args.all) {
      authenticate.removeSessions().then(() => {
        console.log('Signed out from all servers')
      }).catch((err) => {
        console.error('Could not sign out:', err.message)
        process.exit(1)
      })
    } else {
      authenticate.logout(args.server).then(() => {
        console.log('Signed out from ', args.server)
      }).catch((err) => {
        console.error('Could not sign out:', err.message)
        process.exit(1)
      })
    }
  })
  .register('upload', catchify(async function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      },
      string: [
        'server'
      ],
      boolean: [
        'help',
        'private',
        'open'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL,
        open: true
      }
    })

    if (args.help) {
      printHelp('clinic-upload')
    } else if (args._.length > 0) {
      await checkMetricsPermission()
      insight.trackEvent({
        category: 'upload',
        action: 'public'
      })

      try {
        await processUpload(args, { private: args.private })
      } catch (err) {
        // message already printed in processUpload
        process.exit(1)
      }
    } else {
      printHelp('clinic-upload')
      process.exit(1)
    }
  }))
  .register('ask', catchify(async function (argv) {
    const args = minimist(argv, {
      alias: {
        help: 'h'
      },
      string: [
        'server'
      ],
      boolean: [
        'help',
        'open'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL,
        open: true
      }
    })

    if (args.help) {
      printHelp('clinic-ask')
    } else if (args._.length > 0) {
      await checkMetricsPermission()
      insight.trackEvent({
        category: 'upload',
        action: 'ask'
      })

      try {
        await processUpload(args, {
          private: true,
          ask: true
        })
      } catch (err) {
        // message already printed in processUpload
        process.exit(1)
      }
    } else {
      printHelp('clinic-ask')
      process.exit(1)
    }
  }))
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
        'upload',
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'server',
        'visualize-only',
        'sample-interval',
        'on-port',
        'dest'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL,
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
      checkArgs(args, 'clinic-doctor', version)
      await trackTool('doctor', args, version)
      await runTool(args, require('@nearform/doctor'), version, { color: 'green' })
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
        'upload',
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'server',
        'visualize-only',
        'dest'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL,
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
      checkArgs(args, 'clinic-bubbleprof', version)
      await trackTool('bubbleprof', args, version)
      await runTool(args, require('@nearform/bubbleprof'), version, { color: 'blue' })
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
        'upload',
        'help',
        'version',
        'collect-only',
        'open',
        'debug'
      ],
      string: [
        'server',
        'visualize-only',
        'dest'
      ],
      default: {
        server: DEFAULT_UPLOAD_URL,
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
      checkArgs(args, 'clinic-flame', version)
      await trackTool('flame', args, version)
      await runTool(args, require('@nearform/flame'), version, { color: 'yellow' })
    } else {
      printHelp('clinic-flame', version)
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

function checkArgs (args, help, version) {
  if (args['--'] && args['--'].length >= 1 && path.basename(args['--'][0]) !== 'node') {
    console.error('Clinic.js must be called with a `node` command line: `clinic doctor -- node script.js`\n')

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

async function runTool (args, Tool, version, uiOptions) {
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

  // Validate usage of on-port flag
  if (args['on-port'] > 0 && onPort) {
    console.log('You must provide on-port with the autocannon config')
    process.exit(0)
  }

  const openLocalFile = args.open && !args.upload

  const tool = new Tool({
    collectDelay: parseInt(args['collect-delay'], 10),
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
    viz(dataPath, function (err) {
      if (err) return defer.reject(err)

      defer.resolve({ data: dataPath, visualizer: `${dataPath}.html` })
    })
  } else {
    process.once('SIGINT', onsigint)
    tool.collect(args['--'], function (err, filename) {
      if (err) return defer.reject(err)

      viz(filename, function (err) {
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

  if (args.upload) {
    console.log(`Uploading result ${outputs.visualizer}...`)
    try {
      await processUpload({
        ...args,
        _: [outputs.data]
      }, { private: true })
    } finally {
      rimraf.sync(outputs.data)
      rimraf.sync(outputs.visualizer)
    }
  } else if (outputs.visualizer) {
    console.log(`Generated HTML file is ${url.pathToFileURL(outputs.visualizer)}`)
    console.log('You can use this command to upload it:')
    console.log(`clinic upload ${outputs.data}`)
  } else {
    console.log(`Output file is ${outputs.data}`)
  }

  if (Tool.name === 'ClinicDoctor' && !args['collect-only'] && !args['visualize-only']) {
    const iss = tool.issue

    const argsArr = args['--']
    argsArr.shift()
    const proc = argsArr.join(' ')

    if (iss !== 'none' && iss !== undefined) {
      console.log(`Doctor detected a potential ${iss} issue.`)
    }
    if (iss === 'event-loop') {
      console.log('To get started with diagnosing the issue run:')
      console.log(`clinic flame --autocannon [ / ] -- node ${proc}`)
    } else if (iss === 'io') {
      console.log('To get started with diagnosing the issue run:')
      console.log(`clinic bubbleprof --autocannon [ / ] -- node ${proc}`)
    } else if (iss === 'data') {
      console.log('Try running the benchmark for a longer time.')
    }
  }

  // rest is util functions

  function viz (filename, cb) {
    if (!/\d+\.clinic-.+$/.test(filename)) {
      return cb(new Error(`Unknown argument "${filename}". Pattern: {pid}.clinic-{command}`))
    }
    const html = filename + '.html'
    const name = filename.match(/clinic-([^-]+)/)[1]
    tool.visualize(filename, html, function (err) {
      if (err) return cb(err)
      hash(html, function (err, h) {
        /* istanbul ignore next */ if (err) return cb(err)

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

async function uploadData (uploadURL, authToken, filename, opts) {
  // filename may either be .clinic-doctor.html or the data directory
  // .clinic-doctor
  const filePrefix = path.join(filename).replace(/\.html$/, '')
  const isPrivate = opts && opts.private

  console.log(`Uploading data for ${filePrefix} and ${filePrefix}.html`)

  const result = await tarAndUploadPromisified(path.resolve(filePrefix), uploadURL, authToken, { private: isPrivate })

  result.url = `${uploadURL}${result.html}`
  return result
}

async function ask (server, filename, upload, token) {
  const dirname = filename.replace(/\.html$/, '')
  const { message, cleanup } = await getAskMessage(dirname)

  const result = await get({
    method: 'POST',
    url: `${server}/ask`,
    headers: { Authorization: `Bearer ${token}` },
    json: true,
    body: { upload, message }
  })

  await cleanup()

  if (result.statusCode !== 200) {
    throw new Error(`Something went wrong, please use the "Ask" button in the web interface at ${server}/profile instead.`)
  }
}

function getError (err) {
  return ['dev', 'development'].includes(process.env.NODE_ENV) ? err.stack : err.message
}

async function processUpload (args, opts = { private: false, ask: false }) {
  try {
    const authToken = await authenticate(args.server, opts)
    const { email } = jwt.decode(authToken)
    console.log(`Signed in as ${email}.`)
    const server = args.server

    const uploadedUrls = []
    for (let i = 0; i < args._.length; i++) {
      const filename = args._[i]
      const htmlFile = `${path.basename(filename).replace('.html', '')}.html`
      const result = await uploadData(server, authToken, filename, opts)
      if (opts.ask) {
        await ask(server, filename, result, authToken)
      }
      uploadedUrls.push(`${server}/${opts.private ? 'private' : 'public'}/${result.id}/${htmlFile}`)
    }

    if (opts && opts.private) {
      console.log('The data has been uploaded to your private area.')
      uploadedUrls.forEach(url => console.log(url))
    } else {
      console.log('The data has been uploaded.')
      if (uploadedUrls.length > 1) {
        console.log('Use these links to share the profiles:')
      } else {
        console.log('Use this link to share it:')
      }
      uploadedUrls.forEach(url => console.log(url))
    }

    if (opts.ask) {
      console.log('')
      console.log('Thanks for contacting NearForm, we will reply as soon as possible.')
    }

    // Open first upload after pause to allow users to read output
    if (args.open && uploadedUrls.length) {
      process.stdout.write('Opening browser...')
      setTimeout(() => {
        process.stdout.clearLine()
        process.stdout.cursorTo(0)
        open(uploadedUrls[0], { wait: false })
      }, 1500)
    }
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(`Connection refused to the Upload Server at ${args.server}.`)
      if (/localhost/.test(args.server)) {
        console.error('Make sure the data server is running.')
      }
    } else if (err.code === 'NoMessage') {
      console.error('Empty message--aborting Ask.')
    } else if (err.reply && err.reply.statusCode === 401 && !opts.retried) {
      console.error('Authentication failure, your token might be expired. Retrying...')
      await authenticate.logout(args.server)
      return processUpload(args, Object.assign({}, opts, { retried: true }))
    } else {
      console.error('Unexpected Error:', getError(err))
    }
    throw err
  }
}
