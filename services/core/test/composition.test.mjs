// The training-free path: a tier composed at run time from a pinned third-party base, the user's
// own accelerator and this repository's mechanisms -- and the arithmetic that decides whether it
// fits. Every test here is one of the rules in accelerators.mjs and composition.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCELERATORS, ACCELERATOR_IDS, eligibleAccelerators, envelope, kvCacheBytes, placementFor, weightBytes,
} from '../src/hardware/accelerators.mjs'
import {
  BACKING_PATHS, COMPOSITION_STEP_IDS, LICENCES_ALLOWED, STEP_STATES, backingPathGates, backingPathViolations,
  compositionPlan, formatComposition,
} from '../src/klyvaron/composition.mjs'
import { KLYVARON, TIERS, ownedArtifacts, tierClaimFor, tierClaimForArtifact, validateFamily } from '../src/klyvaron/tiers.mjs'
import { developmentPlan, GATES, GATE_STATES } from '../src/klyvaron/plan.mjs'

// A 0.5B-parameter base with grouped-query attention: 24 layers, 4 KV heads, head dim 128.
const BASE = {
  id: 'third-party/small-instruct', revision: '7ae557604adf67be50417f59c2c2f167def9a775',
  weightsSha256: 'a'.repeat(64), licence: 'Apache-2.0', parameters: 494_032_768,
  layers: 24, kvHeads: 4, headDim: 128, maxContextTokens: 32768,
}
const cudaDevice = (freeBytes = 24 * 1000 ** 3) => ({
  os: 'linux', arch: 'x64', availableRamBytes: 32 * 1000 ** 3,
  gpus: [{ id: 'GPU-1', name: 'Fake RTX', backend: 'cuda', totalBytes: freeBytes, availableBytes: freeBytes }],
  runtimes: [],
})
const idMap = (plan) => Object.fromEntries(plan.tiers.map((t) => [t.id, t]))
const gateOf = (tier, id) => tier.gates.find((g) => g.id === id)
const stepOf = (plan, id) => plan.steps.find((s) => s.id === id)

test('weight and KV-cache arithmetic are computed, not estimated', () => {
  assert.equal(weightBytes({ parameters: 500_000_000, bitsPerWeight: 16 }), 1_000_000_000)
  assert.equal(weightBytes({ parameters: 500_000_000, bitsPerWeight: 4 }), 250_000_000)
  assert.throws(() => weightBytes({ parameters: 0 }), /positive integer/)
  assert.throws(() => weightBytes({ parameters: 100, bitsPerWeight: 12 }), /unsupported bitsPerWeight/)

  // 2 (K and V) x 24 layers x 4 KV heads x 128 head dim x 32768 tokens x 2 bytes.
  assert.equal(kvCacheBytes({ layers: 24, kvHeads: 4, headDim: 128, contextTokens: 32768 }), 1_610_612_736)
  // Grouped-query attention is the reason this takes kvHeads: using the attention head count
  // would claim 8x the memory and refuse a card that would have run the model.
  assert.equal(kvCacheBytes({ layers: 24, kvHeads: 32, headDim: 128, contextTokens: 32768 }) / 1_610_612_736, 8)
  assert.throws(() => kvCacheBytes({ layers: 24, kvHeads: 0, headDim: 128, contextTokens: 4096 }), /kvHeads/)

  const total = envelope({ parameters: 494_032_768, bitsPerWeight: 4, layers: 24, kvHeads: 4, headDim: 128, contextTokens: 8192 })
  assert.equal(total.totalBytes, total.weightsBytes + total.kvBytes)
})

