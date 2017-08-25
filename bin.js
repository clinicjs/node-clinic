#! /usr/bin/env node

var ansi = require('ansi-escape-sequences')
var spawn = require('child_process').spawn
var minimist = require('minimist')
var path = require('path')

var USAGE = `
  $ ${clr('node-clinic', 'bold')} ${clr('<entry-file>', 'green')} [options]

  Options:

    -h, --help        print usage
    -v, --version     print version

  Examples:

    Debug a node application
    ${clr('$ node-clinic', 'cyan')}

  Running into trouble? Feel free to file an issue:
  ${clr('https://github.com/nearform/node-clinic/issues/new', 'cyan')}

  Do you enjoy using this software? nearForm is hiring!
  ${clr('https://www.nearform.com/careers/', 'cyan')}
`.replace(/\n$/, '').replace(/^\n/, '')

var NOENTRY = `
  Please specify an entry file:
    ${clr('$ node-clinic', 'cyan')} ${clr('<entry-file>', 'green')}

  For example:
    ${clr('$ node-clinic', 'cyan')} ${clr('index.js', 'green')}

  Run ${clr('node-clinic --help', 'cyan')} to see all options.
`.replace(/\n$/, '').replace(/^\n/, '')

var argv = minimist(process.argv.slice(2), {
  alias: {
    help: 'h',
    version: 'v'
  },
  boolean: [
    'help',
    'version'
  ]
})

;(function main (argv) {
  var entry = argv._[0]

  if (argv.help) {
    console.log(USAGE)
  } else if (argv.version) {
    console.log(require('./package.json').version)
  } else if (!entry) {
    console.log(NOENTRY)
    process.exit(1)
  } else {
    var nodeArgs = [ '-r', path.join(__dirname, 'include.js') ]
    var nodeOpts = { stdio: 'inherit' }
    spawn('node', nodeArgs.concat(entry), nodeOpts)
  }
})(argv)

function clr (text, color) {
  return process.stdout.isTTY ? ansi.format(text, color) : text
}
