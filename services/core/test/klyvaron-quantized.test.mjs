import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { artifactAllocation, loadArtifact, readZipEntries, validateManifest, INT8_SCHEME } from '../src/klyvaron/format.mjs'
import { KlyvaronRuntime } from '../src/klyvaron/runtime.mjs'
import { KlyvaronStore } from '../src/klyvaron/store.mjs'
import { AetherisOmniApp } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-int8-parity.json', import.meta.url)))
const original = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-parity.json', import.meta.url)))
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
function artifact(t, change = () => {}, { rehash = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'klyvaron-int8-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const manifest = structuredClone(fixture.manifest)
  const bytes = Buffer.from(fixture.npzBase64, 'base64')
  change(manifest, bytes)
  if (rehash) manifest.weights.sha256 = sha(bytes)
  writeFileSync(join(directory, 'model.klyvaron.json'), JSON.stringify(manifest))
  writeFileSync(join(directory, manifest.weights.file), bytes)
  return directory
}
function dataOffset(npy) { return 10 + npy.readUInt16LE(8) }

test('v2 int8 CPU inference agrees with the independent NumPy reference', (t) => {
  const runtime = KlyvaronRuntime.load(artifact(t))
  for (const c of fixture.cases) {
    const logits = runtime.logits(Int32Array.from(c.ids))
    c.logits.forEach((value, i) => assert.ok(Math.abs(logits[i] - value) < 2e-5, `${c.prompt} logit ${i}`))
    const response = runtime.generate({ prompt: c.prompt, maxNewTokens: c.greedyIds.length })
    assert.deepEqual(response.tokenIds, c.greedyIds)
  }
  assert.equal(runtime.instructionTuned, false)
  assert.equal(runtime.quantization, INT8_SCHEME)
})

test('matrix weights remain int8 in memory before and after inference', (t) => {
  const runtime = KlyvaronRuntime.load(artifact(t))
  const before = [...runtime.params.values()].map((p) => p.data)
  runtime.generate({ prompt: 'Aetheris', maxNewTokens: 3 })
  for (const [i, param] of [...runtime.params.values()].entries()) {
    assert.equal(param.data, before[i], 'no whole-model dequantized copy replaces the weights')
    assert.ok(param.data instanceof (param.shape.length === 2 ? Int8Array : Float32Array))
  }
  assert.equal(runtime.residentWeightBytes, fixture.report.quantizedResidentWeightBytes)
  assert.ok(runtime.residentWeightBytes < fixture.report.sourceResidentWeightBytes / 3)
  assert.ok(artifactAllocation(fixture.manifest).loadBytes < artifactAllocation(original.manifest).loadBytes)
})

test('scales are digest-bound and bad scales fail even when the file is rehashed', (t) => {
  const mutate = (_m, bytes) => {
    const scale = readZipEntries(bytes).get('emb.scale.npy')
    scale.writeFloatLE(0, dataOffset(scale))
  }
  assert.throws(() => loadArtifact(artifact(t, mutate, { rehash: false })), (e) => e.code === 'digest_mismatch')
  for (const value of [0, -1, NaN, Infinity, 1e38]) {
    const dir = artifact(t, (_m, bytes) => {
      const scale = readZipEntries(bytes).get('emb.scale.npy')
      scale.writeFloatLE(value, dataOffset(scale))
    })
    assert.throws(() => loadArtifact(dir), (e) => e.code === 'invalid_quantization')
  }
})

test('unsupported quantization, mixed dtypes and non-finite norms are rejected', (t) => {
  for (const change of [
    (m) => { m.format = 'klyvaron.artifact/1' },
    (m) => { m.weights.quantization.scheme = 'invented-int4' },
    (m) => { delete m.weights.quantization },
    (m) => { m.weights.quantization.scaleDtype = 'float64' },
  ]) {
    const m = structuredClone(fixture.manifest); change(m)
    assert.throws(() => validateManifest(m), (e) => e.code === 'invalid_quantization')
  }
  for (const [name, mutate] of [
    ['emb.npy', (npy) => npy.writeInt8(-128, dataOffset(npy))],
    ['emb.npy', (npy) => npy.write('|u1', npy.indexOf('|i1'), 'ascii')],
    ['lnf_gain.npy', (npy) => npy.writeFloatLE(NaN, dataOffset(npy))],
  ]) {
    assert.throws(() => loadArtifact(artifact(t, (_m, bytes) => mutate(readZipEntries(bytes).get(name)))),
      (e) => ['invalid_quantization', 'unsupported_dtype'].includes(e.code))
  }
})

test('unsafe files, overflowing dimensions and duplicate logical parameters fail before allocation', () => {
  for (const mutate of [
    (m) => { m.weights.file = '../outside.npz' },
    (m) => { m.weights.file = 'C:\\outside.npz' },
    (m) => { m.weights.bytes = -1 },
    (m) => { m.architecture.seq_len = Number.MAX_SAFE_INTEGER },
    (m) => { m.architecture.d_ff = 0 },
    (m) => { m.architecture.n_layers = 1_000_000_000 },
    (m) => { m.weights.names.push('emb') },
  ]) {
    const manifest = structuredClone(fixture.manifest); mutate(manifest)
    assert.throws(() => validateManifest(manifest))
  }
})

test('CPU load memory and archive expansion are checked before heavy allocation', (t) => {
  const directory = artifact(t)
  assert.throws(() => loadArtifact(directory, { availableMemory: () => 0 }), (e) => e.code === 'needs_hardware')
  assert.throws(() => KlyvaronRuntime.load(directory, { availableMemory: () => NaN }), (e) => e.code === 'needs_hardware')
  const oversized = artifact(t, (_m, bytes) => {
    const central = bytes.indexOf(Buffer.from('PK\x01\x02', 'latin1'))
    bytes.writeUInt32LE(0x7fffffff, central + 24)
  })
  assert.throws(() => loadArtifact(oversized), (e) => e.code === 'archive_limit')
})

test('int8 artifacts install and answer locally without acquiring an unsupported tier claim', async (t) => {
  const source = artifact(t)
  const dataDir = mkdtempSync(join(tmpdir(), 'klyvaron-int8-app-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = new KlyvaronStore({ root: join(dataDir, 'klyvaron'), dataDir })
  store.install(source)
  assert.ok(store.verify().every((r) => r.ok))
  const app = new AetherisOmniApp({ config: loadConfig({ AETHERIS_DATA_DIR: dataDir, OLLAMA_ENABLED: 'false', LLAMACPP_ENABLED: 'false' }) })
  t.after(() => app.close())
  const model = app.registry.get(`klyvaron:${fixture.manifest.id}`)
  assert.equal(model.quantization, INT8_SCHEME)
  assert.ok(!model.tags.some((tag) => tag.startsWith('tier:')))
  const response = await app.chat({ model: model.id, prompt: 'Aetheris', maxTokens: 4, executionMode: 'local' })
  assert.ok(response.usage.completionTokens > 0)
  assert.equal(response.sentExternally, false)
  assert.equal(response.routing.execution.scope, 'core_host')
  assert.equal(response.instructionTuned, false)
  const streamed = await app.chat({ model: model.id, prompt: 'Aetheris', maxTokens: 4, executionMode: 'local', stream: true })
  assert.equal(streamed.text, response.text)
  assert.equal(streamed.sentExternally, false)
  await assert.rejects(app.chat({ prompt: 'What is a GPU?' }), (e) => e.code === 'model_not_instruction_tuned')
  const safe = app.providers[model.id].safeDescriptor()
  assert.equal(safe.quantization, INT8_SCHEME)
  assert.equal(safe.residentWeightBytes, fixture.report.quantizedResidentWeightBytes)
})

test('the benchmark CLI records actual CPU work, identity, memory and raw samples without prompts', (t) => {
  const directory = artifact(t)
  const prompt = join(directory, 'benchmark-prompt.txt')
  writeFileSync(prompt, 'Aetheris')
  const script = fileURLToPath(new URL('../scripts/benchmark-klyvaron.mjs', import.meta.url))
  const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', script, directory, prompt, '--iterations', '2', '--tokens', '2'], { encoding: 'utf8' }))
  assert.equal(result.backend, 'cpu')
  assert.equal(result.model.weightsSha256, fixture.manifest.weights.sha256)
  assert.equal(result.model.quantization, INT8_SCHEME)
  assert.equal(result.model.residentWeightPayloadBytes, fixture.report.quantizedResidentWeightBytes)
  assert.equal(result.warm.length, 2)
  assert.ok(result.warm.every((sample) => sample.generatedTokens === 2 && sample.ms > 0 && sample.tokensPerSecond > 0))
  assert.ok(result.memory.maxProcessRssBytes > 0)
  assert.equal(result.memory.explicitGc, true)
  assert.equal(result.workload.promptSha256, sha('Aetheris'))
  assert.ok(!JSON.stringify(result).includes('Aetheris'))
  assert.throws(() => execFileSync(process.execPath, [script, directory, prompt, '--iterations', '0'], { stdio: 'pipe' }))
})
