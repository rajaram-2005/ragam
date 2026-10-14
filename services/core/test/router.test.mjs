import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelRegistry, ModelRouter, validateModelDescriptor, MODEL_KINDS, MODALITIES, AVAILABILITY } from '../src/router/registry.mjs'

function sampleRegistry() {
  const registry = new ModelRegistry()
  registry.register({
    id: 'ollama:qwen2.5:1.5b',
    kind: MODEL_KINDS.LOCAL_LLM,
    displayName: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
    location: 'local',
    contextWindow: 32768,
    toolCalling: true,
    streaming: true,
    quantization: 'Q4_K_M',
    licence: 'Apache-2.0',
    parametersBillions: 1.5,
    minRamGb: 2,
    costWeight: 1,
  })
  registry.register({
    id: 'gateway:auto',
    kind: MODEL_KINDS.ONLINE_LLM,
    displayName: 'Gateway auto-routed chat',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
    location: 'online',
    provider: 'gateway',
    contextWindow: 128000,
    toolCalling: true,
    streaming: true,
    structuredOutput: true,
    licence: 'provider-terms',
    costWeight: 1.4,
  })
  registry.register({
    id: 'aetheris-lite-retriever-0.1.0',
    kind: MODEL_KINDS.LOCAL_EMBEDDING,
    displayName: 'Aetheris Lite Retriever 0.1.0',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.EMBEDDING_OUT],
    location: 'local',
    licence: 'MIT',
    aetherisLite: true,
    version: '0.1.0',
    minRamGb: 0.2,
    costWeight: 0.5,
  })
  registry.register({
    id: 'gateway:image',
    kind: MODEL_KINDS.ONLINE_IMAGE_GEN,
    displayName: 'Gateway image generation',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.IMAGE_OUT],
    location: 'online',
    provider: 'gateway',
    costWeight: 2,
  })
  registry.register({
    id: 'gateway:video',
    kind: MODEL_KINDS.ONLINE_VIDEO_GEN,
    displayName: 'Gateway video generation',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.VIDEO_OUT],
    location: 'online',
    provider: 'gateway',
    costWeight: 3,
  })
  // Mark everything ready unless a test says otherwise.
  for (const model of registry.list()) registry.observe(model.id, { availability: AVAILABILITY.READY })
  return registry
}

test('descriptor validation rejects incomplete or malformed models', () => {
  assert.throws(() => validateModelDescriptor({ id: 'x' }), /missing required field/)
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: 'magic', displayName: 'd', capabilities: ['text_in'], location: 'local' }), /unknown model kind/)
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'd', capabilities: [], location: 'local' }), /at least one capability/)
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'd', capabilities: ['telepathy'], location: 'local' }), /unknown capability/)
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'd', capabilities: ['text_in'], location: 'cloud' }), /must be 'local' or 'online'/)
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'd', capabilities: ['text_in'], location: 'local', contextWindow: -5 }), /positive integer/)
  // Online models must name a provider so the egress allowlist can be checked.
  assert.throws(() => validateModelDescriptor({ id: 'x', kind: MODEL_KINDS.ONLINE_LLM, displayName: 'd', capabilities: ['text_in'], location: 'online' }), /must declare a provider/)
})

test('duplicate registration is refused', () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'a', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'A', capabilities: ['text_in'], location: 'local' })
  assert.throws(() => registry.register({ id: 'a', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'A2', capabilities: ['text_in'], location: 'local' }), /already registered/)
  registry.upsert({ id: 'a', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'A3', capabilities: ['text_in'], location: 'local' })
  assert.equal(registry.get('a').displayName, 'A3')
})

