// The Klyvaron development plan is derived from the tier records. These tests pin that: the
// plan cannot show a gate met that the record does not back, and an unbuilt tier cannot show
// progress it has not made.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KLYVARON, TIERS, CAPABILITY_STATES, ownedArtifacts, validateFamily } from '../src/klyvaron/tiers.mjs'
import { developmentPlan, formatPlan, tierGates, GATES, GATE_STATES } from '../src/klyvaron/plan.mjs'

const byId = (plan) => Object.fromEntries(plan.tiers.map((t) => [t.id, t]))
const gateOf = (tier, id) => tier.gates.find((g) => g.id === id)

test('every tier is asked the same questions, in the same order', () => {
  const plan = developmentPlan()
  assert.equal(plan.valid, true, JSON.stringify(plan.violations))
  const ids = plan.tiers.map((t) => t.gates.map((g) => g.id).join('|'))
  assert.equal(new Set(ids).size, 1)
  assert.deepEqual(plan.tiers[0].gates.map((g) => g.id), Object.values(GATES))
})

test('Pro and Max are unbuilt: no gate is met and every open gate says why', () => {
  const tiers = byId(developmentPlan())
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    assert.equal(tiers[id].status, 'unbuilt')
    assert.equal(tiers[id].met, 0, `${id} must have no met gate`)
    for (const g of tiers[id].gates) {
      assert.equal(g.status, GATE_STATES.OPEN)
      assert.ok(g.reason && g.reason.length > 10, `${id}.${g.id} needs a reason`)
      assert.equal(g.evidence, null)
    }
  }
})

test('Lite meets what its released record shows, and stays open where the record is weak', () => {
  const lite = byId(developmentPlan())[TIERS.LITE]
  for (const id of [GATES.ARTIFACT, GATES.PROVENANCE, GATES.MEASUREMENTS, GATES.STORAGE]) {
    assert.equal(gateOf(lite, id).status, GATE_STATES.MET, id)
  }
  // The released model does not chat, and it covers 2 of 11 capabilities. Both stay open.
  assert.equal(gateOf(lite, GATES.CHAT).status, GATE_STATES.OPEN)
  assert.match(gateOf(lite, GATES.COVERAGE).reason, /9 of 11/)
  // Nothing in the record qualifies Lite on a phone or a CPU profile, so the gate stays open.
  assert.equal(gateOf(lite, GATES.HARDWARE).status, GATE_STATES.OPEN)
})

test('each gate agrees with the tier record it is derived from', () => {
  for (const tier of Object.values(KLYVARON)) {
    const gates = tierGates(tier)
    const artifact = gates.find((g) => g.id === GATES.ARTIFACT)
    assert.equal(artifact.status === GATE_STATES.MET, ownedArtifacts(tier.id).length > 0, tier.id)
    const chat = gates.find((g) => g.id === GATES.CHAT)
    assert.equal(chat.status === GATE_STATES.MET, tier.capabilities.chat.state === CAPABILITY_STATES.AVAILABLE, tier.id)
    const hardware = gates.find((g) => g.id === GATES.HARDWARE)
    assert.equal(hardware.status, GATE_STATES.OPEN, 'no record qualifies any tier on hardware')
  }
})

test('a tier that gains a backed capability moves its gates, and nothing else is asserted for it', () => {
  const pro = KLYVARON[TIERS.PRO]
  const family = {
    ...KLYVARON,
    [TIERS.PRO]: {
      ...pro,
      status: 'partial',
      statusNote: 'Test fixture: one backed capability.',
      storageProfile: { primaryArtifactBytes: 900_000_000 },
      capabilities: {
        chat: {
          state: CAPABILITY_STATES.AVAILABLE,
          backing: {
            artifact: 'fixture-pro-1', kind: 'language_model', licence: 'MIT', provenance: 'from_scratch', baseModel: null,
            measured: { validationPerplexity: 3.1 },
            limitations: ['Synthetic fixture for the plan test, not a released model.'],
          },
          limitations: ['Synthetic fixture.'],
        },
        'coding.assist': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'fixture' },
      },
    },
  }
  const plan = developmentPlan(family)
  assert.equal(plan.valid, true, JSON.stringify(plan.violations))
  const pro2 = byId(plan)[TIERS.PRO]
  assert.equal(gateOf(pro2, GATES.ARTIFACT).status, GATE_STATES.MET)
  assert.equal(gateOf(pro2, GATES.ARTIFACT).evidence, 'fixture-pro-1')
  assert.equal(gateOf(pro2, GATES.CHAT).status, GATE_STATES.MET)
  assert.equal(gateOf(pro2, GATES.PROVENANCE).status, GATE_STATES.MET)
  assert.equal(gateOf(pro2, GATES.MEASUREMENTS).status, GATE_STATES.MET)
  assert.equal(gateOf(pro2, GATES.STORAGE).status, GATE_STATES.OPEN, 'storage is only measured on the mobile target')
  assert.equal(gateOf(pro2, GATES.COVERAGE).status, GATE_STATES.OPEN)
  assert.equal(gateOf(pro2, GATES.COVERAGE).evidence, null)
  assert.match(gateOf(pro2, GATES.COVERAGE).reason, /1 of 2|not yet available/)
  // Hardware qualification is still absent from the record, so it is still open.
  assert.equal(gateOf(pro2, GATES.HARDWARE).status, GATE_STATES.OPEN)
})

test('an available claim with no backing is reported invalid, and its gates stay open', () => {
  const family = {
    ...KLYVARON,
    [TIERS.MAX]: {
      ...KLYVARON[TIERS.MAX],
      status: 'partial',
      statusNote: 'Test fixture: claims without backing.',
      capabilities: { chat: { state: CAPABILITY_STATES.AVAILABLE, backing: null, limitations: [] } },
    },
  }
  const plan = developmentPlan(family)
  assert.equal(plan.valid, false)
  assert.ok(plan.violations.some((v) => v.includes('no backing artifact')))
  const max = byId(plan)[TIERS.MAX]
  assert.equal(gateOf(max, GATES.ARTIFACT).status, GATE_STATES.OPEN, 'a label is not an artifact')
  assert.equal(gateOf(max, GATES.CHAT).status, GATE_STATES.OPEN)
  assert.equal(gateOf(max, GATES.MEASUREMENTS).status, GATE_STATES.OPEN)
  assert.match(formatPlan(plan), /INVALID/)
})

test('the printed plan shows the reason for every open gate, so an open gate is never silent', () => {
  const text = formatPlan(developmentPlan())
  assert.match(text, /Family record: valid/)
  assert.doesNotMatch(text, /open: *$/m)
  assert.equal((text.match(/\[ \]/g) ?? []).length, (text.match(/open: /g) ?? []).length)
  assert.match(text, /\[x\] A model artifact backs at least one capability/)
})

test('the CLI prints the plan from the record, without a data directory', () => {
  const script = fileURLToPath(new URL('../scripts/klyvaron.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [script, 'plan'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  assert.match(out, /Klyvaron Lite \[partial\]/)
  assert.match(out, /Klyvaron Pro \[unbuilt\]/)
  assert.match(out, /Klyvaron Max \[unbuilt\]/)
  assert.equal(validateFamily().valid, true)
})
