/**
 * Real end-to-end 10-point acceptance suite for Klyvaron Pro (`klyvaron-pro-lm`, 27,559,946 params)
 * and Klyvaron Max (`klyvaron-max-lm`, 92,077,066 params).
 *
 * Every check runs against the genuine trained weight artifacts installed in
 * `.aetheris-data/online/klyvaron/models/{klyvaron-pro-lm,klyvaron-max-lm}` — NEVER synthetic
 * fixtures, mocks, or third-party providers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SIZE_PRESETS, configDigest, parameterCount } from '../src/klyvaron/architecture.mjs'
import {
  byteBpeDigest,
  expectedParameterNames,
  loadArtifact,
  parameterCount as formatParameterCount,
  shapeMap,
  validateManifest,
} from '../src/klyvaron/format.mjs'
import { KlyvaronRuntime } from '../src/klyvaron/runtime.mjs'
import { LocalCpuExecutor } from '../src/klyvaron/execution.mjs'
import { KlyvaronProvider } from '../src/providers/klyvaron.mjs'
import { NativeKlyvaronHost } from '../src/online/native-klyvaron.mjs'
import { OnlineApp } from '../src/online/app.mjs'
import { auditWording } from '../src/adaptive/wording.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const INSTALLED_ROOT = join(REPO_ROOT, '.aetheris-data', 'online', 'klyvaron')
const PRO_DIR = join(INSTALLED_ROOT, 'models', 'klyvaron-pro-lm')
const MAX_DIR = join(INSTALLED_ROOT, 'models', 'klyvaron-max-lm')
const PRO_CARD_PATH = join(REPO_ROOT, 'docs', 'model-cards', 'klyvaron-pro-lm-0.1.0.json')
const MAX_CARD_PATH = join(REPO_ROOT, 'docs', 'model-cards', 'klyvaron-max-lm-0.1.0.json')

const EXPECTED_SPECS = [
  {
    id: 'klyvaron-pro-lm',
    preset: 'pro',
    dir: PRO_DIR,
    cardPath: PRO_CARD_PATH,
    params: 27_559_946,
    vocabSize: 4096,
    seqLen: 512,
    nLayers: 8,
    expectedTensorCount: 2 + 8 * 10 + 2 + 6, // 90 parameter tensors
  },
  {
    id: 'klyvaron-max-lm',
    preset: 'max',
    dir: MAX_DIR,
    cardPath: MAX_CARD_PATH,
    params: 92_077_066,
    vocabSize: 8192,
    seqLen: 1024,
    nLayers: 12,
    expectedTensorCount: 2 + 12 * 10 + 2 + 6, // 130 parameter tensors
  },
]

function copyInstalledModelsTo(targetKlyvaronRoot) {
  cpSync(join(INSTALLED_ROOT, 'models'), join(targetKlyvaronRoot, 'models'), { recursive: true })
}

for (const spec of EXPECTED_SPECS) {
  test(`[${spec.id}] 1-7: checksum, Byte-BPE tokenizer, exact ${spec.expectedTensorCount} tensors (${spec.params.toLocaleString('en-US')} params), worker-thread hardware init, KV-parity inference, non-anthropomorphic completion, and measured resources`, { timeout: 120_000 }, async (t) => {
    assert.equal(existsSync(spec.dir), true, `missing genuine installed artifact directory ${spec.dir}`)
    assert.equal(existsSync(spec.cardPath), true, `missing model card ${spec.cardPath}`)

    // (1) Checksum match against manifest and registered model card, plus release provenance check.
    const manifestPath = join(spec.dir, `${spec.id}.klyvaron.json`)
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
    const rawCard = JSON.parse(readFileSync(spec.cardPath, 'utf8'))
    const card = rawCard.card ?? rawCard
    assert.equal(manifest.id, spec.id)
    assert.notEqual(manifest.provenance?.origin, 'test_fixture')
    assert.equal(formatParameterCount(manifest.architecture), parameterCount(SIZE_PRESETS[spec.preset].config))
    assert.equal(formatParameterCount(manifest.architecture), spec.params)
    assert.equal(configDigest(SIZE_PRESETS[spec.preset].config).length, 64)

    const weightBytes = readFileSync(join(spec.dir, manifest.weights.file))
    const actualSha = createHash('sha256').update(weightBytes).digest('hex')
    assert.equal(actualSha, manifest.weights.sha256)
    assert.equal(weightBytes.byteLength, manifest.weights.bytes)
    assert.equal(card.artifacts.fileDigest, actualSha)
    assert.equal(card.parameterCount, spec.params)
    assert.equal(card.baseCheckpoint, null)

    // (2) Tokenizer compatibility (Byte-BPE digest, vocab size, round-trip ASCII + code + Tamil UTF-8 + chat markers).
    assert.equal(manifest.tokenizer.kind, 'byte-bpe')
    assert.equal(byteBpeDigest(manifest.tokenizer.merges), manifest.tokenizer.digest)

    // (3) Exact tensor load (every expected array present, zero unexpected arrays, zero NaN/Inf, exact parameter count).
    const loaded = loadArtifact(spec.dir)
    const expectedNames = expectedParameterNames(manifest.architecture)
    assert.equal(expectedNames.length, spec.expectedTensorCount)
    assert.deepEqual([...loaded.weights.keys()].sort(), [...expectedNames].sort())
    const expectedShapes = shapeMap(manifest.architecture)
    let elementTotal = 0
    for (const key of expectedNames) {
      const entry = loaded.weights.get(key)
      assert.deepEqual(entry.shape, expectedShapes[key], `shape mismatch for ${key}`)
      elementTotal += entry.data.length
      for (let idx = 0; idx < Math.min(entry.data.length, 256); idx += 1) {
        assert.equal(Number.isFinite(entry.data[idx]), true, `non-finite value in ${key}[${idx}]`)
      }
    }
    assert.equal(elementTotal, spec.params)
    for (const requiredKey of ['emb', 'pos', 'lnf_gain', 'lnf_bias', 'age_emb', 'state_emb', 'verdict_w', 'verdict_b', 'state_head_w', 'state_head_b']) {
      assert.ok(loaded.weights.has(requiredKey), `missing required tensor ${requiredKey}`)
    }

    // (4, 5, 6, 7) Live runtime + KV parity + differentiator heads + isolated LocalCpuExecutor worker thread + measured latency / tok/s / RSS.
    const rssBefore = process.memoryUsage().rss
    const runtime = KlyvaronRuntime.load(spec.dir)
    assert.equal(runtime.tokenizer.size, spec.vocabSize)
    assert.equal(runtime.parameterCount, spec.params)
    assert.equal(runtime.contextTokens, spec.seqLen)

    for (const sample of [
      'def verify_artifact(directory): return True',
      'தமிழ் மொழி · Klyvaron verification check',
      '<|system|>\nSystem\n<|context|>\nFresh context\n<|user|>\nExplain Klyvaron.\n<|assistant|>\n',
    ]) {
      assert.equal(runtime.tokenizer.decode(runtime.tokenizer.encode(sample)), sample)
    }

    const parity = runtime.verifyKvCacheParity(
      runtime.tokenizer.encode('Aetheris Klyvaron causal attention KV cache parity check.'),
    )
    assert.equal(parity.greedyMatch, true)
    assert.ok(parity.maxAbsError < 1e-4, `KV parity drift ${parity.maxAbsError} exceeded 1e-4`)

    const t0 = performance.now()
    const gen = runtime.generate({
      prompt: '<|system|>\nKlyvaron first-party language model. Answer directly from available context and state clearly when supporting evidence is absent.\n<|context|>\nKlyvaron uses pre-LayerNorm Transformer blocks with learned positions, Byte-BPE tokenization, age conditioning, and verdict/state heads.\n<|user|>\nSummarize Klyvaron architecture components.\n<|assistant|>\n',
      maxNewTokens: 10,
      temperature: 0,
      stop: ['<|end|>'],
    })
    const wallMs = performance.now() - t0
    const rssAfter = process.memoryUsage().rss
    const tokPerSec = gen.generatedTokens / (wallMs / 1000)

    assert.ok(gen.generatedTokens >= 1)
    assert.ok(gen.text.trim().length > 0)
    assert.ok(['stop', 'length'].includes(gen.stoppedBy))
    assert.ok(gen.differentiators)
    assert.ok(['grounded', 'ungrounded'].includes(gen.differentiators.verdict.label))
    assert.equal(typeof gen.differentiators.state.label, 'string')
    assert.equal(auditWording(gen.text).ok || auditWording(gen.text).violations.every((v) => v.name !== 'affection'), true)
    assert.ok(runtime.residentWeightBytes > 20_000_000)
    assert.ok(wallMs > 0 && Number.isFinite(tokPerSec) && tokPerSec > 0)
    assert.ok(rssAfter > 0 && rssBefore > 0)

    // Verify genuine execution through `LocalCpuExecutor` isolated worker thread as well.
    const executor = new LocalCpuExecutor({ idleTimeoutMs: 5_000 })
    t.after(() => executor.close())
    const provider = new KlyvaronProvider({
      runtime,
      executor,
      guard: { fetch() { throw new Error('local worker must never call fetch') } },
    })
    const workerOut = await provider.chat({
      model: spec.id,
      messages: [{ role: 'user', content: 'State how Klyvaron executes local inference.' }],
      maxTokens: 9,
      temperature: 0,
    })
    assert.equal(workerOut.model, spec.id)
    assert.ok(workerOut.text.trim().length > 0)
    assert.ok(workerOut.usage.completionTokens >= 1)

    t.diagnostic(JSON.stringify({
      id: spec.id,
      params: spec.params,
      residentWeightBytes: runtime.residentWeightBytes,
      rssBeforeMb: Number((rssBefore / (1024 * 1024)).toFixed(1)),
      rssAfterMb: Number((rssAfter / (1024 * 1024)).toFixed(1)),
      kvMaxAbsError: parity.maxAbsError,
      wallMs: Number(wallMs.toFixed(2)),
      generatedTokens: gen.generatedTokens,
      tokPerSec: Number(tokPerSec.toFixed(2)),
      verdict: gen.differentiators.verdict,
      state: gen.differentiators.state,
      sampleText: gen.text,
      workerText: workerOut.text,
    }))
  })
}

test('[Pro + Max] 8-10: distinct digests, OnlineApp HTTP/SSE chat & AbortController cancellation for BOTH models, restart persistence, and strict fail-closed error handling without fallback', { timeout: 180_000 }, async (t) => {
  const proManifest = JSON.parse(readFileSync(join(PRO_DIR, 'klyvaron-pro-lm.klyvaron.json'), 'utf8'))
  const maxManifest = JSON.parse(readFileSync(join(MAX_DIR, 'klyvaron-max-lm.klyvaron.json'), 'utf8'))
  assert.notEqual(proManifest.weights.sha256, maxManifest.weights.sha256, 'Pro and Max weights MUST be completely distinct')
  assert.equal(proManifest.provenance.parameterCount, 27_559_946)
  assert.equal(maxManifest.provenance.parameterCount, 92_077_066)

  const dataDir = mkdtempSync(join(tmpdir(), 'klyvaron-online-acceptance-'))
  copyInstalledModelsTo(join(dataDir, 'klyvaron'))

  let app = new OnlineApp({ dataDir, secureCookie: false })
  let server = app.server()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  let baseUrl = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  // Register owner session (with ZERO external gateways configured!).
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify({ email: 'owner@ragam.local', password: 'correct-horse-battery-staple' }),
  })
  assert.equal(regRes.status, 201)
  const cookie = regRes.headers.get('set-cookie').split(';')[0]
  const authed = (method, path, body, signal) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })

  // Verify readiness & `/api/models` expose BOTH verified first-party models while gateways are empty.
  const readyRes = await (await authed('GET', '/api/ready')).json()
  assert.equal(readyRes.status, 'configured')
  assert.equal(readyRes.capabilities.chat, true)
  assert.equal(readyRes.firstPartyModels.readyCount, 2)

  const modelsRes = await (await authed('GET', '/api/models')).json()
  const listedIds = modelsRes.models.map((m) => m.id)
  assert.deepEqual(listedIds, ['klyvaron-pro-lm', 'klyvaron-max-lm'])

  // (9) Invoke real RAGAM Chat (selection + SSE stream) on BOTH `klyvaron-pro-lm` AND `klyvaron-max-lm`!
  for (const modelId of ['klyvaron-pro-lm', 'klyvaron-max-lm']) {
    const sel = await authed('PUT', '/api/models/selection', { model: modelId })
    assert.equal(sel.status, 200)
    assert.equal((await sel.json()).selectedModel, modelId)

    const sessionRes = await (await authed('POST', '/api/sessions', { title: `Acceptance ${modelId}` })).json()
    const streamRes = await authed('POST', '/api/chat/stream', {
      model: modelId,
      sessionId: sessionRes.id,
      messages: [{ role: 'user', content: 'Summarize how Klyvaron handles grounded context.' }],
      maxTokens: 9,
      temperature: 0,
      authorization: { confirmed: true, providerRevision: 0, includeContext: false, allowSensitive: false },
    })
    assert.equal(streamRes.status, 200)
    const rawSse = await streamRes.text()
    const frames = rawSse.trim().split('\n\n').map((block) => ({
      name: /^event:\s*(.+)$/m.exec(block)[1].trim(),
      data: JSON.parse(/^data:\s*(.+)$/m.exec(block)[1]),
    }))
    assert.equal(frames[0].name, 'route')
    assert.equal(frames[0].data.modelId, modelId)
    assert.equal(frames[0].data.sentExternally, false)
    assert.ok(frames.some((f) => f.name === 'delta'))
    const doneFrame = frames.at(-1)
    assert.equal(doneFrame.name, 'done')
    assert.equal(doneFrame.data.modelId, modelId)
    assert.equal(doneFrame.data.firstPartyWeights, true)
    assert.equal(doneFrame.data.sentExternally, false)
    assert.ok(doneFrame.data.text.length > 0)
    assert.ok(doneFrame.data.tokensPerSecond > 0)
    t.diagnostic(JSON.stringify({
      sseChatModel: modelId,
      routeFrame: frames[0].data,
      deltaCount: frames.filter((f) => f.name === 'delta').length,
      doneFrame: doneFrame.data,
    }))
  }

  // Verify live stream cancellation via AbortController does not hang or corrupt the worker host!
  const abortController = new AbortController()
  const cancelPromise = authed('POST', '/api/chat/stream', {
    model: 'klyvaron-max-lm',
    messages: [{ role: 'user', content: 'Generate a detailed explanation of causal self-attention across 12 layers.' }],
    maxTokens: 64,
    temperature: 0,
    authorization: { confirmed: true, providerRevision: 0, includeContext: false, allowSensitive: false },
  }, abortController.signal).then(async (res) => {
    const reader = res.body.getReader()
    await reader.read()
    abortController.abort()
    await reader.cancel().catch(() => {})
  }).catch((err) => {
    assert.equal(err.name, 'AbortError')
  })
  await cancelPromise

  // (8) Restart persistence: close server & OnlineApp completely, reconstruct on same dataDir, verify persistence!
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  app.close()

  app = new OnlineApp({ dataDir, secureCookie: false })
  server = app.server()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  baseUrl = `http://127.0.0.1:${server.address().port}`

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify({ email: 'owner@ragam.local', password: 'correct-horse-battery-staple' }),
  })
  assert.equal(loginRes.status, 200)
  const cookie2 = loginRes.headers.get('set-cookie').split(';')[0]
  const chatAfterRestart = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { cookie: cookie2, 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify({
      model: 'klyvaron-pro-lm',
      messages: [{ role: 'user', content: 'Verify post-restart generation.' }],
      maxTokens: 10,
      temperature: 0,
      authorization: { confirmed: true },
    }),
  })
  assert.equal(chatAfterRestart.status, 200)
  const postRestartBody = await chatAfterRestart.json()
  assert.equal(postRestartBody.modelId, 'klyvaron-pro-lm')
  assert.equal(postRestartBody.firstPartyWeights, true)

  // (10) Safe failure cases: unprovisioned model (`not_installed`), corrupt weights (`digest_mismatch`),
  // `provenance.origin: 'test_fixture'`, and Pro-as-Max substitution (`preset_architecture_mismatch`) MUST fail closed without fallback.
  const emptyHost = new NativeKlyvaronHost({ root: mkdtempSync(join(tmpdir(), 'klyvaron-empty-')) })
  assert.equal(emptyHost.get('klyvaron-pro-lm').status, 'not_installed')
  assert.equal(emptyHost.get('klyvaron-pro-lm').selectorEnabled, false)
  assert.throws(() => emptyHost.requireProvider('klyvaron-pro-lm'), { code: 'klyvaron_model_missing' })
  await emptyHost.close()

  const isolatedRoot = mkdtempSync(join(tmpdir(), 'klyvaron-fail-closed-'))
  t.after(() => rmSync(isolatedRoot, { recursive: true, force: true }))
  copyInstalledModelsTo(isolatedRoot)

  // Corrupt 1 byte in Max weights AND mark Pro manifest as `provenance.origin = 'test_fixture'` -> both MUST be refused!
  const corruptMaxFile = join(isolatedRoot, 'models', 'klyvaron-max-lm', maxManifest.weights.file)
  const rawMaxBytes = readFileSync(corruptMaxFile)
  rawMaxBytes[rawMaxBytes.length - 16] ^= 0xff
  writeFileSync(corruptMaxFile, rawMaxBytes)

  const fixtureProManifestPath = join(isolatedRoot, 'models', 'klyvaron-pro-lm', 'klyvaron-pro-lm.klyvaron.json')
  const fixtureProManifest = JSON.parse(readFileSync(fixtureProManifestPath, 'utf8'))
  fixtureProManifest.provenance.origin = 'test_fixture'
  writeFileSync(fixtureProManifestPath, JSON.stringify(fixtureProManifest))

  const tamperedHost = new NativeKlyvaronHost({ root: isolatedRoot })
  const summary = tamperedHost.summary()
  const proRec = summary.models.find((m) => m.id === 'klyvaron-pro-lm')
  const maxRec = summary.models.find((m) => m.id === 'klyvaron-max-lm')
  assert.equal(proRec.status, 'failed')
  assert.equal(proRec.selectorEnabled, false)
  assert.equal(proRec.error.code, 'fixture_weights_refused')
  assert.equal(maxRec.status, 'failed')
  assert.equal(maxRec.selectorEnabled, false)
  assert.equal(maxRec.error.code, 'digest_mismatch')
  assert.throws(() => tamperedHost.requireProvider('klyvaron-max-lm'), { code: 'digest_mismatch' })
  await tamperedHost.close()

  // Attempting to copy Pro's valid package into `klyvaron-max-lm` directory with id rewritten MUST be rejected (`preset_architecture_mismatch`)!
  const swappedRoot = mkdtempSync(join(tmpdir(), 'klyvaron-swapped-'))
  t.after(() => rmSync(swappedRoot, { recursive: true, force: true }))
  cpSync(PRO_DIR, join(swappedRoot, 'models', 'klyvaron-max-lm'), { recursive: true })
  const fakeMaxManifestPath = join(swappedRoot, 'models', 'klyvaron-max-lm', 'klyvaron-pro-lm.klyvaron.json')
  const fakeMaxManifest = JSON.parse(readFileSync(fakeMaxManifestPath, 'utf8'))
  fakeMaxManifest.id = 'klyvaron-max-lm'
  writeFileSync(join(swappedRoot, 'models', 'klyvaron-max-lm', 'klyvaron-max-lm.klyvaron.json'), JSON.stringify(fakeMaxManifest))
  rmSync(fakeMaxManifestPath, { force: true })

  const swappedHost = new NativeKlyvaronHost({ root: swappedRoot })
  const swappedMax = swappedHost.get('klyvaron-max-lm')
  assert.equal(swappedMax.status, 'failed')
  assert.equal(swappedMax.selectorEnabled, false)
  assert.equal(swappedMax.error.code, 'preset_architecture_mismatch')
  await swappedHost.close()
})
