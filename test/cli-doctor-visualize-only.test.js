'use strict'

const fs = require('fs')
const path = require('path')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic doctor --visualize-only - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'doctor', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.ifError(err)
    t.ok(/Output file is (\d+).clinic-doctor/.test(stdout))
    const dirname = stdout.match(/(\d+.clinic-doctor)/)[1]
    const dirpath = path.resolve(tempdir, dirname)

    // visualize data
    cli({}, [
      'clinic', 'doctor', '--visualize-only', dirpath
    ], function (err, stdout) {
      t.ifError(err)
      t.strictEqual(
        stdout,
        `Generated HTML file is ${dirpath}.html
You can use this command to upload it:
clinic upload ${dirpath}
`)

      // check that HTML file exists
      fs.access(dirpath + '.html', function (err) {
        t.ifError(err)
        t.end()
      })
    })
  })
})

test('clinic doctor --visualize-only - missing data', function (t) {
  const arg = 'missing.clinic-doctor'
  cli({ relayStderr: false }, [
    'clinic', 'doctor', '--visualize-only', arg
  ], function (err, stdout, stderr) {
    t.strictDeepEqual(err, new Error('process exited with exit code 1'))
    t.strictEqual(stdout, '')
    t.ok(stderr.includes(`Unknown argument "${arg}". Pattern: {pid}.clinic-{command}`))
    t.end()
  })
})
