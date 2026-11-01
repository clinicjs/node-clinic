'use strict'

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g // eslint-disable-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g // eslint-disable-line no-control-regex
const BIDI_FORMATTING = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const NAMED_CREDENTIAL = /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|authorization)["']?\s*[:=]\s*)(["']?)[^\s,"'}]+/gi
const UNIX_ABSOLUTE_PATH = /(^|[\s("'=])\/(?!\/)(?:[^\s"'<>/]+\/)*[^\s"'<>/]+/g
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:[^\s"'<>\\]+\\)*[^\s"'<>\\]+/g

function sanitizeText (value) {
  return value
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(BIDI_FORMATTING, '')
    .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
    .replace(NAMED_CREDENTIAL, '$1$2[REDACTED]')
    .replace(UNIX_ABSOLUTE_PATH, '$1[PATH]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[PATH]')
}

function sanitizeUntrustedStrings (value, seen = new WeakMap()) {
  if (typeof value === 'string') return sanitizeText(value)
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  const copy = Array.isArray(value) ? [] : {}
  seen.set(value, copy)
  for (const [key, child] of Object.entries(value)) copy[key] = sanitizeUntrustedStrings(child, seen)
  return copy
}

module.exports = { sanitizeText, sanitizeUntrustedStrings }
