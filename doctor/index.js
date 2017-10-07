'use strict'

const path = require('path')
const { spawn } = require('child_process')
const getSampleFilename = require('./collect/get-sample-filename.js')

class ClinicDoctor {
  collect (args, callback) {
    const samplerPath = path.resolve(__dirname, 'sampler.js')

    // run program, but inject the sampler
    const proc = spawn(args[0], ['-r', samplerPath].concat(args.slice(1)), {
      stdio: 'inherit'
    })

    // relay SIGINT to process
    process.once('SIGINT', () => proc.kill('SIGINT'))

    proc.once('exit', function (code, signal) {
      // the process did not exit normally
      if (code !== 0 && signal !== 'SIGINT') {
        if (code !== null) {
          return callback(new Error(`process exited with exit code ${code}`))
        } else {
          return callback(new Error(`process exited by signal ${signal}`))
        }
      }

      // filename is defined my the child pid
      callback(null, getSampleFilename(proc.pid))
    })
  }

  visualize (filename, callback) {

  }
}

module.exports = ClinicDoctor
