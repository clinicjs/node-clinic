'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

function commandOutput (args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 })
  return result.status === 0 ? result.stdout.trim() : null
}

function readRepositoryMetadata (root) {
  const revision = commandOutput(['rev-parse', 'HEAD'], root)
  const status = commandOutput(['status', '--porcelain', '--untracked-files=all'], root)
  const remote = commandOutput(['config', '--get', 'remote.origin.url'], root)
  return {
    revision: status === '' && revision && /^[a-f0-9]{40,64}$/.test(revision) ? revision : null,
    identity: remote ? `sha256-${crypto.createHash('sha256').update(remote).digest('hex')}` : null
  }
}

function hashExecutable (filePath) {
  return new Promise(resolve => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', () => resolve(null))
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(`sha256-${hash.digest('hex')}`))
  })
}

module.exports = { readRepositoryMetadata, hashExecutable }
