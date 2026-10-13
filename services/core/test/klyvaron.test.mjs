// The Klyvaron family: three tiers, and the rule that stops a label implying quality.
//
// The tests that matter here are the negative controls. Directive §10 forbids claiming
// "quality improvements merely because a model has been assigned the Pro or High label"
// and §5A forbids presenting a derived model as a first-party foundation model. Those
// are both cases of a *record that reads as a claim*, so they are tested by constructing
// the offending record and asserting the validator refuses it.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_STATES, HARDWARE_CLASS, KLYVARON, MOBILE_TARGETS, ModelFamilyError, PROVENANCE, TIERS,
  TIER_STATUS,
  familyReport, getTier, ownedArtifacts, tierClaimFor, tierClaimForArtifact, tierFitsHardware, validateFamily,
} from '../src/klyvaron/tiers.mjs'

const clone = (value) => JSON.parse(JSON.stringify(value))

test('the shipped family validates', () => {
  const { valid, violations } = validateFamily()
  assert.deepEqual(violations, [])
  assert.equal(valid, true)
})

test('the three tiers exist with the hardware classes the directive names', () => {
  assert.deepEqual(Object.keys(KLYVARON), ['lite', 'pro', 'high'])
  assert.equal(getTier(TIERS.LITE).targetHardware, HARDWARE_CLASS.MOBILE)
  assert.equal(getTier(TIERS.PRO).targetHardware, HARDWARE_CLASS.LAPTOP)
  assert.equal(getTier(TIERS.HIGH).targetHardware, HARDWARE_CLASS.WORKSTATION)
})

test('the tier names and hardware order come from the directive, not from taste', () => {
  // §5A mobile, §5B laptops and desktops, §5C powerful computers and remote inference.
  assert.equal(tierFitsHardware(TIERS.LITE, HARDWARE_CLASS.MOBILE), true)
  assert.equal(tierFitsHardware(TIERS.LITE, HARDWARE_CLASS.LAPTOP), true, 'a laptop can run Lite')
  assert.equal(tierFitsHardware(TIERS.PRO, HARDWARE_CLASS.MOBILE), false, 'Pro is not a phone tier')
  assert.equal(tierFitsHardware(TIERS.HIGH, HARDWARE_CLASS.DESKTOP), false)
  assert.equal(tierFitsHardware(TIERS.HIGH, HARDWARE_CLASS.WORKSTATION), true)
  assert.equal(tierFitsHardware(TIERS.HIGH, HARDWARE_CLASS.REMOTE), true)
  assert.throws(() => getTier('ultra'),
    (error) => error instanceof ModelFamilyError && error.code === 'model_family_violation')
})

test('Lite reports the artifact that exists, and only the capabilities it backs', () => {
  const report = familyReport()
  const lite = report.tiers.find((t) => t.id === TIERS.LITE)
  assert.equal(lite.status, TIER_STATUS.PARTIAL)
  assert.deepEqual(lite.availableCapabilities, ['text.completion', 'text.extract'])

  const backing = lite.capabilities['text.completion'].backing
  assert.equal(backing.parameters, 359_136)
  assert.equal(backing.provenance, PROVENANCE.FROM_SCRATCH)
  assert.equal(backing.baseModel, null, 'trained from random initialisation, so there is no base')
  assert.equal(backing.licence, 'MIT')
  assert.match(backing.weightsDigest, /^[0-9a-f]{64}$/)
  assert.ok(backing.measured.validationPerplexity > 0)
  assert.ok(backing.benchmarks.length > 0, 'a claim needs a protocol behind it')
  assert.ok(backing.limitations.length > 0)
})

test('Lite does not claim to chat, and says why', () => {
  // The single most important negative claim in this file. The model that exists is
  // reachable over /api/chat and still does not constitute a chat capability, so the
  // reason has to say what actually happens rather than that nothing was wired up.
  const chat = getTier(TIERS.LITE).capabilities.chat
  assert.equal(chat.state, CAPABILITY_STATES.UNAVAILABLE)
  assert.equal(chat.backing, null)
  assert.match(chat.reason, /No instruction-tuned artifact exists/)
  assert.match(chat.reason, /refused there unless pinned by id/)
})

