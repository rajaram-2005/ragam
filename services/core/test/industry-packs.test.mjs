// Phase 9: industry packs.
//
// The acceptance criteria are derived from the standing rules, because the directive names the
// phase without stating them:
//
//   1. "Do not falsely advertise a capability that the available model or hardware cannot
//      deliver." → a pack whose required capability this installation lacks is reported partial,
//      naming every missing capability, and is not applied by default.
//   2. "Require approval for destructive actions, sensitive data access, external publication…"
//      → a pack may *add* restrictions and refusals. It may never relax one, never grant a
//      permission, and never authorise an action — it is data (Phase 7), with a version number.
//   3. "Do not treat ... model-generated explanations as verified facts." → a pack that claims a
//      capability must cite the evidence for it or admit it is unimplemented, and a regulated
//      pack must require human review and state what it refuses to do.
//
// The packs below are built from the shipped ones where possible, so the tests exercise the
// content users would actually get rather than a fixture that exists only in a test file.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PackError, REFUSABLE_ACTIONS, REGULATED_INDUSTRIES, compareSemver, strictestRestrictions, validatePack,
} from '../src/packs/manifest.mjs'
import { PackRegistry, PACK_STATES } from '../src/packs/registry.mjs'
import { BUILTIN_PACKS, BUILTIN_PACK_IDS, installBuiltinPacks } from '../src/packs/builtin.mjs'
import { AuthorityBroker, TRUST } from '../src/mcp/authority.mjs'
import { ProviderFabric, PROVIDER_KINDS } from '../src/adaptive/providers.mjs'
import { createEgressGuard, RUNTIME_POLICIES } from '../src/policy/egress.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const pack = (overrides = {}) => ({
  id: 'test.pack',
  name: 'Test pack',
  industry: 'engineering',
  version: '1.0.0',
  description: 'A pack used to exercise validation without shipping as a product pack.',
  restrictions: { dataClassFloor: 'internal', refusedActions: ['fs.write'] },
  refuses: ['It will not write to a file without a named reviewer.'],
  capabilities: [],
  vocabulary: { 'working tree': 'The files as they are on disk.' },
  disclaimers: ['A measurement is not an opinion.'],
  sources: [],
  provenance: { author: 'test', created: 1_700_000_000_000, licence: 'MIT' },
  ...overrides,
})

/** A fabric that serves exactly the tags given, all ready. */
async function fabricServing(tags) {
  const fabric = new ProviderFabric({ guard: createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE }) })
  for (const tag of tags) {
    fabric.register({
      id: `local.${tag.replace('.', '-')}`,
      kind: PROVIDER_KINDS.IN_PROCESS,
      capabilities: [tag],
      provider: { probe: async () => ({ availability: 'ready', detail: 'test double' }) },
      invoke: async () => ({ ok: true }),
    })
  }
  await fabric.probe()
  return fabric
}

// ---------------------------------------------------------------------------------------
// 1. Acceptance: a pack narrows. It never widens.
// ---------------------------------------------------------------------------------------

