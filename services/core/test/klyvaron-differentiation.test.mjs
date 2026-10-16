// The Klyvaron family's stance and its two differentiating capabilities.
//
// These tests exist because each of these rules is the kind that survives only if something
// refuses to let it be forgotten: a family that says it does not compete while its own text
// names competitors, an image model that is a text model renamed, or a "trend aware" tier
// that becomes available without an artifact behind it.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPABILITY_STATES, COMPETITOR_MARKERS, FAMILY_STANCE, KLYVARON, MODALITY_ROLES, SEPARATE_MODALITIES,
  TIERS, familyReport, modalityArtifacts, modalityOf, stanceViolations, validateFamily,
} from '../src/klyvaron/tiers.mjs'
import { developmentPlan, GATES, GATE_STATES } from '../src/klyvaron/plan.mjs'

const byId = (plan) => Object.fromEntries(plan.tiers.map((t) => [t.id, t]))
const gateOf = (tier, id) => tier.gates.find((g) => g.id === id)

test('the family records that it is not competing, and what that forbids', () => {
  assert.equal(FAMILY_STANCE.competitive, false)
  assert.ok(FAMILY_STANCE.forbiddenClaims.some((claim) => /competitor/i.test(claim)),
    'a benchmark win over a competitor must be a forbidden claim')
  assert.ok(FAMILY_STANCE.forbiddenClaims.some((claim) => /diagnosis/i.test(claim)),
    'a feeling or diagnosis the user did not express must be a forbidden claim')
  // The two things it does measure are named, so "not competitive" is not "not measured".
  assert.equal(FAMILY_STANCE.measures.length, 2)
  assert.deepEqual([...FAMILY_STANCE.differentiators], ['trend.awareness', 'affect.history'])
  // Allowed comparisons stay inside this repository's own artifacts and computed baselines.
  assert.ok(FAMILY_STANCE.allowedComparisons.every((line) => !COMPETITOR_MARKERS.some((m) => line.toLowerCase().includes(m))))
  assert.equal(familyReport().stance.competitive, false, 'the stance travels with the report')
})

test('comparison language is refused wherever a tier describes itself', () => {
  assert.deepEqual(stanceViolations('Stronger local intelligence on qualified laptops.', 'tier'), [])
  for (const marker of COMPETITOR_MARKERS.slice(0, 3)) {
    const violations = stanceViolations(`Better than ${marker} at everything.`, 'tier')
    assert.equal(violations.length, 1, marker)
    assert.match(violations[0], /stance forbids comparing/)
  }
  // And the real records pass their own check, which is what the validator asserts.
  assert.equal(validateFamily().valid, true, JSON.stringify(validateFamily().violations))
  for (const tier of Object.values(KLYVARON)) {
    assert.deepEqual(stanceViolations(tier.description, `${tier.id}.description`), [])
    assert.deepEqual(stanceViolations(tier.statusNote, `${tier.id}.statusNote`), [])
  }
})

test('a tier that names a competitor is invalid, and its plan is printed as INVALID', () => {
  const family = {
    ...KLYVARON,
    [TIERS.PRO]: { ...KLYVARON[TIERS.PRO], description: 'Beats ChatGPT on every benchmark.' },
  }
  const { valid, violations } = validateFamily(family)
  assert.equal(valid, false)
  assert.ok(violations.some((v) => v.startsWith('pro.description')), JSON.stringify(violations))
})

test('both differentiators are defined on every tier and backed by nothing', () => {
  for (const tier of Object.values(KLYVARON)) {
    for (const name of FAMILY_STANCE.differentiators) {
      const claim = tier.capabilities[name]
      assert.ok(claim, `${tier.id}.${name} must exist; a family that defines its purpose only in prose has none`)
      assert.equal(claim.state, CAPABILITY_STATES.UNAVAILABLE, `${tier.id}.${name}`)
      assert.equal(claim.backing, null, `${tier.id}.${name} must not claim a backing artifact`)
      assert.ok(claim.acceptance.length >= 3, `${tier.id}.${name} must state what done means`)
      assert.ok(claim.reason.length > 40, `${tier.id}.${name} must say what is missing`)
    }
  }
})

test('a differentiator marked available without an artifact is refused like any other claim', () => {
  const family = {
    ...KLYVARON,
    [TIERS.PRO]: {
      ...KLYVARON[TIERS.PRO],
      capabilities: {
        ...KLYVARON[TIERS.PRO].capabilities,
        'trend.awareness': { state: CAPABILITY_STATES.AVAILABLE, backing: null, acceptance: [] },
      },
    },
  }
  const { valid, violations } = validateFamily(family)
  assert.equal(valid, false)
  assert.ok(violations.some((v) => v.includes('trend.awareness: claimed \'available\' with no backing artifact')))
  // And the gate stays open: the plan reads the record, not the declaration.
  const plan = developmentPlan(family)
  assert.equal(gateOf(byId(plan)[TIERS.PRO], GATES.TREND_AWARENESS).status, GATE_STATES.OPEN)
})

