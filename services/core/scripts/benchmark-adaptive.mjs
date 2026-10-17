#!/usr/bin/env node
// Run the adaptive-core benchmark.
//
//   node services/core/scripts/benchmark-adaptive.mjs            # print the report
//   node services/core/scripts/benchmark-adaptive.mjs --write    # also write the committed artefact
//   node services/core/scripts/benchmark-adaptive.mjs --iterations 2000
//
// The artefact is written to docs/experiments/phase10-benchmark.json so the numbers in the release
// notes are reproducible rather than remembered. `--write` is never implied: a benchmark that
// overwrites its own record on every run cannot be compared to anything.

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBenchmarks } from '../src/benchmark/harness.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const write = args.includes('--write')
const iterationsArg = args.indexOf('--iterations')
const iterations = iterationsArg === -1 ? 500 : Number(args[iterationsArg + 1])

const report = await runBenchmarks({ iterations })
const json = JSON.stringify(report, null, 2)

if (write) {
  const target = resolve(REPO, 'docs/experiments/phase10-benchmark.json')
  writeFileSync(target, `${json}\n`)
  console.error(`benchmark written to ${target}`)
}

if (!write) {
  console.log('id                          ops/s        p50 ms   p95 ms')
  for (const entry of report.benchmarks) {
    if (entry.failed) {
      console.log(`${entry.id.padEnd(26)} FAILED  ${entry.error}`)
      continue
    }
    console.log(`${entry.id.padEnd(26)} ${String(entry.opsPerSecond).padStart(10)} ${String(entry.p50Ms).padStart(8)} ${String(entry.p95Ms).padStart(8)}`)
  }
  console.log(`\n${report.environment.node} ${report.environment.platform}/${report.environment.arch}, ${report.environment.cpus} cpus`)
  console.log(report.environment.scope)
}

process.exitCode = report.ok ? 0 : 1