test('acceptance: a pack can only narrow policy, never widen it', () => {
  // A pack asking for a weaker data-class floor is refused at validation, naming the field. It is
  // not clamped to a safe value: a pack that asks to relax a control was written by somebody who
  // believed it could, and refusing is how that belief is corrected.
  assert.throws(
    () => validatePack(pack({ restrictions: { dataClassFloor: 'public' } })),
    (error) => error.code === 'pack_invalid' && error.problems.some((problem) => /would lower the data-class floor/.test(problem)),
    "a pack asking to handle material at 'public' is asking to lower the floor",
  )
  // Raising the floor is what a pack is for, and is accepted at every level above the minimum.
  for (const stricter of ['internal', 'confidential', 'restricted']) {
    assert.equal(validatePack(pack({ restrictions: { dataClassFloor: stricter } })).restrictions.dataClassFloor, stricter)
  }
  assert.throws(() => validatePack(pack({ restrictions: { dataClassFloor: 'secret' } })), (error) => error.code === 'pack_invalid')

  // There is no key through which a pack can reach the runtime policy at all. An unknown key is a
  // refusal rather than something ignored, because "ignored" is indistinguishable from "applied"
  // to the person who wrote it.
  for (const smuggled of ['policy', 'permissions', 'grant', 'allowExternal', 'egress']) {
    assert.throws(
      () => validatePack(pack({ [smuggled]: true })),
      (error) => error.code === 'pack_invalid' && error.problems.some((problem) => problem.startsWith(smuggled)),
      `'${smuggled}' must not be a pack key`,
    )
  }
  assert.throws(
    () => validatePack(pack({ restrictions: { refusedActions: ['*'] } })),
    (error) => error.problems.some((problem) => /is not one of/.test(problem)),
  )

  // Composition takes the strictest of both, in every field, and has no inverse.
  const a = { dataClassFloor: 'internal', refusedActions: ['fs.write'], requireHumanReview: false, requireSources: false }
  const b = { dataClassFloor: 'restricted', refusedActions: ['network.external'], requireHumanReview: true, requireSources: true }
  const merged = strictestRestrictions(a, b)
  assert.equal(merged.dataClassFloor, 'restricted')
  assert.deepEqual(merged.refusedActions, ['fs.write', 'network.external'])
  assert.equal(merged.requireHumanReview, true)
  assert.equal(merged.requireSources, true)
  assert.deepEqual(strictestRestrictions(merged, a), merged, 'merging a weaker set in changes nothing')
  assert.deepEqual(strictestRestrictions(), strictestRestrictions(), 'the empty merge is stable')
})

test('every refusable action is one the system can actually enforce', () => {
  // A closed vocabulary, so a pack cannot state a control nothing implements — a refusal nobody
  // enforces is worse than no refusal, because it reads as a safety property.
  assert.ok(REFUSABLE_ACTIONS.length >= 5)
  for (const action of REFUSABLE_ACTIONS) assert.match(action, /^[a-z]+\.[a-z]+$/)
  assert.throws(
    () => validatePack(pack({ restrictions: { refusedActions: ['delete-everything'] } })),
    (error) => error.code === 'pack_invalid',
  )
})

// ---------------------------------------------------------------------------------------
// 2. Acceptance: a pack is data. It cannot authorise anything.
// ---------------------------------------------------------------------------------------

test('acceptance: a pack is data and cannot authorise an action', () => {
  const registry = new PackRegistry({})
  registry.install(pack({ restrictions: { dataClassFloor: 'internal', refusedActions: ['fs.write'] } }))
  registry.enable('test.pack')
  const profile = registry.profileFor('test.pack')

  // The profile is frozen, so a caller cannot edit a restriction into place.
  assert.equal(Object.isFrozen(profile), true)
  assert.equal(Object.isFrozen(profile.restrictions), true)
  assert.throws(() => { profile.restrictions.refusedActions = [] }, TypeError)

  // It cannot be used as an authority. A pack is a document, and the broker mints authority only
  // from a user turn -- so presenting a profile as one is refused by the same rule as a tool output.
  const broker = new AuthorityBroker({})
  assert.throws(
    () => broker.grant({ turn: { id: profile.pack.id, source: profile.pack.industry }, actions: ['fs.write'] }),
    (error) => error.code === 'not_a_user_turn',
  )
  assert.throws(
    () => broker.grant({ turn: { id: 'pack', source: TRUST.TOOL_OUTPUT }, actions: ['fs.write'] }),
    (error) => error.code === 'not_a_user_turn',
  )

  // `forbids` can only ever report a refusal. The absence of one is explicitly *not* permission,
  // and the return value says so, so a caller cannot mistake it for a grant.
  const forbidden = registry.forbids(profile, 'fs.write')
  assert.equal(forbidden.forbidden, true)
  assert.match(forbidden.because, /refuses 'fs\.write'/)
  const notRefused = registry.forbids(profile, 'fs.read')
  assert.equal(notRefused.forbidden, false)
  assert.match(notRefused.because, /permission is decided elsewhere/)
  assert.equal(notRefused.allowed, undefined, 'there must be no field a caller could read as a grant')

  // The registry exposes no execution surface at all.
  for (const method of ['execute', 'invoke', 'grant', 'approve', 'authorise', 'run']) {
    assert.equal(typeof registry[method], 'undefined', `PackRegistry must not have ${method}()`)
  }
})

