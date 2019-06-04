'use strict'

const fs = require('fs')
const os = require('os')
const async = require('async')
const path = require('path')
const { spawn } = require('child_process')
const rimraf = require('rimraf')
const collect = require('stream-collector')

const BIN_PATH = path.resolve(__dirname, '..', 'bin.js')

function cli (settings, args, callback) {
  settings = Object.assign({ relayStderr: true }, settings)

  if (args[0] !== 'clinic') {
    return process.nextTick(
      callback,
      new Error('expected first cli argument to be clinic')
    )
  }

  // replace `-- node` with `-- process.execPath`
  if (args.includes('--')) {
    const seperatorIndex = args.indexOf('--')
    if (args[seperatorIndex + 1] === 'node') {
      args[seperatorIndex + 1] = process.execPath
    }
  }

  if (settings.cwd) ondir(null, settings.cwd)
  else fs.mkdtemp(path.resolve(os.tmpdir(), 'clinic-test-'), ondir)

  function ondir (err, tempdir) {
    if (err) return callback(err)

    const program = spawn(process.execPath, [BIN_PATH, ...args.slice(1)], {
      cwd: tempdir,
      env: Object.assign(
        {},
        process.env,
        settings.env,
        { NO_INSIGHT: '1', NO_UPDATE_NOTIFIER: '1' })
    })
    if (settings.relayStderr) {
      program.stderr.pipe(process.stderr)
    }

    async.parallel({
      stderr (done) {
        collect(program.stderr, function (err, chunks) {
          if (err) return done(err)
          done(null, Buffer.concat(chunks).toString())
        })
      },

      stdout (done) {
        collect(program.stdout, function (err, chunks) {
          if (err) return done(err)
          done(null, Buffer.concat(chunks).toString())
        })
      },

      exit (done) {
        program.once('exit', function (code, signal) {
          if (code === 0 && signal === null) {
            done(null)
          } else if (signal !== null) {
            done(new Error(`process exited by signal ${signal}`))
          } else if (code !== 0) {
            done(new Error(`process exited with exit code ${code}`))
          }
        })
      }
    }, function (err, result) {
      process.once('exit', () => {
        rimraf.sync(tempdir)
      })

      callback(err,
        result ? result.stdout : null,
        result ? result.stderr : null,
        tempdir)
    })
  }
}

module.exports = cli