test('an accelerator is a candidate until a probe confirms it', () => {
  // A confirmed one comes from the device probe, memory and all.
  const confirmed = eligibleAccelerators(cudaDevice())
  assert.equal(confirmed.confirmed.length, 1)
  assert.equal(confirmed.confirmed[0].accelerator, 'cuda')
  assert.equal(confirmed.confirmed[0].availableBytes, 24 * 1000 ** 3)

  // An Apple laptop with no runtime probe is a *candidate*: Metal is what you would install,
  // and nothing here may treat an OS and an architecture as a working runtime.
  const apple = eligibleAccelerators({ os: 'darwin', arch: 'arm64', gpus: [], runtimes: [] })
  assert.deepEqual(apple.confirmed, [])
  assert.deepEqual(apple.candidates.map((c) => c.accelerator), ['metal'])
  assert.match(apple.candidates[0].probe, /mps/)

  // An Intel machine is offered its NPU and GPU probes, again unconfirmed.
  const intel = eligibleAccelerators({ os: 'linux', arch: 'x64' })
  assert.deepEqual(intel.candidates.map((c) => c.accelerator), ['openvino-npu', 'openvino-gpu'])
  assert.equal(intel.cpuAvailable, true)

  // A runtime probe that names the backend is confirmation even without a GPU listing.
  const viaRuntime = eligibleAccelerators({ os: 'linux', arch: 'x64', gpus: [], runtimes: [{ id: 'ollama', backend: 'rocm' }] })
  assert.deepEqual(viaRuntime.confirmed.map((c) => c.accelerator), ['rocm'])
  assert.equal(ACCELERATOR_IDS.length, Object.keys(ACCELERATORS).length)
})

test('placement does the arithmetic and refuses with the numbers', () => {
  const model = { parameters: BASE.parameters, layers: BASE.layers, kvHeads: BASE.kvHeads, headDim: BASE.headDim, maxContextTokens: BASE.maxContextTokens }

  // Fits on an 8 GB card at int4 and 16k context.
  const fits = placementFor({ device: cudaDevice(8 * 1000 ** 3), model, contextTokens: 16384, requiresAccelerator: true, bitsPerWeight: 4 })
  assert.equal(fits.eligible, true)
  assert.equal(fits.accelerator, 'cuda')
  assert.match(fits.runtime, /llama\.cpp/)
  assert.ok(fits.envelope.totalBytes < 8 * 1000 ** 3)

  // The same model on a 1 GB card is refused, and the refusal is actionable.
  const tooSmall = placementFor({ device: cudaDevice(1 * 1000 ** 3), model, contextTokens: 16384, requiresAccelerator: true, bitsPerWeight: 4 })
  assert.equal(tooSmall.eligible, false)
  assert.match(tooSmall.reasons.join(' '), /has 1000000000 bytes available/)
  assert.match(tooSmall.reasons.join(' '), /reduce the context, quantise further, or use a smaller model/)

  // Unknown free memory is a refusal, not an optimistic assumption.
  const unknown = placementFor({ device: { os: 'linux', arch: 'x64', gpus: [{ id: 'g', backend: 'cuda', totalBytes: 8 * 1000 ** 3 }], runtimes: [] }, model, contextTokens: 4096 })
  assert.equal(unknown.eligible, false)
  assert.match(unknown.reasons.join(' '), /not reported/)

  // A GPU tier on a CPU-only machine: refused, naming what to install and how to confirm it.
  const cpuOnly = placementFor({ device: { os: 'darwin', arch: 'arm64', availableRamBytes: 32 * 1000 ** 3, gpus: [], runtimes: [] }, model, contextTokens: 4096, requiresAccelerator: true, bitsPerWeight: 4 })
  assert.equal(cpuOnly.eligible, false)
  assert.match(cpuOnly.reasons.join(' '), /requires a confirmed accelerator/)
  assert.match(cpuOnly.reasons.join(' '), /metal/)
  assert.match(cpuOnly.note, /not a placement/)

  // The same machine is fine for a tier that accepts the CPU, once the memory is known.
  const onCpu = placementFor({ device: { os: 'darwin', arch: 'arm64', availableRamBytes: 32 * 1000 ** 3, gpus: [], runtimes: [] }, model, contextTokens: 4096, requiresAccelerator: false, bitsPerWeight: 4 })
  assert.equal(onCpu.eligible, true)
  assert.equal(onCpu.accelerator, 'cpu')

  // An incomplete model record cannot be placed at all.
  const incomplete = placementFor({ device: cudaDevice(), model: { parameters: BASE.parameters }, contextTokens: 4096 })
  assert.equal(incomplete.eligible, false)
  assert.match(incomplete.reasons[0], /parameters, layers, kvHeads and headDim/)
})

