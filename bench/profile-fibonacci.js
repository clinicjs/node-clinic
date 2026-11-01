'use strict'

function fibonacci (n) {
  if (n < 2) return n
  return fibonacci(n - 1) + fibonacci(n - 2)
}

function run (iterations) {
  const started = process.hrtime.bigint()
  let checksum = 0
  for (let i = 0; i < iterations; i++) checksum += fibonacci(22)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9
  return { iterations, checksum, throughput: iterations / Math.max(elapsed, 1e-9) }
}

if (require.main === module) {
  const iterations = Number.parseInt(process.argv[2] || '1', 10)
  process.stdout.write(JSON.stringify(run(iterations)) + '\n')
}

module.exports = { fibonacci, run }
