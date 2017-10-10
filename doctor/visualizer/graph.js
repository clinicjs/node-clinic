
const d3 = require('d3')
const EventEmitter = require('events')

// size = {width, height}
const margin = {top: 20, right: 20, bottom: 30, left: 50}

// https://bl.ocks.org/d3noob/402dd382a51a4f6eea487f9a35566de0
class SubGraph extends EventEmitter {
  constructor (container, setup) {
    super()

    this.setup = setup

    // setup graph container
    this.container = container.append('div')
      .classed('graph', true)
      .classed(setup.className, true)

    // Add headline
    this.header = this.container.append('div')
      .classed('header', true)
    this.header.append('span')
      .classed('name', true)
      .text(this.setup.name)
    this.header.append('span')
      .classed('unit', true)
      .text(this.setup.unit)

    // setup graph area
    this.svg = this.container.append('svg')
    this.graph = this.svg.append('g')
        .attr('transform',
              'translate(' + margin.left + ',' + margin.top + ')')

    // add background node
    this.background = this.graph.append('rect')
      .classed('background', true)
      .attr('x', 0)
      .attr('y', 0)

    // define scales
    this.xScale = d3.scaleTime()
    this.yScale = d3.scaleLinear()

    // define axis
    this.xAxis = d3.axisBottom(this.xScale).ticks(10)
    this.xAxisElement = this.graph.append('g')

    this.yAxis = d3.axisLeft(this.yScale).ticks(4)
    this.yAxisElement = this.graph.append('g')

    // Define drawer functions and line elements
    this.lineDrawers = []
    this.lineElements = []
    for (let i = 0; i < this.setup.numLines; i++) {
      const lineDrawer = d3.line()
          .x((d) => this.xScale(d.x))
          .y((d) => this.yScale(d.y[i]))
      this.lineDrawers.push(lineDrawer)

      const lineElement = this.graph.append('path')
          .attr('class', 'line')
      this.lineElements.push(lineElement)
    }
  }

  getGraphSize () {
    const outerSize = this.svg.node().getBoundingClientRect()
    return {
      width: outerSize.width - margin.left - margin.right,
      height: outerSize.height - margin.top - margin.bottom
    }
  }

  data (data) {
    // Update domain of scales
    this.xScale.domain(d3.extent(data, function (d) { return d.x }))

    // For the y-axis, ymin and ymax is supported, however they will
    // never truncate the data.
    let ymin = d3.min(data, function (d) { return Math.min(...d.y) })
    if (this.setup.hasOwnProperty('ymin')) {
      ymin = Math.min(ymin, this.setup.ymin)
    }
    let ymax = d3.max(data, function (d) { return Math.max(...d.y) })
    if (this.setup.hasOwnProperty('ymax')) {
      ymax = Math.max(ymax, this.setup.ymax)
    }
    this.yScale.domain([ymin, ymax])

    // Attach data
    for (let i = 0; i < this.setup.numLines; i++) {
      this.lineElements[i].data([data])
    }
  }

  draw () {
    const { width, height } = this.getGraphSize()

    // add background size
    this.background
      .attr('width', width)
      .attr('height', height)

    // set the ranges
    this.xScale.range([0, width])
    this.yScale.range([height, 0])

    // update axis
    this.xAxisElement
        .attr('transform', 'translate(0,' + height + ')')
        .call(this.xAxis)
    this.yAxisElement
        .call(this.yAxis)

    // update lines
    for (let i = 0; i < this.setup.numLines; i++) {
      this.lineElements[i].attr('d', this.lineDrawers[i])
    }
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
      ymax: 100,
      numLines: 1
    })

    this.memory = new SubGraph(this.container, {
      className: 'memory',
      name: 'Memory Usage',
      unit: 'GB',
      legend: ['RSS', 'Total Heap Allocated', 'Heap Used'],
      ymin: 0,
      numLines: 3
    })

    this.delay = new SubGraph(this.container, {
      className: 'delay',
      name: 'Event Loop Delay',
      unit: 'ms',
      ymin: 0,
      numLines: 1
    })

    this.handles = new SubGraph(this.container, {
      className: 'handles',
      name: 'Alive Handles',
      unit: '',
      ymin: 0,
      numLines: 1
    })
  }

  data (data) {
    this.cpu.data(data.cpu)
    this.memory.data(data.memory)
    this.delay.data(data.delay)
    this.handles.data(data.handles)
  }

  draw () {
    this.cpu.draw()
    this.memory.draw()
    this.delay.draw()
    this.handles.draw()
  }
}

module.exports = new Graph()
