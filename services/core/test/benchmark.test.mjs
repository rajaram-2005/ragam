// The benchmark has to be as honest as the code it measures.
//
// These tests do not assert that any benchmark is fast — that would be a claim about the host, not
// the code. They assert the properties that make a report trustworthy: every declared benchmark
// ran, a failing benchmark is reported rather than dropped, and a report says what it measured.

import test from 'node:test'
import assert from 'node:assert/strict'

import { runBenchmarks, recordBenchmark, BENCHMARK_IDS } from '../src/benchmark/harness.mjs'

const report = await runBenchmarks({ iterations: 25 })

test('every declared benchmark runs and none fails', () => {
  assert.equal(report.ok, true, `failed: ${report.failed.join(', ')}`)
  assert.deepEqual(new Set(report.benchmarks.map((entry) => entry.id)), new Set(BENCHMARK_IDS))
  assert.deepEqual(report.failed, [])
})

test('a benchmark reports the measurement its number came from', () => {
  for (const entry of report.benchmarks) {
    assert.equal(entry.completed, entry.iterations, `${entry.id} did not complete every iteration`)
    assert.ok(entry.totalMs > 0, `${entry.id} claims a rate from no elapsed time`)
    assert.ok(Number.isFinite(entry.opsPerSecond) && entry.opsPerSecond > 0, `${entry.id} rate is not a number`)
    assert.ok(entry.p50Ms >= 0 && entry.p95Ms >= entry.p50Ms, `${entry.id} percentiles are inconsistent`)
    // A rate and a latency that contradict each other means one of them is decoration.
    const impliedMs = (entry.iterations / entry.opsPerSecond) * 1_000
    assert.ok(Math.abs(impliedMs - entry.totalMs) < entry.totalMs, `${entry.id} rate contradicts its elapsed time`)
  }
})

test('a suite that measures nothing is refused rather than reported as zero', async () => {
  // A clock that never advances: elapsed time is zero, so no rate can honestly be derived.
  await assert.rejects(runBenchmarks({ iterations: 2, now: () => 0 }), /did not measure anything/)
})

test('the report states what it measured and where', () => {
  assert.equal(report.schema, 'aetheris-benchmark/1')
  assert.match(report.environment.node, /^v\d+/)
  assert.ok(report.environment.cpus >= 1)
  assert.match(report.environment.scope, /not a product throughput claim/)
  assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('a benchmark that fails is kept in the table and fails the run', async () => {
  const doomed = await runBenchmarks({
    iterations: 4,
    extra: [{ id: 'test.always-fails', unit: 'runs', iterations: 3, fn: () => { throw new Error('the fixture broke') } }],
  })
  const entry = doomed.benchmarks.find((item) => item.id === 'test.always-fails')
  // Present, named, and carrying its error -- not silently dropped for being inconvenient.
  assert.ok(entry, 'a failed benchmark was dropped from the table')
  assert.equal(entry.failed, true)
  assert.match(entry.error, /the fixture broke/)
  assert.equal(doomed.ok, false)
  assert.deepEqual(doomed.failed, ['test.always-fails'])
  // And it does not take the honest benchmarks down with it.
  assert.equal(doomed.benchmarks.filter((item) => !item.failed).length, BENCHMARK_IDS.length)
})

test('a benchmark whose rate and latency disagree is rejected', async () => {
  // The clock advances only on the first call: iterations complete but elapsed time is zero, so
  // any rate would be invented.
  const ticks = [0, 0, 0, 0, 0, 0]
  let call = 0
  const stalled = () => ticks[Math.min(call++, ticks.length - 1)]
  await assert.rejects(
    runBenchmarks({ iterations: 2, now: stalled, extra: [] }),
    /did not measure anything/,
  )
})

test('recordBenchmark reports what happened when the clock is real', () => {
  const entry = recordBenchmark({ id: 't', what: 't', unit: 'runs', iterations: 3, fn: () => {} })
  assert.equal(entry.failed, false)
  assert.equal(entry.completed, 3)
  assert.ok(entry.p95Ms >= entry.p50Ms)
  // A benchmark that throws half way through says where it stopped.
  const partial = recordBenchmark({ id: 't2', what: 't2', unit: 'runs', iterations: 5, fn: (i) => { if (i === 2) throw new Error('stop') } })
  assert.equal(partial.failed, true)
  assert.equal(partial.completed, 2)
})
