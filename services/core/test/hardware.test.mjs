import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectHardware, parseNvidiaSmi } from '../src/hardware/detect.mjs'
import { assessProfile, HardwareAdmission, validateProfile } from '../src/hardware/admission.mjs'
import { ModelRegistry, ModelRouter } from '../src/router/registry.mjs'
import { KlyvaronRuntime } from '../src/klyvaron/runtime.mjs'
import { MobileStorageBudget } from '../src/storage/budget.mjs'
import { MobileFootprint } from '../src/klyvaron/footprint.mjs'
import { createEgressGuard } from '../src/policy/egress.mjs'

// Synthetic envelopes exercise boundaries. These are NOT released hardware profiles.
const sha = 'a'.repeat(64), GB = 1024 ** 3
const profile = (tier = 'pro') => ({
  id: tier, modelId: `test:${tier}`, modelVersion: '1', artifactSha256: sha, tier,
  quantization: 'test-int4', workload: 'text', contextTokens: 128,
  runtime: { id: 'test-runtime', version: '1', backend: tier === 'lite' ? 'cpu' : 'cuda' },
  os: ['linux'], arch: ['x64'], instructionSets: ['avx2'],
  ramBytes: GB, storageBytes: 100, gpuMemoryBytes: tier === 'lite' ? [] : [GB],
  computeMetric: 'synthetic-normalized-compute', minComputeScore: tier === 'max' ? 20 : 10, ...(tier === 'max' ? { proProfileId: 'pro' } : {}),
  benchmark: { command: 'test-only --seed 1', report: 'synthetic test fixture', sha256: sha },
})
const profiles = ['lite', 'pro', 'max'].map(profile)
const hardware = () => ({
  scope: 'device', os: 'linux', arch: 'x64', instructionSets: ['avx2'], availableRamBytes: 2 * GB,
  availableStorageBytes: 1000, gpus: [{ id: 'gpu0', name: 'a name is not evidence', backend: 'cuda', totalBytes: 2 * GB, availableBytes: GB }],
  runtimes: ['cpu', 'cuda'].map((backend) => ({ id: 'test-runtime', version: '1', backend,
    configurations: profiles.filter((p) => p.runtime.backend === backend).map((p) => ({ profileId: p.id, artifactSha256: sha, benchmarkSha256: sha, computeMetric: 'synthetic-normalized-compute', computeScore: 30, gpuIds: backend === 'cpu' ? [] : ['gpu0'] })) })),
})
const model = (tier) => ({ id: `test:${tier}`, version: '1', quantization: 'test-int4', tags: [`tier:${tier}`], location: 'local', measured: { availability: 'ready' } })

test('OS measurements and optional GPU probing distinguish unknown from detected', () => {
  const h = detectHardware({ gpuProbe: () => { throw new Error('not installed') } })
  assert.ok(h.totalRamBytes > 0)
  assert.ok(h.availableRamBytes <= h.totalRamBytes)
  assert.ok(h.availableStorageBytes >= 0)
  assert.equal(h.gpuDetected, false)
  assert.deepEqual(h.runtimes, [])
  assert.match(h.warnings.join(' '), /no GPU qualification/)
  assert.equal(h.scope, 'core_host')
  assert.deepEqual(parseNvidiaSmi('GPU-1, actual card, 100, 40'), [{ id: 'GPU-1', name: 'actual card', backend: 'cuda', totalBytes: 100 * 1024 ** 2, availableBytes: 40 * 1024 ** 2 }])
  for (const malformed of ['GPU-1, card, N/A, 5', 'GPU-1, card, 10, 11', 'GPU-1, card, 10, -1']) assert.deepEqual(parseNvidiaSmi(malformed), [])
})

test('Lite qualification is CPU-only; Pro and Max require measured runtime compatibility', () => {
  const h = hardware()
  h.gpus = []
  assert.equal(assessProfile(profile('lite'), h).eligible, true)
  assert.equal(assessProfile(profile('pro'), h).eligible, false)
  assert.equal(assessProfile(profile('max'), hardware(), {}, profiles).eligible, true)
  assert.ok(validateProfile({ ...profile('max'), minComputeScore: 10 }, profiles).length)
  assert.ok(validateProfile({ ...profile('pro'), benchmark: null }).length)
  assert.ok(validateProfile({ ...profile('lite'), runtime: profile('pro').runtime }).length)
})

