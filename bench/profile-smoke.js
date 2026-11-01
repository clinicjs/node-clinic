'use strict'

const iterations = Number.parseInt(process.argv[2] || '1', 10)
let checksum = 0
const started = process.hrtime.bigint()
const work = iterations * 5000000
for (let i = 0; i < work; i++) checksum = (checksum + i) % 1000000007
const elapsed = Number(process.hrtime.bigint() - started) / 1e9
process.stdout.write(JSON.stringify({ iterations, work, checksum, throughput: iterations / Math.max(elapsed, 1e-9) }) + '\n')
