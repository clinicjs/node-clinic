'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { openInputMount } = require('./profile-input-mounts')

function createSourceRoots (workload, workspaceRoot, declaredInputRoot) {
  const root = path.resolve(workspaceRoot)
  const cwdRelative = workload.cwd.replace(/^\/workspace\/?/, '')
  const cwdRoot = cwdRelative ? path.resolve(root, cwdRelative) : root
  const cwdVirtualRoot = cwdRelative ? `/workspace/${cwdRelative.split(path.sep).join('/')}` : '/workspace'
  const roots = [
    { root: cwdRoot, virtualRoot: cwdVirtualRoot, reportPrefix: cwdRelative.split(path.sep).join('/') },
    { root, virtualRoot: '/workspace', reportPrefix: '', relativePaths: false }
  ]

  for (const mount of workload.input_mounts || []) {
    try {
      const opened = openInputMount(mount, { workspace: root, 'declared-input': declaredInputRoot })
      fs.closeSync(opened.fd)
      roots.push({ root: opened.source, virtualRoot: mount.target, reportPrefix: mount.target.slice(1) })
    } catch {}
  }
  return roots
}

module.exports = { createSourceRoots }
