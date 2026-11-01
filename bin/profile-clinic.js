#! /usr/bin/env node
'use strict'

const { runCli } = require('../lib/profile-cli.js')

runCli(process.argv.slice(2)).then(code => {
  process.exitCode = code
}).catch(err => {
  process.stderr.write(`profile-clinic: ${err.message}\n`)
  process.exitCode = 1
})
