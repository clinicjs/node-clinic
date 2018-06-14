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
        'upload-url': 'https://upload.clinicjs.org'
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
      runTool(args, require('@nearform/clinic-doctor'), version)
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
      runTool(args, require('@nearform/clinic-bubbleprof'), version)
    } else {
      printHelp('clinic-bubbleprof', version)
      process.exit(1)
    }
  })
  .register('flame', function (argv) {
    const version = require('@nearform/clinic-flame/version')
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
      printHelp('clinic-flame', version)
    } /* istanbul ignore next */ else if (args['visualize-only'] || args['--'].length > 1) {
      /* istanbul ignore next */ runTool(args, require('@nearform/clinic-flame'))
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

function runTool (args, Tool, version) {
  const onPort = args['on-port']

  const tool = new Tool({
    sampleInterval: parseInt(args['sample-interval'], 10),
    detectPort: !!onPort
  })

  tool.on('port', function (port, proc, cb) {
    process.env.PORT = port
    // inline the PORT env to make it easier for cross platform usage
    execspawn(envString(onPort, {PORT: port}), {stdio: 'inherit'}).on('exit', cb)
  })

  if (args['collect-only']) {
    tool.collect(args['--'], function (err, filename) {
      if (err) throw err
      console.log(`output file is ${filename}`)
    })
  } else if (args['visualize-only']) {
    viz(args['visualize-only'], function (err) {
      if (err) throw err

      console.log(`Generated HTML file is ${args['visualize-only']}.html`)
      console.log('You can use this command to upload it:')
      console.log(`clinic upload ${args['visualize-only']}`)
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
        if (args.open) opn('file://' + path.resolve(filename + '.html'), {wait: false})
      })
    })
  }

  function viz (filename, cb) {
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