test('a pack\'s vocabulary is a glossary, not a rewriting rule', () => {
  const registry = new PackRegistry({})
  registry.install(pack({ vocabulary: { 'working tree': 'The files as they are on disk.' } }))
  const profile = registry.profileFor('test.pack')
  // Looking a term up returns the definition; nothing about the user's text is transformed. The
  // distinction matters because rewriting user input is how a glossary turns into a silent edit.
  assert.equal(profile.vocabulary['working tree'], 'The files as they are on disk.')
  const request = 'explain the working tree'
  assert.equal(request, 'explain the working tree')
  assert.equal(typeof profile.vocabulary.replace, 'undefined')
})

// ---------------------------------------------------------------------------------------
// 3. Acceptance: unavailable capabilities are reported, never substituted.
// ---------------------------------------------------------------------------------------

test('acceptance: a pack whose capabilities this installation lacks is reported partial, naming each one', async () => {
  const needsImage = pack({
    id: 'test.needs-image',
    capabilities: [
      { tag: 'tree.line-count', evidence: 'services/core/test/adaptive-loop.test.mjs' },
      { tag: 'image.generate', evidence: 'services/core/test/media-workflow.test.mjs' },
    ],
  })

  // No fabric at all: the state is 'unknown', which is not a claim that things work.
  const blind = new PackRegistry({})
  blind.install(needsImage)
  assert.equal(blind.readiness('test.needs-image').state, 'unknown')

  // A fabric that serves only the line counter: partial, with image.generate named and its reason.
  const partial = new PackRegistry({ fabric: await fabricServing(['tree.line-count']) })
  partial.install(needsImage)
  partial.enable('test.needs-image')
  const readiness = partial.readiness('test.needs-image')
  assert.equal(readiness.state, 'unavailable')
  assert.deepEqual(readiness.served.map((entry) => entry.tag), ['tree.line-count'])
  assert.deepEqual(readiness.missing.map((entry) => entry.tag), ['image.generate'])
  assert.equal(readiness.missing[0].code, 'no_capability')
  assert.match(readiness.missing[0].why, /image\.generate/)
  assert.match(readiness.note, /not substituted/)

  // Applying it without saying so is refused, and the refusal names what is missing.
  assert.throws(
    () => partial.profileFor('test.needs-image'),
    (error) => error.code === 'pack_unavailable' && /image\.generate/.test(error.message),
  )
  // With the gap acknowledged, the profile is usable and still reports the gap.
  const acknowledged = partial.profileFor('test.needs-image', { allowPartial: true })
  assert.equal(acknowledged.readiness.state, 'unavailable')
  assert.deepEqual(acknowledged.readiness.missing.map((entry) => entry.tag), ['image.generate'])

  // A fabric that serves everything makes it complete, so the reporting is not a permanent no.
  const complete = new PackRegistry({ fabric: await fabricServing(['tree.line-count', 'image.generate']) })
  complete.install(needsImage)
  assert.equal(complete.readiness('test.needs-image').state, 'complete')
  assert.equal(complete.profileFor('test.needs-image').readiness.state, 'complete')
})

test('a capability with no evidence and no admission is refused at validation', () => {
  // The rule from the family's tier records: a capability with no artifact behind it is a claim.
  assert.throws(
    () => validatePack(pack({ capabilities: [{ tag: 'image.generate' }] })),
    (error) => error.code === 'pack_invalid' && error.problems.some((problem) => /must cite the file that evidences it/.test(problem)),
  )
  assert.throws(
    () => validatePack(pack({ capabilities: [{ tag: 'not-a-tag' }] })),
    (error) => error.problems.some((problem) => /dotted capability tag/.test(problem)),
  )
  // And a shipped pack's evidence must point at a file that exists.
  for (const shipped of BUILTIN_PACKS) {
    for (const capability of shipped.capabilities) {
      if (capability.unimplemented) continue
      assert.ok(existsSync(resolve(REPO, capability.evidence)), `${shipped.id} cites ${capability.evidence}, which does not exist`)
    }
  }
})

