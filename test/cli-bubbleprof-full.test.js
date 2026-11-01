'use strict'

const url = require('url')
const fs = require('fs')
const path = require('path')
const async = require('async')
const test = require('tap').test
const cli = require('./cli.js')

test('clinic bubbleprof -- node - no issues', function (t) {
  // collect data
  cli({}, [
    'clinic', 'bubbleprof', '--no-open',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stdout && stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)
    if (err || !match) {
      if (!match) t.fail(`expected Bubbleprof output path; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
      return t.end()
    }
    const dirname = match[1]
    const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

    t.equal(stdout.split('\n')[1], 'Analysing data')
    t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, dirname + '.html'), done)
      }
    }, function (err) {
      t.error(err)
      t.end()
    })
  })
})

test('clinic bubbleprof -- node - bad status code', function (t) {
  // collect data
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--no-open',
    '--', 'node', '-e', 'process.exit(1)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stdout && stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)
    if (err || !match) {
      if (!match) t.fail(`expected Bubbleprof output path; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
      return t.end()
    }
    const dirname = match[1]
    const fullpath = url.pathToFileURL(fs.realpathSync(path.resolve(tempdir, dirname)))

    t.equal(stdout.split('\n')[1], 'Analysing data')
    t.equal(stdout.split('\n')[2], `Generated HTML file is ${fullpath}.html`)

    // check that files exists
    async.parallel({
      sourceData (done) {
        fs.access(path.resolve(tempdir, dirname), done)
      },
      htmlFile (done) {
        fs.access(path.resolve(tempdir, dirname + '.html'), done)
      }
    }, function (err) {
      t.error(err)
      t.end()
    })
  })
})

test('clinic bubbleprof -- node - visualization error', function (t) {
  cli({}, [
    'clinic', 'bubbleprof', '--collect-only',
    '--', 'node', '-e', 'setTimeout(() => {}, 100)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stdout && stdout.match(/(\.clinic[/\\]\d+.clinic-bubbleprof)/)
    if (err || !match) {
      if (!match) t.fail(`expected Bubbleprof data path; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
      return t.end()
    }

    const dirname = match[1]
    const filename = path.basename(dirname) + '-systeminfo'
    fs.unlinkSync(path.join(tempdir, dirname, filename))

    cli({ cwd: tempdir, relayStderr: false }, [
      'clinic', 'bubbleprof', '--visualize-only', path.resolve(tempdir, dirname)
    ], function (err, stdout, stderr) {
      t.strictSame(err, new Error('process exited with exit code 1'))
      t.equal(stdout, '')
      t.ok(stderr.includes('ENOENT: no such file or directory'))
      t.end()
    })
  })
})

test('clinic bubbleprof -- node - configure output destination', function (t) {
  cli({ relayStderr: false }, [
    'clinic', 'bubbleprof', '--no-open',
    '--dest', 'test-bubbleprof-destination',
    '--', 'node', '-e', 'setTimeout(() => {}, 200)'
  ], function (err, stdout, stderr, tempdir) {
    t.error(err)
    const match = stdout && stdout.match(/(\d+.clinic-bubbleprof)/)
    if (err || !match) {
      if (!match) t.fail(`expected Bubbleprof destination path; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`)
      return t.end()
    }
    const basename = match[1]
    t.ok(fs.statSync(path.join(tempdir, 'test-bubbleprof-destination', basename)).isDirectory())
    t.ok(fs.statSync(path.join(tempdir, 'test-bubbleprof-destination', `${basename}.html`)).isFile())
    t.end()
  })
})
