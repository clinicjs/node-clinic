'use strict'

function hrtime2ms (time) {
  return time[0] * 1e3 + time[1] * 1e-6
}

class ProcessState {
  constructor (sampleInterval) {
    if (typeof sampleInterval !== 'number') {
      throw TypeError('sample interval must be a number')
    }

    this.sampleInterval = sampleInterval
    this.refresh()
  }

  _sampleDelay (elapsedTime) {
    // delay can't be negative, so truncate to 0
    return Math.max(0, elapsedTime - this.sampleInterval)
  }

  _sampleCpuUsage (elapsedTime) {
    const elapsedCpuUsage = process.cpuUsage(this._lastSampleCpuUsage)
    // convert to from µs to ms
    const elapsedCpuUsageTotal = (
      elapsedCpuUsage.user + elapsedCpuUsage.system
    ) / 1000

    return elapsedCpuUsageTotal / elapsedTime
  }

  refresh () {
    this._lastSampleTime = process.hrtime()
    this._lastSampleCpuUsage = process.cpuUsage()
  }

  sample () {
    const elapsedTime = hrtime2ms(process.hrtime(this._lastSampleTime))

    return {
      timestamp: Date.now(),
      delay: this._sampleDelay(elapsedTime),
      cpu: this._sampleCpuUsage(elapsedTime),
      memory: process.memoryUsage(),
      handles: process._getActiveHandles().length
    }
  }
}

module.exports = ProcessState
