// Repeatable CPU inference measurements; never converts a test model into a release.
// node --expose-gc services/core/scripts/benchmark-klyvaron.mjs <artifact-dir> <prompt-file> [--iterations 7] [--tokens 16]
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { arch, cpus, platform, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { KlyvaronRuntime } from '../src/klyvaron/runtime.mjs'
import { memorySnapshot } from '../src/hardware/detect.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
try {
  const [directory, promptFile, ...flags] = process.argv.slice(2)
  if (!directory || !promptFile) throw new Error('usage: benchmark-klyvaron.mjs <artifact-dir> <prompt-file> [--iterations N] [--tokens N]')
  const options = { iterations: 7, tokens: 16 }
  for (let i = 0; i < flags.length; i += 2) {
    const name = flags[i].slice(2), value = Number(flags[i + 1])
    if (!['--iterations', '--tokens'].includes(flags[i]) || !Number.isSafeInteger(value) || value < 1 || value > 10000) throw new Error('invalid benchmark option')
    options[name] = value
  }
  const prompt = readFileSync(promptFile, 'utf8')
  if (!prompt.trim()) throw new Error('prompt must not be empty')
  global.gc?.()
  const beforeLoad = process.memoryUsage()
  const started = performance.now()
  const runtime = KlyvaronRuntime.load(directory)
  const loadMs = performance.now() - started
  global.gc?.()
  const afterLoad = process.memoryUsage()
  const run = () => {
    const start = performance.now()
    const result = runtime.generate({ prompt, maxNewTokens: options.tokens, temperature: 0 })
    const ms = performance.now() - start
    return { ms, generatedTokens: result.generatedTokens, contextTokens: result.contextTokens,
      tokensPerSecond: result.generatedTokens * 1000 / ms, stoppedBy: result.stoppedBy,
      adjustment: result.resourceAdjustment }
  }
  const cold = run()
  const warm = Array.from({ length: options.iterations }, run)
  console.log(JSON.stringify({
    format: 'klyvaron.cpu-benchmark/1', measuredAt: new Date().toISOString(),
    backend: 'cpu', model: { id: runtime.manifest.id, version: runtime.manifest.version,
      weightsSha256: runtime.sha256, quantization: runtime.quantization, instructionTuned: runtime.instructionTuned,
      provenance: runtime.manifest.provenance.origin, parameters: runtime.parameterCount,
      architecture: runtime.manifest.architecture, artifactBytes: runtime.manifest.weights.bytes,
      residentWeightPayloadBytes: runtime.residentWeightBytes },
    runtime: { node: process.version, sourceSha256: hash(readFileSync(new URL('../src/klyvaron/runtime.mjs', import.meta.url))),
      loaderSha256: hash(readFileSync(new URL('../src/klyvaron/format.mjs', import.meta.url))) },
    host: { os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, cpuCount: cpus().length, ...memorySnapshot() },
    workload: { promptSha256: hash(prompt), promptCharacters: prompt.length, requestedTokens: options.tokens, iterations: options.iterations },
    loadMs, cold, warm, medianWarmTokensPerSecond: median(warm.map((sample) => sample.tokensPerSecond)),
    memory: { explicitGc: typeof global.gc === 'function', beforeLoad, afterLoad,
      maxProcessRssBytes: process.resourceUsage().maxRSS * 1024 },
    limitation: 'Process RSS includes Node, imports, allocation scratch and runtime overhead. Weight payload bytes are not process RAM. One CPU smoke benchmark is not a minimum-hardware profile, release approval or a general speed claim.',
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ error: error.code ?? 'benchmark_failed', message: error.message }))
  process.exitCode = 1
}
