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
})

loaddata(function maybeDone (err, data) {
  if (err) throw err

  graph.draw(data, { width: window.innerWidth, height: 180 })
  recomendation.draw(data)
})