test('a composed tier with nothing chosen is not ready, and says what each step is waiting for', () => {
  const plan = compositionPlan(TIERS.PRO)
  assert.equal(plan.trainingRequired, false)
  assert.equal(plan.ready, false)
  assert.deepEqual(plan.steps.map((s) => s.id), [...COMPOSITION_STEP_IDS])
  for (const item of plan.steps) {
    if (item.status === STEP_STATES.SATISFIED || item.status === STEP_STATES.NOT_APPLICABLE) continue
    assert.ok(item.reason && item.reason.length > 15, `${item.id} must say why it is not satisfied`)
  }
  assert.deepEqual(plan.blockedOn, ['licence', 'pin', 'runtime', 'fit'])
  assert.deepEqual(plan.waitingOn, ['fetch', 'measure'])
  // The mechanisms are already attached: they are code in this repository, not weights.
  assert.equal(stepOf(plan, 'mechanisms').status, STEP_STATES.SATISFIED)
  assert.match(stepOf(plan, 'mechanisms').evidence, /trends\.mjs/)
  assert.match(stepOf(plan, 'mechanisms').evidence, /affect\.mjs/)
  assert.match(formatComposition(plan), /training required: no/)
})

test('a complete composition is ready without training anything', () => {
  const plan = compositionPlan(TIERS.PRO, {
    base: BASE,
    device: cudaDevice(8 * 1000 ** 3),
    contextTokens: 8192,
    quantisation: { format: 'int8', parityChecked: true },
    weightsPresent: true,
    measured: { device: 'Fake RTX 8GB', tokensPerSecond: 41.5, peakBytes: 2_400_000_000 },
  })
  assert.equal(plan.ready, true)
  assert.deepEqual(plan.blockedOn, [])
  assert.deepEqual(plan.waitingOn, [])
  assert.equal(plan.trainingRequired, false)
  for (const id of ['licence', 'pin', 'fetch', 'convert', 'runtime', 'fit', 'measure']) {
    assert.equal(stepOf(plan, id).status, STEP_STATES.SATISFIED, id)
  }
  assert.match(stepOf(plan, 'runtime').evidence, /cuda/)
})

test('the licence, the pin and the hash are gates, not paperwork', () => {
  const gpl = compositionPlan(TIERS.PRO, { base: { ...BASE, licence: 'GPL-3.0' }, device: cudaDevice() })
  assert.equal(stepOf(gpl, 'licence').status, STEP_STATES.BLOCKED)
  assert.match(stepOf(gpl, 'licence').reason, /not on the allowlist/)
  assert.ok(LICENCES_ALLOWED.includes('Apache-2.0'))

  const unpinned = compositionPlan(TIERS.PRO, { base: { ...BASE, revision: null }, device: cudaDevice() })
  assert.equal(stepOf(unpinned, 'pin').status, STEP_STATES.BLOCKED)
  assert.match(stepOf(unpinned, 'pin').reason, /not pinned to a revision/)

  const unhashed = compositionPlan(TIERS.PRO, { base: { ...BASE, weightsSha256: null }, device: cudaDevice() })
  assert.equal(stepOf(unhashed, 'pin').status, STEP_STATES.BLOCKED)
  assert.match(stepOf(unhashed, 'pin').reason, /no weight hash/)

  const unnamed = compositionPlan(TIERS.PRO, { base: { ...BASE, licence: null }, device: cudaDevice() })
  assert.match(stepOf(unnamed, 'licence').reason, /names no licence/)
})