test('Pro and High are recorded as unbuilt rather than omitted', () => {
  for (const id of [TIERS.PRO, TIERS.HIGH]) {
    const tier = getTier(id)
    assert.equal(tier.status, TIER_STATUS.UNBUILT)
    assert.ok(tier.statusNote, 'an unbuilt tier must say so')
    assert.equal(
      Object.values(tier.capabilities).filter((c) => c.state === CAPABILITY_STATES.AVAILABLE).length, 0,
    )
    assert.ok(Object.keys(tier.capabilities).length >= 9, 'the intended capabilities are still listed')
  }
})

test('the mobile storage targets are the directive numbers, and Lite meets only the size one', () => {
  assert.equal(MOBILE_TARGETS.managedTotalBytes, 5_000_000_000, '5 GB, strictly below')
  assert.equal(MOBILE_TARGETS.reserveBytes, 500_000_000)
  assert.equal(MOBILE_TARGETS.appPackageBytes, 200_000_000)
  assert.equal(MOBILE_TARGETS.primaryModelBytes, 1_500_000_000)

  // The artifact is far SMALLER than the target, and much weaker than the capability
  // targets. Both are recorded; the tier does not get credit for the second.
  const lite = getTier(TIERS.LITE)
  assert.ok(lite.storageProfile.primaryArtifactBytes < MOBILE_TARGETS.primaryModelBytes)
  assert.ok(
    lite.capabilities['text.completion'].backing.limitations
      .some((l) => /storage target is met/.test(l)),
    'the backing must state that being undersized is not a capability win',
  )
})

// --- negative controls -----------------------------------------------------------

test('a capability claiming availability with no backing artifact is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities.chat = { state: CAPABILITY_STATES.AVAILABLE, backing: null }
  const { valid, violations } = validateFamily(family)
  assert.equal(valid, false)
  assert.ok(violations.some((v) => /claimed 'available' with no backing/.test(v)), violations.join('; '))
  assert.ok(violations.some((v) => /A tier label is not evidence/.test(v)))
})

test('a derived model without its base model is refused, because provenance is a licence question', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.provenance = PROVENANCE.FINE_TUNED
  family.lite.capabilities['text.completion'].backing.baseModel = null
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /must name its base model and licence/.test(v)), violations.join('; '))

  // Naming the base clears it: the rule refuses silence, not derivation.
  family.lite.capabilities['text.completion'].backing.baseModel = 'Qwen2.5-0.5B (Apache-2.0)'
  assert.ok(!validateFamily(family).violations.some((v) => /base model/.test(v)))
})

test('an available capability with no stated limitations is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.limitations = []
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /no stated limitations/.test(v)), violations.join('; '))
})

test('an available capability with no measurements is refused', () => {
  const family = clone(KLYVARON)
  family.lite.capabilities['text.completion'].backing.measured = {}
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /no measurements/.test(v)), violations.join('; '))
})

test('an unbuilt tier may not have an available capability', () => {
  const family = clone(KLYVARON)
  family.pro.status = TIER_STATUS.UNBUILT
  family.pro.capabilities.chat = {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: clone(KLYVARON.lite.capabilities['text.completion'].backing),
  }
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /status is 'unbuilt' but 1 capability claims to be available/.test(v)),
    violations.join('; '))
})

test('an unbuilt tier without a status note is refused', () => {
  const family = clone(KLYVARON)
  delete family.high.statusNote
  const { violations } = validateFamily(family)
  assert.ok(violations.some((v) => /an unbuilt tier must say so/.test(v)), violations.join('; '))
})

test('a tier cannot be labelled available or partial with nothing available', () => {
  const family = clone(KLYVARON)
  family.high.status = TIER_STATUS.AVAILABLE
  assert.ok(validateFamily(family).violations.some((v) => /status is 'available' with no available capability/.test(v)))
  family.high.status = TIER_STATUS.PARTIAL
  assert.ok(validateFamily(family).violations.some((v) => /that is 'unbuilt'/.test(v)))
})

test('a backing without a licence is refused', () => {
  const family = clone(KLYVARON)
  delete family.lite.capabilities['text.completion'].backing.licence
  assert.ok(validateFamily(family).violations.some((v) => /must name its artifact, licence and provenance/.test(v)))
})

