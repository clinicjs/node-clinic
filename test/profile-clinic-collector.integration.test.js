'use strict'

const test = require('tap').test
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { collectClinicProfiler, PROFILERS } = require('../lib/profile-clinic-collector')

const workload = `
const http = require('node:http')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const retained = []
async function main () {
  const server = http.createServer((request, response) => {
    setTimeout(() => response.end('ok'), 4)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  for (let i = 0; i < 18; i++) {
    retained.push({ index: i, payload: 'clinic-profile-sample-' + i })
    await new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port: address.port, path: '/' }, response => {
        response.resume()
        response.once('end', resolve)
      })
      request.once('error', reject)
    })
    await Promise.resolve().then(() => delay(8))
  }
  await delay(350)
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
main().catch(error => {
  process.stderr.write(String(error && error.stack || error) + '\\n')
  process.exitCode = 1
})
`

test('all Clinic collectors run through the worker and return profiler data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-collector-integration-'))
  t.teardown(() => fs.rm(root, { recursive: true, force: true }))

  for (const profiler of PROFILERS) {
    const cwd = path.join(root, 'workload', profiler)
    const dest = path.join(root, 'artifacts', profiler)
    await fs.mkdir(cwd, { recursive: true })
    await fs.mkdir(dest, { recursive: true })

    let result
    try {
      result = await collectClinicProfiler(profiler, {
        nodePath: process.execPath,
        args: ['-e', workload],
        cwd,
        dest,
        name: `integration-${profiler}`,
        timeoutMs: 15000,
        env: {}
      })
    } catch (error) {
      t.fail(`${profiler} collector failed: ${error.code || 'ERROR'} ${error.message}`)
      continue
    }

    t.equal(result.profiler, profiler, `${profiler} result identifies the selected profiler`)
    t.type(result.profile, 'object', `${profiler} returns analyzed profile data`)
    if (profiler === 'clinic-flame') {
      t.ok(result.profile.sample_count > 0, 'Flame returns samples')
      t.ok(Array.isArray(result.profile.nodes), 'Flame returns call-tree nodes')
    } else if (profiler === 'clinic-doctor') {
      t.type(result.profile.issues, 'object', 'Doctor returns issue analysis')
    } else if (profiler === 'clinic-bubbleprof') {
      t.ok(Array.isArray(result.profile.nodes), 'Bubbleprof returns async clusters')
    } else if (profiler === 'clinic-heapprofiler') {
      t.type(result.profile.data, 'object', 'Heap Profiler returns a heap snapshot tree')
      t.ok(result.profile.node_count > 0, 'Heap Profiler returns analyzed nodes')
    }
  }
})
