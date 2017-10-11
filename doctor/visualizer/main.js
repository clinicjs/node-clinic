'use strict'

const loaddata = require('./data.js')

const menu = require('./menu.js')
const graph = require('./graph.js')
const recomendation = require('./recomendation.js')

menu.on('toggle-theme', function () {
  document.documentElement.classList.toggle('light-theme')
})

menu.on('toggle-grid', function () {
  document.documentElement.classList.toggle('grid-layout')
  graph.draw()
})

graph.on('hover-show', () => graph.hoverShow())
graph.on('hover-hide', () => graph.hoverHide())
graph.on('hover-update', (unitX) => graph.hoverUpdate(unitX))

loaddata(function maybeDone (err, data) {
  if (err) throw err

  graph.setData(data)
  graph.draw()
  recomendation.draw(data)

  window.addEventListener('resize', function () {
    graph.draw()
  })
})