test('image and video are separate modalities, and never the text artifact under another name', () => {
  // Every capability the family names has a modality, so a capability cannot be added
  // without deciding which artifact would have to back it.
  for (const tier of Object.values(KLYVARON)) {
    for (const name of Object.keys(tier.capabilities)) {
      assert.ok(MODALITY_ROLES[name], `${name} has no modality; add it to MODALITY_ROLES`)
      assert.notEqual(modalityOf(name), undefined)
    }
  }
  assert.deepEqual([...SEPARATE_MODALITIES], ['image', 'video'])

  // Lite's only artifact is a text model. Its image row exists because it claims image
  // understanding, and that row carries no artifact.
  const lite = modalityArtifacts(KLYVARON[TIERS.LITE])
  assert.equal(lite.text.artifact, 'aetheris-lite-lm-0.1.1')
  assert.equal(lite.image.artifact, null)
  const pro = modalityArtifacts(KLYVARON[TIERS.PRO])
  assert.deepEqual(Object.keys(pro).sort(), ['image', 'text', 'video'])
  for (const modality of SEPARATE_MODALITIES) assert.equal(pro[modality].artifact, null)

  // The refusal itself. A fixture that backs image generation with the text artifact is
  // invalid -- this is the check that makes "a text model is not an image model" a rule.
  const relabelled = {
    ...KLYVARON,
    [TIERS.PRO]: {
      ...KLYVARON[TIERS.PRO],
      status: 'partial',
      statusNote: 'Fixture: image generation backed by the text artifact.',
      capabilities: {
        chat: {
          state: CAPABILITY_STATES.AVAILABLE,
          backing: {
            artifact: 'fixture-text-1', kind: 'language_model', licence: 'MIT', provenance: 'from_scratch', baseModel: null,
            measured: { validationPerplexity: 3.1 }, limitations: ['Fixture.'],
          },
          limitations: ['Fixture.'],
        },
        'image.generate': {
          state: CAPABILITY_STATES.AVAILABLE,
          backing: {
            artifact: 'fixture-text-1', kind: 'language_model', licence: 'MIT', provenance: 'from_scratch', baseModel: null,
            measured: { clipScore: 0.3 }, limitations: ['Fixture.'],
          },
          limitations: ['Fixture.'],
        },
      },
    },
  }
  const { valid, violations } = validateFamily(relabelled)
  assert.equal(valid, false)
  assert.ok(violations.some((v) => v.includes("artifact 'fixture-text-1' also backs the text capabilities")),
    JSON.stringify(violations))
  const plan = developmentPlan(relabelled)
  assert.equal(gateOf(byId(plan)[TIERS.PRO], GATES.MODALITY_SEPARATION).status, GATE_STATES.OPEN)
  // An image artifact of its own moves the gate, and nothing else has to change.
  const separated = {
    ...relabelled,
    [TIERS.PRO]: {
      ...relabelled[TIERS.PRO],
      capabilities: {
        ...relabelled[TIERS.PRO].capabilities,
        'image.generate': {
          state: CAPABILITY_STATES.AVAILABLE,
          backing: {
            artifact: 'fixture-image-1', kind: 'diffusion', licence: 'Apache-2.0', provenance: 'from_scratch', baseModel: null,
            measured: { clipScore: 0.31 }, limitations: ['Fixture.'],
          },
          limitations: ['Fixture.'],
        },
      },
    },
  }
  const separatedPlan = developmentPlan(separated)
  assert.equal(byId(separatedPlan)[TIERS.PRO].status, 'partial')
  assert.equal(gateOf(byId(separatedPlan)[TIERS.PRO], GATES.MODALITY_SEPARATION).status, GATE_STATES.MET)
})

test('the report carries each tier\'s differentiators and their state, so a UI cannot invent one', () => {
  const report = familyReport()
  for (const tier of report.tiers) {
    assert.deepEqual(tier.differentiators.map((d) => d.name), ['trend.awareness', 'affect.history'])
    for (const d of tier.differentiators) {
      assert.equal(d.state, CAPABILITY_STATES.UNAVAILABLE)
      assert.ok(Array.isArray(d.acceptance) && d.acceptance.length > 0)
    }
    assert.ok(tier.modalityArtifacts.text, 'every tier has a text row')
  }
})