test('a conversion is only accepted with a parity check, and an unknown format is refused', () => {
  const unchecked = compositionPlan(TIERS.PRO, { base: BASE, device: cudaDevice(), quantisation: { format: 'int4' } })
  assert.equal(stepOf(unchecked, 'convert').status, STEP_STATES.REQUIRED)
  assert.match(stepOf(unchecked, 'convert').reason, /different model nobody measured/)

  const checked = compositionPlan(TIERS.PRO, { base: BASE, device: cudaDevice(), quantisation: { format: 'int4', parityChecked: true } })
  assert.equal(stepOf(checked, 'convert').status, STEP_STATES.SATISFIED)

  const nonsense = compositionPlan(TIERS.PRO, { base: BASE, device: cudaDevice(), quantisation: { format: 'int3' } })
  assert.equal(stepOf(nonsense, 'convert').status, STEP_STATES.BLOCKED)
  assert.match(stepOf(nonsense, 'convert').reason, /unknown quantisation/)

  const none = compositionPlan(TIERS.PRO, { base: BASE, device: cudaDevice() })
  assert.equal(stepOf(none, 'convert').status, STEP_STATES.NOT_APPLICABLE)
  assert.match(stepOf(none, 'convert').reason, /running unquantised/), 'an unquantised run says so rather than passing silently'
})

test('a fit that fails keeps the plan blocked and names the accelerator and the numbers', () => {
  const plan = compositionPlan(TIERS.MAX, {
    base: BASE, device: cudaDevice(2 * 1000 ** 3), contextTokens: 32768, quantisation: { format: 'int8', parityChecked: true },
  })
  assert.equal(plan.ready, false)
  assert.deepEqual(plan.blockedOn, ['fit'])
  assert.match(stepOf(plan, 'fit').reason, /has 2000000000 bytes available/)
  assert.match(stepOf(plan, 'fit').reason, /reduce the context/)
})

test('the third-party base never wears the tier label', () => {
  // Directive §5A, enforced by the same lookup the core uses: a label exists only when a backing
  // record of an *available* capability names the artifact, and a composed tier has none.
  assert.deepEqual(ownedArtifacts(TIERS.PRO), [])
  assert.deepEqual(ownedArtifacts(TIERS.MAX), [])
  assert.equal(tierClaimFor('third-party/small-instruct'), null)
  assert.equal(tierClaimForArtifact('third-party/small-instruct', '7ae5576'), null)
  assert.equal(tierClaimFor('aetheris-lite-lm-0.1.1'), TIERS.LITE, 'the trained artifact still carries its tier')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1'), TIERS.LITE)
})

// A composed tier is still a thing this module validates, even though no tier of the family is
// one today. The fixture is built here rather than borrowed from the record, so the rules stay
// tested while the family stays honest about which path it takes.
const COMPOSED_FIXTURE = {
  path: BACKING_PATHS.COMPOSED,
  trainingRequired: false,
  requires: 'a GPU or another accelerator that a runtime probe confirms',
  steps: COMPOSITION_STEP_IDS,
  bases: [],
  verified: false,
  accelerator: { id: null, measured: false },
}

