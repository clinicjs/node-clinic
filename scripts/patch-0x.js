'use strict'

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', 'node_modules', '0x')

function replaceFile (relative, replacements) {
  const file = path.join(root, relative)
  if (!fs.existsSync(file)) return
  const source = fs.readFileSync(file, 'utf8')
  let patched = source
  for (const [from, to] of replacements) patched = patched.replace(from, to)
  if (patched !== source) fs.writeFileSync(file, patched)
}

replaceFile('lib/preload/redir-stdout.js', [
  ["const net = require('net')", "const fs = require('fs')"],
  ['const socket = new net.Socket({\n    fd: 3,\n    readable: false,\n    writable: true\n  })', 'const stdout = fs.createWriteStream(null, {\n    fd: 3,\n    autoClose: false\n  })'],
  ['get: () => socket', 'get: () => stdout'],
  ['value: socket._handle.fd', 'value: 3']
])

replaceFile('lib/random-require.js', [
  ["      regExpStr += '$'", "      regExpStr = regExpStr ? regExpStr + '$' : '$^'"]
])

replaceFile('lib/ticks-to-tree.js', [
  ["  const stackRegExpStr = stackChild.stdout.toString()\n  if (!stackRegExpStr) {\n    throw new Error('0x/lib/random-require.js returned an empty RegExp string. This may be ' +\n    'because of interference in the child process. One known cause is Tap tests with coverage enabled on Node 8.')\n  }", "  const stackRegExpStr = stackChild.stdout.toString() || '$^'"]
])

replaceFile('lib/v8-log-to-ticks.js', [
  ["const { spawn } = require('child_process')", "const { spawn, spawnSync } = require('child_process')"],
  [/async function wrapper \(isolateLogPath, options\) \{[\s\S]*?\n\}\n\n\/\/ 1\./, `async function wrapper (isolateLogPath, options) {
  const normalised = await prepareForPreprocess(isolateLogPath)
  const jsonPath = normalised + '.json'
  const preprocessPath = normalised + '.log'
  await fs.promises.copyFile(normalised, preprocessPath)
  const outputFd = fs.openSync(jsonPath, 'w')
  const result = spawnSync(options.pathToNodeBinary, ['--prof-process', '--preprocess', preprocessPath], {
    stdio: ['ignore', outputFd, 'pipe']
  })
  fs.closeSync(outputFd)
  if (result.error || result.status !== 0) throw result.error || Error('v8 log conversion failed')
  return v8LogToTicks(jsonPath, options)
}

// 1.`]
])