test('routing is capability-aware, not name-based', () => {
  const registry = sampleRegistry()
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })

  // A chat request under strict_offline must pick the LOCAL model even though the
  // online one advertises a bigger context window and more features.
  const offline = router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT] }, { policy: 'strict_offline' })
  assert.equal(offline.modelId, 'ollama:qwen2.5:1.5b')
  assert.ok(offline.rejected.some((entry) => entry.id === 'gateway:auto' && /strict_offline/.test(entry.reason)))

  // Embedding capability must select the embedding model, never a chat model.
  const embedding = router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.EMBEDDING_OUT] }, { policy: 'strict_offline' })
  assert.equal(embedding.modelId, 'aetheris-lite-retriever-0.1.0')

  // Image and video are distinct capabilities and must not be substituted for each other.
  const image = router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.IMAGE_OUT] }, { policy: 'online_enabled', allowExternal: true })
  const video = router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.VIDEO_OUT] }, { policy: 'online_enabled', allowExternal: true })
  assert.equal(image.modelId, 'gateway:image')
  assert.equal(video.modelId, 'gateway:video')
  assert.notEqual(image.modelId, video.modelId)
})

test('an unsupported capability yields a clear explanation, never a silent substitute', () => {
  const registry = sampleRegistry()
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const result = router.route({ capabilities: [MODALITIES.VIDEO_IN] }, { policy: 'strict_offline' })
  assert.equal(result.satisfied, false)
  assert.equal(result.modelId, null)
  assert.match(result.explanation, /no registered model declares \[video_in\]/)
})

test('hybrid mode requires explicit external authorization', () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'online-only', kind: MODEL_KINDS.ONLINE_LLM, displayName: 'O', capabilities: ['text_in', 'text_out'], location: 'online', provider: 'gateway' })
  registry.observe('online-only', { availability: AVAILABILITY.READY })
  const router = new ModelRouter({ registry })

  const unauthorized = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'hybrid', allowExternal: false })
  assert.equal(unauthorized.satisfied, false)
  assert.match(unauthorized.rejected[0].reason, /external egress not authorized/)

  const authorized = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'hybrid', allowExternal: true })
  assert.equal(authorized.modelId, 'online-only')
})

test('unmeasured availability blocks routing with an honest reason', () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'not-installed', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'N', capabilities: ['text_in', 'text_out'], location: 'local' })
  // Deliberately do NOT observe(): default availability is NOT_INSTALLED.
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const result = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'strict_offline' })
  assert.equal(result.satisfied, false)
  assert.match(result.rejected[0].reason, /runtime or weights not installed locally/)
})

test('each unavailable state produces its own distinct reason', () => {
  const cases = [
    [AVAILABILITY.NEEDS_CREDENTIALS, /credentials not configured/],
    [AVAILABILITY.NEEDS_HARDWARE, /insufficient hardware/],
    [AVAILABILITY.UNREACHABLE, /unreachable at last probe/],
    [AVAILABILITY.DISABLED, /disabled by operator/],
  ]
  for (const [availability, pattern] of cases) {
    const registry = new ModelRegistry()
    registry.register({ id: 'm', kind: MODEL_KINDS.ONLINE_LLM, displayName: 'M', capabilities: ['text_in', 'text_out'], location: 'online', provider: 'gateway' })
    registry.observe('m', { availability })
    const router = new ModelRouter({ registry })
    const result = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'online_enabled', allowExternal: true })
    assert.match(result.rejected[0].reason, pattern, `${availability} should explain itself`)
  }
})

test('hardware profiling excludes models that cannot fit', () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'big', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'Big', capabilities: ['text_in', 'text_out'], location: 'local', minRamGb: 48, minVramGb: 24 })
  registry.register({ id: 'small', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'Small', capabilities: ['text_in', 'text_out'], location: 'local', minRamGb: 2 })
  registry.observe('big', { availability: AVAILABILITY.READY })
  registry.observe('small', { availability: AVAILABILITY.READY })

  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const result = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'strict_offline' })
  assert.equal(result.modelId, 'small')
  assert.match(result.rejected[0].reason, /host has 3.9GB available RAM \/ 0GB/)
})

