#! /usr/bin/env node

var spawn = require('child_process').spawn
var minimist = require('minimist')
var path = require('path')

var argv = minimist(process.argv.slice(2))
var entry = argv._[0]

var nodeArgs = [ '-r', path.join(__dirname, 'include.js') ]
var nodeOpts = { stdio: 'inherit' }
spawn('node', nodeArgs.concat(entry), nodeOpts)
