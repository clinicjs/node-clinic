
const d3 = require('d3')
const EventEmitter = require('events')

class Menu extends EventEmitter {
  constructor () {
    super()

    this.container = d3.select('#menu')

    this.setupThemeToggle()
    this.setupGridToggle()
  }

  setupGridToggle () {
    this.container.append('div')
      .classed('toggle', true)
      .attr('id', 'toggle-grid')
      .on('click', () => this.emit('toggle-grid'))
  }

  setupThemeToggle () {
    this.container.append('div')
      .classed('toggle', true)
      .attr('id', 'toggle-theme')
      .on('click', () => this.emit('toggle-theme'))
  }
}

module.exports = new Menu()
