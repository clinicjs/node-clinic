'use strict'

function helpFormatter (usage, version) {
  return usage
    .toString()
    .replace(/<title>/g, '\x1B[37m\x1B[1m\x1B[4m')
    .replace(/<\/title>/g, '\x1B[24m\x1B[22m\x1B[39m')
    .replace(/<h1>/g, '\x1B[36m\x1B[1m')
    .replace(/<\/h1>/g, '\x1B[22m\x1B[39m')
    .replace(/<code>/g, '\x1B[33m')
    .replace(/<\/code>/g, '\x1B[39m')
    .replace(/<link>/g, '\x1B[4m')
    .replace(/<\/link>/g, '\x1B[24m')
    .replace('{{version}}', version)
}
module.exports = helpFormatter
