
const d3 = require('d3')
const EventEmitter = require('events')

// https://bl.ocks.org/d3noob/402dd382a51a4f6eea487f9a35566de0
class SubGraph extends EventEmitter {
  constructor (container, setup) {
    super()

    this.setup = setup

    this.graph = container.append('div')
      .classed('graph', true)
      .classed(setup.className, true)
  }

  draw (data, size) {
    // size = {width, height}
    const margin = {top: 20, right: 20, bottom: 30, left: 50}
    const width = size.width - margin.left - margin.right
    const height = size.height - margin.top - margin.bottom

    // Add headline
    const header = this.graph.append('div')
      .classed('header', true)
    header.append('span')
      .classed('name', true)
      .text(this.setup.name)
    header.append('span')
      .classed('unit', true)
      .text(this.setup.unit)

    // setup content area
    const content = this.graph.append('svg')
      .append('g')
        .attr('transform',
              'translate(' + margin.left + ',' + margin.top + ')')

    // add background node
    content.append('rect')
      .classed('background', true)
      .attr('x', 0)
      .attr('y', 0)
      .attr('width', width)
      .attr('height', height)

    // set the ranges
    const x = d3.scaleTime().range([0, width])
    const y = d3.scaleLinear().range([height, 0])

    // Scale the range of the data
    // For the y-axis, ymin and ymax is supported, however they will
    // never truncate the data.
    x.domain(d3.extent(data, function (d) { return d.x }))

    let ymin = d3.min(data, function (d) { return Math.min(...d.y) })
    if (this.setup.hasOwnProperty('ymin')) {
      ymin = Math.min(ymin, this.setup.ymin)
    }
    let ymax = d3.max(data, function (d) { return Math.max(...d.y) })
    if (this.setup.hasOwnProperty('ymax')) {
      ymax = Math.max(ymax, this.setup.ymax)
    }
    y.domain([ymin, ymax])

    const numLines = data[0].y.length
    for (let i = 0; i < numLines; i++) {
      // define the line
      const valueline = d3.line()
          .x(function (d) { return x(d.x) })
          .y(function (d) { return y(d.y[i]) })

      // Add the valueline path.
      content.append('path')
          .data([data])
          .attr('class', 'line')
          .attr('d', valueline)
    }

    // Add the X Axis
    content.append('g')
        .attr('transform', 'translate(0,' + height + ')')
        .call(d3.axisBottom(x).ticks(10))

    // Add the Y Axis
    content.append('g')
        .call(d3.axisLeft(y).ticks(4))
  }
}

class Graph extends EventEmitter {
  constructor () {
    super()

    this.container = d3.select('#graph')

    this.cpu = new SubGraph(this.container, {
      className: 'cpu',
      name: 'CPU Usage',
      unit: '%',
      ymin: 0,
      ymax: 100
    })

    this.memory = new SubGraph(this.container, {
      className: 'memory',
      name: 'Memory Usage',
      unit: 'GB',
      legend: ['RSS', 'Total Heap Allocated', 'Heap Used'],
      ymin: 0
    })

    this.delay = new SubGraph(this.container, {
      className: 'delay',
      name: 'Event Loop Delay',
      unit: 'ms',
      ymin: 0
    })

    this.handles = new SubGraph(this.container, {
      className: 'handles',
      name: 'Alive Handles',
      unit: '',
      ymin: 0
    })
  }

  draw (data, size) {
    this.cpu.draw(data.cpu, size)
    this.memory.draw(data.memory, size)
    this.delay.draw(data.delay, size)
    this.handles.draw(data.handles, size)
  }
}

module.exports = new Graph()