test('tool-calling and context requirements are enforced', () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'plain', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'P', capabilities: ['text_in', 'text_out'], location: 'local', contextWindow: 4096 })
  registry.register({ id: 'tools', kind: MODEL_KINDS.LOCAL_LLM, displayName: 'T', capabilities: ['text_in', 'text_out'], location: 'local', contextWindow: 32768, toolCalling: true })
  registry.observe('plain', { availability: AVAILABILITY.READY })
  registry.observe('tools', { availability: AVAILABILITY.READY })
  const router = new ModelRouter({ registry, hardware: { ramGb: 8, vramGb: 0 } })

  const needTools = router.route({ capabilities: ['text_in', 'text_out'], toolCalling: true }, { policy: 'strict_offline' })
  assert.equal(needTools.modelId, 'tools')
  assert.match(needTools.rejected[0].reason, /does not support tool calling/)

  const needContext = router.route({ capabilities: ['text_in', 'text_out'], minContext: 16000 }, { policy: 'strict_offline' })
  assert.equal(needContext.modelId, 'tools')
  assert.match(needContext.rejected[0].reason, /context window 4096 < required 16000/)
})

test('a pinned model wins when it passes the same gates', () => {
  const registry = sampleRegistry()
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const result = router.route({ capabilities: ['text_in', 'text_out'], preferId: 'ollama:qwen2.5:1.5b' }, { policy: 'online_enabled', allowExternal: true })
  assert.equal(result.modelId, 'ollama:qwen2.5:1.5b')
  // A pin cannot override policy.
  const blocked = router.route({ capabilities: ['text_in', 'text_out'], preferId: 'gateway:auto' }, { policy: 'strict_offline' })
  assert.equal(blocked.modelId, 'ollama:qwen2.5:1.5b')
})

test('routing decisions are deterministic and reproducible', () => {
  const registry = sampleRegistry()
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const request = { capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT] }
  const first = router.route(request, { policy: 'online_enabled', allowExternal: true })
  const second = router.route(request, { policy: 'online_enabled', allowExternal: true })
  assert.deepEqual(first.candidates, second.candidates)
  assert.equal(first.modelId, second.modelId)
  // No score may be NaN or outside [0,1].
  for (const candidate of first.candidates) {
    assert.ok(candidate.score >= 0 && candidate.score <= 1, `score out of range: ${candidate.score}`)
    for (const value of Object.values(candidate.breakdown)) assert.ok(Number.isFinite(value))
  }
})

test('measured latency improves a model\'s rank', () => {
  const registry = new ModelRegistry()
  const base = { kind: MODEL_KINDS.LOCAL_LLM, displayName: 'M', capabilities: ['text_in', 'text_out'], location: 'local' }
  registry.register({ ...base, id: 'fast' })
  registry.register({ ...base, id: 'slow' })
  registry.observe('fast', { availability: AVAILABILITY.READY, medianLatencyMs: 120 })
  registry.observe('slow', { availability: AVAILABILITY.READY, medianLatencyMs: 3800 })
  const router = new ModelRouter({ registry, hardware: { ramGb: 8, vramGb: 0 } })
  const result = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'strict_offline' })
  assert.equal(result.modelId, 'fast')
})

test('local models are preferred over external ones at equal capability', () => {
  const registry = sampleRegistry()
  const router = new ModelRouter({ registry, hardware: { ramGb: 3.9, vramGb: 0 } })
  const result = router.route({ capabilities: ['text_in', 'text_out'] }, { policy: 'online_enabled', allowExternal: true })
  assert.equal(result.modelId, 'ollama:qwen2.5:1.5b', 'local-first is a policy requirement, not a preference')
  const chosen = result.candidates[0]
  assert.equal(chosen.breakdown.privacy, 1)
})

test('observe() rejects unknown availability values', () => {
  const registry = sampleRegistry()
  assert.throws(() => registry.observe('gateway:auto', { availability: 'feeling_lucky' }), TypeError)
})

test('unknown model lookups throw rather than returning undefined', () => {
  const registry = sampleRegistry()
  assert.throws(() => registry.get('nope'), /unknown model/)
  assert.equal(registry.has('nope'), false)
})