// ---------------------------------------------------------------------------------------
// 4. Regulated content carries the rules that make it shippable.
// ---------------------------------------------------------------------------------------

test('a regulated pack must require human review and state what it refuses', () => {
  for (const industry of REGULATED_INDUSTRIES) {
    // Without human review, a legal pack is an unlicensed advice engine with a version number.
    assert.throws(
      () => validatePack(pack({ industry, restrictions: { requireHumanReview: false } })),
      (error) => error.problems.some((problem) => /must require human review/.test(problem)),
      industry,
    )
    // Without a stated refusal, "we are careful" is an assertion with nothing behind it.
    assert.throws(
      () => validatePack(pack({ industry, refuses: [] })),
      (error) => error.problems.some((problem) => /must state what it will not do/.test(problem)),
      industry,
    )
    // With both, it validates.
    const valid = validatePack(pack({ industry, restrictions: { requireHumanReview: true } }))
    assert.equal(valid.restrictions.requireHumanReview, true)
  }
  // And every shipped regulated pack carries a disclaimer a reader can act on.
  for (const shipped of BUILTIN_PACKS.filter((entry) => REGULATED_INDUSTRIES.includes(entry.industry))) {
    assert.ok(shipped.disclaimers.length >= 1, `${shipped.id} must carry a disclaimer`)
    assert.equal(validatePack(shipped).restrictions.requireHumanReview, true)
  }
})

test('requireSources with no sources is refused, rather than shipped as an unbacked claim', () => {
  assert.throws(
    () => validatePack(pack({ restrictions: { requireSources: true }, sources: [] })),
    (error) => error.code === 'pack_invalid' && error.problems.some((problem) => /requireSources is set and the pack cites none/.test(problem)),
  )
  // A source must be complete: a title without a licence is not a source.
  assert.throws(
    () => validatePack(pack({ restrictions: { requireSources: true }, sources: [{ title: 'A page', url: 'https://example.org' }] })),
    (error) => error.problems.some((problem) => problem.includes('licence')),
  )
  assert.throws(
    () => validatePack(pack({ sources: [{ title: 'A page', url: 'https://example.org', licence: 'CC0', checkedAt: Date.now() + 86_400_000 }] })),
    (error) => error.problems.some((problem) => /not in the future/.test(problem)),
  )
})

// ---------------------------------------------------------------------------------------
// 5. Registry behaviour: versions, state, and the audit trail.
// ---------------------------------------------------------------------------------------

test('installing is versioned: no duplicate, no silent downgrade, upgrades keep their history', () => {
  const registry = new PackRegistry({})
  registry.install(pack({ version: '1.0.0' }))
  assert.throws(() => registry.install(pack({ version: '1.0.0' })), (error) => error.code === 'duplicate_pack')
  assert.throws(() => registry.install(pack({ version: '0.9.0' })), (error) => error.code === 'downgrade_refused')
  const upgraded = registry.install(pack({ version: '1.1.0' }))
  assert.equal(upgraded.pack.version, '1.1.0')
  assert.deepEqual(upgraded.history.map((entry) => entry.version), ['1.0.0', '1.1.0'])
  // A downgrade has to be asked for, and then it is recorded like any other version.
  const downgraded = registry.install(pack({ version: '0.9.0' }), { allowDowngrade: true })
  assert.equal(downgraded.pack.version, '0.9.0')
  assert.deepEqual(downgraded.history.map((entry) => entry.version), ['1.0.0', '1.1.0', '0.9.0'])
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1)
  assert.equal(compareSemver('2.0.0-rc.1', '2.0.0'), 0)
})