test('RAM, VRAM, context, OS, instructions, disk, compute and runtime are all admission gates', () => {
  const mutations = [
    (h) => { h.availableRamBytes = GB - 1 }, (h) => { h.availableRamBytes = null },
    (h) => { h.gpus[0].availableBytes = GB - 1 }, (h) => { h.gpus[0].availableBytes = null },
    (h) => { h.availableStorageBytes = 99 }, (h) => { h.os = 'unsupported' },
    (h) => { h.instructionSets = [] }, (h) => { h.runtimes = [] },
    (h) => { h.runtimes[1].configurations[0].computeScore = 9 },
    (h) => { h.runtimes[1].configurations[0].artifactSha256 = 'b'.repeat(64) },
  ]
  for (const mutate of mutations) {
    const h = hardware(); mutate(h)
    assert.equal(assessProfile(profile(), h).eligible, false)
  }
  assert.equal(assessProfile(profile(), hardware(), { contextTokens: 129 }).eligible, false)
  assert.equal(assessProfile(profile(), hardware(), { kind: 'video' }).eligible, false)
  assert.equal(assessProfile(profile(), hardware(), { contextTokens: 128 }).eligible, true)
})

test('multi-GPU memory is never blindly pooled and needs measured benefit', () => {
  const p = { ...profile(), gpuMemoryBytes: [GB, GB] }, h = hardware()
  h.gpus.push({ ...h.gpus[0], id: 'gpu1' })
  const measured = h.runtimes[1].configurations[0]
  assert.equal(assessProfile(p, h).eligible, false)
  measured.gpuIds = ['gpu0', 'gpu1']
  assert.equal(assessProfile(p, h).eligible, false)
  measured.multiGpuSpeedup = 1.3
  assert.equal(assessProfile(p, h).eligible, true)
  measured.gpuIds = ['gpu0', 'gpu0']
  assert.equal(assessProfile(p, h).eligible, false)
})

test('mobile Lite must stay strictly below 5 decimal GB including new assets', () => {
  const h = { ...hardware(), mobile: true, managedStorageBytes: 5_000_000_000 - 100 }
  assert.equal(assessProfile(profile('lite'), h).eligible, false)
  h.managedStorageBytes -= 1
  assert.equal(assessProfile(profile('lite'), h).eligible, true)
  assert.equal(assessProfile(profile('pro'), h).eligible, false)
})

test('recommendation requires installed profiles, and offers explicit lower-resource alternatives', () => {
  const h = hardware(), admission = new HardwareAdmission({ probe: () => h, profiles })
  assert.equal(admission.report(profiles.map((p) => model(p.tier))).recommendedTier, 'max')
  assert.equal(admission.report([]).qualified, false)
  h.gpus[0].availableBytes = 0
  assert.equal(admission.report(profiles.map((p) => model(p.tier))).recommendedTier, 'lite')
  const result = admission.check(model('max'))
  assert.equal(result.eligible, false)
  assert.equal(result.alternatives[0].modelId, 'test:lite')
  assert.equal(result.alternatives[0].requiresConfirmation, true)
  assert.match(result.alternatives[0].tradeoff, /quality/)
  assert.equal(new HardwareAdmission({ probe: () => h }).check(model('max')).eligible, false)
})

function routerFixture() {
  const h = hardware(), registry = new ModelRegistry()
  for (const tier of ['lite', 'pro', 'max']) {
    registry.register({ ...model(tier), displayName: tier, kind: 'local_llm', capabilities: ['text_in', 'text_out'] })
    registry.observe(`test:${tier}`, { availability: 'ready' })
  }
  registry.register({ id: 'remote', displayName: 'remote', provider: 'test', kind: 'online_llm', location: 'online', capabilities: ['text_in', 'text_out'] })
  registry.observe('remote', { availability: 'ready' })
  const admission = new HardwareAdmission({ probe: () => h, profiles })
  return { h, registry, router: new ModelRouter({ registry, admission, refreshHardware: () => h }) }
}

