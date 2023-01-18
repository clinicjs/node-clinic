'use strict'

const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')
const fs = require('fs')

test('clinic doctor throws error when process is forcefully closed before processstat file is generated', { skip: process.version.startsWith('v14')}, function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--no-open',
    '--', 'node', path.join(__dirname, 'forceful-termination.js')
  ], function (err, stdout, stderr, tempdir) {
    console.log(stdout)
    console.log(stderr)
    const dirname = stdout.match(/(\.clinic[/\\]\d+.clinic-doctor)/)[1]
    t.ok(err)
    t.ok(stderr.includes('Process forcefully closed before processstat file generation'))
    t.ok(fs.existsSync(path.resolve(tempdir, dirname + '-processstat')))
    t.end()
  })
})