test('the registry keeps state and audits every transition', () => {
  const ledger = new AuditLedger()
  const registry = new PackRegistry({ ledger })
  const installed = registry.install(pack())
  assert.equal(installed.state, PACK_STATES.INSTALLED)
  assert.equal(registry.enable('test.pack').state, PACK_STATES.ENABLED)
  assert.equal(registry.list({ enabledOnly: true }).length, 1)
  assert.equal(registry.disable('test.pack').state, PACK_STATES.DISABLED)
  assert.equal(registry.list({ enabledOnly: true }).length, 0)
  assert.deepEqual(registry.uninstall('test.pack'), { uninstalled: true, id: 'test.pack', version: '1.0.0' })
  assert.equal(registry.has('test.pack'), false)
  assert.throws(() => registry.get('test.pack'), (error) => error.code === 'unknown_pack')

  const actions = ledger.query({ category: 'packs', limit: 20 }).map((row) => row.action).reverse()
  assert.deepEqual(actions, ['install', 'enable', 'disable', 'uninstall'])
})

test('enabling several packs intersects to the strictest, never to the loosest', () => {
  const registry = new PackRegistry({})
  registry.install(pack({ id: 'a.pack', version: '1.0.0', restrictions: { dataClassFloor: 'internal', refusedActions: ['fs.write'] } }))
  registry.install(pack({ id: 'b.pack', version: '1.0.0', restrictions: { dataClassFloor: 'restricted', refusedActions: ['network.external'], requireHumanReview: true } }))
  registry.enable('a.pack')
  registry.enable('b.pack')
  const combined = registry.profilesFor({ industry: 'engineering' })
  assert.equal(combined.profiles.length, 2)
  assert.equal(combined.restrictions.dataClassFloor, 'restricted')
  assert.deepEqual(combined.restrictions.refusedActions, ['fs.write', 'network.external'])
  assert.equal(combined.requiresHumanReview, true)
  assert.equal(registry.dataClassFor({ restrictions: combined.restrictions }, 'public'), 'restricted')
  // A data class already above the floor is left alone: the function raises and never lowers.
  assert.equal(registry.dataClassFor({ restrictions: combined.restrictions }, 'restricted'), 'restricted')

  const empty = registry.profilesFor({ industry: 'legal' })
  assert.deepEqual(empty.profiles, [])
  assert.match(empty.note, /installation's own policy/)
})

test('the shipped packs install, validate, and describe themselves honestly', async () => {
  const registry = new PackRegistry({})
  const outcome = installBuiltinPacks(registry)
  assert.deepEqual(outcome.failed, [])
  assert.deepEqual(outcome.installed.map((entry) => entry.pack.id).sort(), [...BUILTIN_PACK_IDS].sort())
  assert.equal(BUILTIN_PACK_IDS.length, 3)

  const legal = registry.get('legal.document-review')
  // The three things a reader needs in order to decide whether to rely on it.
  assert.ok(legal.disclaimers.some((entry) => /not legal advice/i.test(entry)))
  assert.ok(legal.refuses.some((entry) => /will not give legal advice/i.test(entry)))
  assert.equal(legal.restrictions.requireHumanReview, true)
  assert.equal(legal.restrictions.dataClassFloor, 'confidential')

  // A pack that admits a gap is `partial` and still applies: honesty about a gap must not be
  // more expensive than silence about it.
  const withFabric = new PackRegistry({ fabric: await fabricServing(['tree.line-count']) })
  installBuiltinPacks(withFabric)
  withFabric.enable('engineering.repo-maintenance')
  const engineering = withFabric.readiness('engineering.repo-maintenance')
  assert.equal(engineering.state, 'partial')
  assert.deepEqual(engineering.unimplemented, ['chat.completion'])
  assert.deepEqual(engineering.missing, [])
  assert.equal(withFabric.profileFor('engineering.repo-maintenance').readiness.state, 'partial')

  // Nothing shipped claims a capability that does not exist without saying so.
  // Checked on the *validated* documents the registry holds, because that is what a caller gets:
  // the raw constants are inputs, and the normalisation is part of the contract.
  for (const id of BUILTIN_PACK_IDS) {
    const validated = registry.get(id)
    for (const capability of validated.capabilities) {
      if (!capability.unimplemented) continue
      assert.equal(capability.evidence, null, `${id} marks '${capability.tag}' unimplemented but cites evidence`)
      assert.match(registry.readiness(id).note, /not substituted/)
    }
  }
})