test('routing refreshes resources; a pinned Max cannot bypass memory or silently upload', () => {
  const { h, router } = routerFixture()
  const task = { capabilities: ['text_in', 'text_out'], preferId: 'test:max', executionMode: 'local', workload: { kind: 'text', contextTokens: 128 } }
  assert.equal(router.route({ ...task, preferId: undefined }).modelId, 'test:max', 'default selects highest verified local tier')
  assert.equal(router.route(task).modelId, 'test:max')
  h.gpus[0].availableBytes = 0
  assert.equal(router.route(task, { policy: 'online_enabled', allowExternal: true }).modelId, 'test:lite')
  h.availableRamBytes = 0
  const denied = router.route(task, { policy: 'online_enabled', allowExternal: true })
  assert.equal(denied.satisfied, false)
  assert.equal(denied.retryable, true)
  assert.match(denied.tradeoff, /Keep this task/)
  assert.equal(task.preferId, 'test:max', 'the task is not rewritten')
})

test('local, hybrid and online are distinguishable and strict offline always wins', () => {
  const { router } = routerFixture(), base = { capabilities: ['text_in', 'text_out'], preferId: 'remote' }
  assert.equal(router.route({ ...base, executionMode: 'local' }, { policy: 'online_enabled', allowExternal: true }).chosen.location, 'local')
  assert.equal(router.route({ ...base, executionMode: 'hybrid' }, { policy: 'hybrid', allowExternal: false }).chosen.location, 'local')
  const online = router.route({ ...base, executionMode: 'online' }, { policy: 'hybrid', allowExternal: true })
  assert.equal(online.execution.scope, 'remote_provider')
  assert.equal(online.modelId, 'remote')
  assert.equal(router.route({ ...base, executionMode: 'online' }, { policy: 'strict_offline', allowExternal: true }).satisfied, false)
  for (const executionMode of ['invalid', null, '']) assert.throws(() => router.route({ ...base, executionMode }), /executionMode/)
})

test('strict offline opens no socket to a LAN or allowlisted remote provider', async () => {
  let calls = 0, redirect
  const guard = createEgressGuard({ policy: 'strict_offline', localAllowlist: ['gpu.lan'], onlineAllowlist: ['*'], fetch: async (_url, init) => { calls++; redirect = init.redirect } })
  for (const url of ['http://192.168.1.20/infer', 'http://gpu.lan/infer', 'https://remote.example/infer']) await assert.rejects(guard.fetch(url))
  assert.equal(calls, 0)
  await guard.fetch('http://127.0.0.1/infer', { redirect: 'follow' })
  assert.equal(redirect, 'error', 'redirects cannot bypass the checked host')
})

test('actual CPU inference adapts context and checks memory again during generation', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-parity.json', import.meta.url)))
  const dir = mkdtempSync(join(tmpdir(), 'hardware-cpu-'))
  try {
    writeFileSync(join(dir, 'model.klyvaron.json'), JSON.stringify(fixture.manifest))
    // Reuse the checked-in parity fixture's exact NPZ bytes.
    writeFileSync(join(dir, fixture.manifest.weights.file), Buffer.from(fixture.npzBase64, 'base64'))
    let available = 100 * GB
    const runtime = KlyvaronRuntime.load(dir, { availableMemory: () => available })
    available = runtime.scratchBytes(2)
    const result = runtime.generate({ prompt: 'hello', maxNewTokens: 2 })
    assert.ok(result.generatedTokens > 0)
    assert.ok(result.contextTokens <= 2)
    assert.match(result.resourceAdjustment.tradeoff, /less input/)
    available = 100 * GB
    assert.throws(() => runtime.generate({ prompt: 'hello', maxNewTokens: 2, onToken: () => { available = 0 } }), (e) => e.code === 'needs_hardware')
    assert.throws(() => KlyvaronRuntime.load(dir, { availableMemory: () => 0 }), (e) => e.code === 'needs_hardware')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('managed storage counts the full application directory, without counting models twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hardware-storage-'))
  try {
    const budget = new MobileStorageBudget({ root: join(dir, 'klyvaron'), managedTotalBytes: 100, reserveBytes: 0 })
    mkdirSync(budget.pathFor('modelWeights'), { recursive: true })
    writeFileSync(join(budget.pathFor('modelWeights'), 'model'), 'x'.repeat(20))
    mkdirSync(join(dir, 'media'))
    writeFileSync(join(dir, 'media', 'retained'), 'x'.repeat(80))
    const footprint = new MobileFootprint({ budget, dataDir: dir })
    assert.equal(footprint.report().totalBytes, 100)
    assert.equal(footprint.report().withinBudget, false)
    assert.equal(footprint.report().unmanagedBytes, 80)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