test('a backing path is checked on its own terms: ours has no base, a composed one has nothing of ours', () => {
  const pro = KLYVARON[TIERS.PRO]
  assert.equal(pro.backingPath.path, BACKING_PATHS.TRAINED, 'Pro is this family\'s own model, not a composition')
  assert.equal(pro.backingPath.trainingRequired, true)
  assert.equal(pro.backingPath.architecture, 'aetheris-core-v1')
  assert.deepEqual(pro.backingPath.bases, [])
  assert.deepEqual(backingPathViolations(pro.backingPath, 'pro.backingPath'), [])
  assert.equal(validateFamily().valid, true, JSON.stringify(validateFamily().violations))

  // A from-scratch model with something underneath it is a composed model wearing our label.
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    const withBase = { ...KLYVARON[id].backingPath, bases: [{ ...BASE, provenance: 'third_party' }] }
    assert.match(backingPathViolations(withBase, `${id}.backingPath`).join(' '), /a from-scratch model has no base/)
  }
  // And it has to name the architecture it is a preset of, or "ours" is unverifiable.
  const nameless = { ...pro.backingPath, architecture: null }
  assert.match(backingPathViolations(nameless, 'pro.backingPath').join(' '), /must name the architecture/)
  // A trained tier that claims no training is required is refused too.
  const liar = { ...pro.backingPath, trainingRequired: false }
  assert.match(backingPathViolations(liar, 'pro.backingPath').join(' '), /must state that training is required/)

  // The composed path still validates, and still refuses its own contradictions.
  assert.deepEqual(backingPathViolations(COMPOSED_FIXTURE, 'composed'), [])
  const trainedLiars = { ...COMPOSED_FIXTURE, trainingRequired: true }
  assert.match(backingPathViolations(trainedLiars, 'composed').join(' '), /must state that no training is required/)
  const unknownStep = { ...COMPOSED_FIXTURE, steps: [...COMPOSITION_STEP_IDS, 'trust-me'] }
  assert.match(backingPathViolations(unknownStep, 'composed').join(' '), /unknown step/)
  // A composed base that claims to be ours is refused: the provenance is the check.
  const ours = { ...COMPOSED_FIXTURE, bases: [{ ...BASE, provenance: 'from_scratch' }] }
  assert.match(backingPathViolations(ours, 'composed').join(' '), /must be recorded as third_party/)
  const badLicence = { ...COMPOSED_FIXTURE, bases: [{ ...BASE, provenance: 'third_party', licence: 'GPL-3.0' }] }
  assert.match(backingPathViolations(badLicence, 'composed').join(' '), /not on the allowlist/)

  // A tier with no backing path at all is refused rather than assumed.
  assert.match(backingPathViolations(undefined, 'max.backingPath').join(' '), /must record a backing path/)

  // The whole family refuses an invalid one.
  const family = { ...KLYVARON, [TIERS.PRO]: { ...pro, backingPath: { ...pro.backingPath, trainingRequired: false } } }
  assert.equal(validateFamily(family).valid, false)
  assert.ok(validateFamily(family).violations.some((v) => v.includes('pro.backingPath')))
})

test('the own-weights gate is derived: a released artifact meets it, an architecture cannot', () => {
  const plan = idMap(developmentPlan())

  // Lite meets it, with the evidence naming the run rather than the intention.
  const lite = gateOf(plan[TIERS.LITE], GATES.OWN_WEIGHTS)
  assert.equal(lite.status, GATE_STATES.MET)
  assert.match(lite.evidence, /random initialisation/)

  // Pro and Max do not: the architecture is recorded and the weights are not.
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    const own = gateOf(plan[id], GATES.OWN_WEIGHTS)
    assert.equal(own.status, GATE_STATES.OPEN)
    assert.match(own.reason, /architecture and the exact config are recorded/)
    assert.match(own.reason, /An architecture is not an artifact/)
    const accelerated = gateOf(plan[id], GATES.ACCELERATED)
    assert.equal(accelerated.status, GATE_STATES.OPEN)
    assert.match(accelerated.reason, /there is nothing to run yet/)
    assert.match(accelerated.reason, /runtime probe .* is what confirms an accelerator/)
  }

  // The composed path can never satisfy it, whatever else it satisfies.
  const composedGates = backingPathGates(COMPOSED_FIXTURE)
  assert.equal(composedGates.ownWeights.met, false)
  assert.match(composedGates.ownWeights.reason, /not this family\'s own/)
  assert.equal(composedGates.accelerated.met, false)

  // A tier whose weights exist and were measured closes both.
  const verified = {
    ...KLYVARON,
    [TIERS.PRO]: {
      ...KLYVARON[TIERS.PRO],
      backingPath: { ...KLYVARON[TIERS.PRO].backingPath, verified: true, accelerator: { id: 'cuda', measured: true } },
    },
  }
  const verifiedPlan = idMap(developmentPlan(verified))
  assert.equal(gateOf(verifiedPlan[TIERS.PRO], GATES.OWN_WEIGHTS).status, GATE_STATES.MET)
  assert.equal(gateOf(verifiedPlan[TIERS.PRO], GATES.ACCELERATED).status, GATE_STATES.MET)

  // And Lite's accelerator gate stays open rather than being credited for hardware it could use.
  const liteGates = backingPathGates(KLYVARON[TIERS.LITE].backingPath)
  assert.equal(liteGates.ownWeights.met, true)
  assert.equal(liteGates.accelerated.met, false)
  assert.match(liteGates.accelerated.reason, /trained and evaluated on the CPU/)
})
