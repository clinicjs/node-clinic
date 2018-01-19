'use strict'

const test = require('tap').test
const helpFormatter = require('../lib/help-formatter.js')

test('help formatter', function (t) {
  t.strictEqual(helpFormatter('Title v{{version}}', '1.2.3'), 'Title v1.2.3')
  t.strictEqual(
    helpFormatter('<title>TITLE</title>', '1.0.0'),
    '\x1B[37m\x1B[1m\x1B[4mTITLE\x1B[24m\x1B[22m\x1B[39m'
  )
  t.strictEqual(
    helpFormatter('<h1>HEADER</h1>', '1.0.0'),
    '\x1B[36m\x1B[1mHEADER\x1B[22m\x1B[39m'
  )
  t.strictEqual(
    helpFormatter('<code>CODE</code>', '1.0.0'),
    '\x1B[33mCODE\x1B[39m'
  )
  t.strictEqual(
    helpFormatter('<link>CODE</link>', '1.0.0'),
    '\x1B[4mCODE\x1B[24m'
  )
  t.end()
})
