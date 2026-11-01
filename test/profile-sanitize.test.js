'use strict'

const test = require('tap').test
const { sanitizeText, sanitizeUntrustedStrings } = require('../lib/profile-sanitize')

test('sanitizes diagnostic paths, credentials, terminal escapes and controls', t => {
  const value = '\u001b[31mfailed\u001b[0m at /home/aras/project/app.js:5 token=secret-value Bearer abc.def\u0000'
  const clean = sanitizeText(value)
  t.equal(clean.includes('\u001b'), false)
  t.equal(clean.includes('/home/aras'), false)
  t.equal(clean.includes('secret-value'), false)
  t.equal(clean.includes('abc.def'), false)
  t.equal(clean.includes('\u0000'), false)
  t.match(clean, /\[PATH\]/)
  t.match(sanitizeText('{"api_key":"private-value"}'), /"api_key":"\[REDACTED\]"/)
  t.end()
})

test('sanitizes strings recursively while preserving response structure', t => {
  const response = { ok: false, data: null, error: { message: 'failed: /tmp/run', retryable: false }, usage: null }
  const sanitized = sanitizeUntrustedStrings(response)
  t.not(sanitized, response)
  t.same(sanitized, { ok: false, data: null, error: { message: 'failed: [PATH]', retryable: false }, usage: null })
  t.same(response.error.message, 'failed: /tmp/run', 'the original response is unchanged')
  t.end()
})