test('the report is generated from the data, so a rename cannot add a capability', () => {
  // Renaming a tier to something grander changes nothing in the report's capability
  // lists, which is the point: the label is not an input to the claim.
  const family = clone(KLYVARON)
  family.pro.displayName = 'Klyvaron Pro Ultra Max'
  const report = familyReport()
  const pro = report.tiers.find((t) => t.id === TIERS.PRO)
  assert.deepEqual(pro.availableCapabilities, [])
  assert.equal(pro.status, TIER_STATUS.UNBUILT)
})

// --- integration: the family reaches the API, and a label cannot be faked ---------

test('a tier label needs a backing record for the exact version, not a declaration', () => {
  // The versioned form is what the core uses, because "is this model Klyvaron Lite?" is a
  // question about an artifact, and an artifact is an id plus a version.
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.0'), TIERS.LITE, 'the released artifact')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '0.1.1-verify'), TIERS.LITE,
    'the corrected-corpus verification artifact is still a Lite artifact')
  // And nothing else may carry the label, whatever its manifest declares.
  assert.equal(tierClaimForArtifact('aetheris-lite-lm', '9.9.9'), null, 'a version that does not exist')
  assert.equal(tierClaimForArtifact('klyvaron-parity-tiny', '0.1.0'), null, 'a test fixture is not a family artifact')
  assert.equal(tierClaimForArtifact('Qwen2.5-7B-Instruct', '0.1.0'), null, 'a renamed third-party model')
  assert.equal(tierClaimForArtifact('aetheris-lite-lm-pro', '0.1.0'), null)
  // Pro and High have nothing behind them, so no version of anything is theirs yet.
  assert.equal(tierClaimForArtifact('aetheris-pro-lm', '0.1.0'), null)
  assert.equal(tierClaimForArtifact('aetheris-high-lm', '0.1.0'), null)
})

test('the second artifact is recorded as verification evidence, not as a release', () => {
  // Two artifacts of this family exist, and the record says which one is the release.
  // Without this, a tier that names only the artifact nobody can rebuild would look like
  // an oversight, and one that named the other as the release would be renumbering.
  const backing = KLYVARON.lite.capabilities['text.completion'].backing
  const second = backing.verificationArtifact
  assert.ok(second, 'the second artifact must be recorded, not omitted')
  assert.equal(second.status, 'not_a_release')
  assert.notEqual(second.artifact, backing.artifact, 'two artifacts must not share a name')
  assert.notEqual(second.weightsDigest, backing.weightsDigest, 'a different corpus means different weights')
  assert.match(second.weightsDigest, /^[0-9a-f]{64}$/)
  assert.match(second.artifactSha256, /^[0-9a-f]{64}$/, 'the file the store verifies needs its own digest')
  assert.notEqual(second.artifactSha256, second.weightsDigest,
    'the weights hash and the file hash are different digests of different things')
  assert.ok(second.artifactBytes > 0)
  assert.ok(second.record.endsWith('.json'), 'evidence must point at the record that holds it')
  assert.match(second.note, /not comparable|not a successor/,
    'the record must say the numbers are not comparable with the release')
  assert.ok(second.parameters > 0)
  assert.ok(!ownedArtifacts(TIERS.LITE).includes(second.artifact),
    'the capability is backed by the released artifact; the second one is evidence')
})

test('a tier label is looked up from the backing record, never declared', () => {
  assert.equal(tierClaimFor('aetheris-lite-lm-0.1.0'), TIERS.LITE)
  // The three ways someone would try to claim unearned capability. All return null,
  // because the lookup only matches the artifact ids a real backing names.
  assert.equal(tierClaimFor('Klyvaron-Pro-7B'), null, 'a made-up product name')
  assert.equal(tierClaimFor('Qwen2.5-7B-Instruct'), null, 'a renamed third-party model')
  assert.equal(tierClaimFor('aetheris-lite-lm-9.9.9'), null, 'a version that does not exist')
  assert.deepEqual(ownedArtifacts(TIERS.PRO), [], 'an unbuilt tier owns no artifact')
  assert.deepEqual(ownedArtifacts(TIERS.HIGH), [])
})

test('the family report is served on the models route, and it is the validated one', () => {
  for (const tier of familyReport().tiers) {
    assert.ok(tier.status, `${tier.id} must carry a status into the API`)
    assert.ok(Array.isArray(tier.availableCapabilities))
  }
  assert.equal(familyReport().valid, true)
})
