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

// on-net-listen relies on the owner property of async_hooks TCP resources.
// Node 24 no longer assigns that property when TCPSERVERWRAP is initialized,
// so Clinic's --on-port preload crashes before it can observe the listening
// event. Observe Server instances directly instead.
const onNetListenPath = path.join(__dirname, '..', 'node_modules', 'on-net-listen', 'index.js')
const onNetListenPackagePath = path.join(__dirname, '..', 'node_modules', 'on-net-listen', 'package.json')
if (fs.existsSync(onNetListenPath) && fs.existsSync(onNetListenPackagePath)) {
  const source = fs.readFileSync(onNetListenPath, 'utf8')
  const version = JSON.parse(fs.readFileSync(onNetListenPackagePath, 'utf8')).version
  const isKnownAsyncHooksImplementation = source.includes("var hooks = require('async_hooks')") &&
    source.includes('resource.owner.once') && source.includes('function oncluster (_, addr)')
  if (version === '1.1.2' && isKnownAsyncHooksImplementation) {
    fs.writeFileSync(onNetListenPath, `'use strict'

const net = require('net')
const events = require('events')
const cluster = require('cluster')

module.exports = onListening

function onListening (onlistening) {
  const e = new events.EventEmitter()
  const originalListen = net.Server.prototype.listen

  function listen (...args) {
    this.once('listening', function () {
      const addr = this.address()
      if (addr) e.emit('listening', addr)
    })
    return originalListen.apply(this, args)
  }

  net.Server.prototype.listen = listen
  cluster.on('listening', oncluster)
  e.destroy = destroy

  if (onlistening) e.on('listening', onlistening)

  return e

  function destroy () {
    if (net.Server.prototype.listen === listen) {
      net.Server.prototype.listen = originalListen
    }
    cluster.removeListener('listening', oncluster)
  }

  function oncluster (_, addr) {
    e.emit('listening', addr)
  }
}
`)
  }
}

// Bubbleprof's --on-port control channel is a pipe, not a TCP socket. Read its
// EOF as a stream so closing the parent's pipe reliably triggers the trace flush.
const bubbleprofRoot = path.join(__dirname, '..', 'node_modules', '@clinic', 'bubbleprof')
const bubbleprofPackagePath = path.join(bubbleprofRoot, 'package.json')
const bubbleprofDetectPortPath = path.join(bubbleprofRoot, 'injects', 'detect-port.js')
if (fs.existsSync(bubbleprofPackagePath) && fs.existsSync(bubbleprofDetectPortPath)) {
  const version = JSON.parse(fs.readFileSync(bubbleprofPackagePath, 'utf8')).version
  const source = fs.readFileSync(bubbleprofDetectPortPath, 'utf8')
  const previousSignal = `function signal (fd, cb) {
  const s = new net.Socket({ fd, readable: true, writable: false })
  s.unref()
  s.on('error', () => {})
  s.on('close', cb)
}`
  if (version === '10.0.0' && (source.includes(previousSignal) || source.includes('autoClose: false'))) {
    const patched = source
      .replace("const net = require('net')\n", '')
      .replace(previousSignal, `function signal (fd, cb) {
  const stream = fs.createReadStream(null, { fd })
  stream.on('error', () => {})
  stream.on('end', cb)
  stream.resume()
}`)
      .replace('fs.createReadStream(null, { fd, autoClose: false })', 'fs.createReadStream(null, { fd })')
    fs.writeFileSync(bubbleprofDetectPortPath, patched)
  }
}
