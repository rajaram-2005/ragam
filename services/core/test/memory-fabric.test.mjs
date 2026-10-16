// The memory fabric. The test carrying the acceptance criterion is the third one: a user claim
// and a verified fact are stored, both are retrievable, and the two are distinguishable in the
// record itself rather than by convention in the caller. The rest of the file is the refusals,
// because a fabric is judged by what it will not store.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  ASSERTION_KINDS, CONFIDENCE_BASIS, LAYERS, MemoryFabric, PROVENANCE_KINDS,
  SCOPE_KINDS, VERIFICATION_STATUS, referencesFrom,
} from '../src/memory/fabric.mjs'
import { SkillRegistry } from '../src/skills/registry.mjs'
import { proposeFromExperience } from '../src/skills/lifecycle.mjs'
import { EpisodeLog, OUTCOMES } from '../src/adaptive/episodes.mjs'

const cleanup = []
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }) })

function tempFile(name) {
  const dir = mkdtempSync(join(tmpdir(), `fabric-${name}-`))
  cleanup.push(dir)
  return join(dir, 'memory.sqlite')
}

const claim = (overrides = {}) => ({
  layer: LAYERS.SEMANTIC,
  content: 'the release is cut on Fridays',
  subject: 'release',
  predicate: 'cadence',
  value: 'weekly-friday',
  assertion: { kind: ASSERTION_KINDS.CLAIMED, by: 'user' },
  provenance: [{ kind: PROVENANCE_KINDS.USER_STATEMENT, source: 'turn-42', digest: 'a'.repeat(64) }],
  ...overrides,
})

const fact = (overrides = {}) => ({
  layer: LAYERS.SEMANTIC,
  content: 'services/core contains 68 .mjs source files',
  subject: 'services/core',
  predicate: 'source-files',
  value: '68',
  assertion: { kind: ASSERTION_KINDS.OBSERVED, by: 'line-count-materialise', },
  provenance: [
    { kind: PROVENANCE_KINDS.OBSERVATION, source: 'line-count-materialise', detail: { files: 68 } },
    { kind: PROVENANCE_KINDS.CHECK, source: 'line-count-stream', detail: { agreed: true, method: 'independent recomputation' } },
  ],
  ...overrides,
})

// --- the acceptance criterion -------------------------------------------------------

test('a user claim and a verified fact are stored, retrievable, and distinguishable', () => {
  const fabric = new MemoryFabric()
  const claimed = fabric.remember(claim())
  const verified = fabric.remember(fact())
  assert.notEqual(claimed.id, verified.id)

  const recalled = fabric.recall({ layers: [LAYERS.SEMANTIC] })
  assert.equal(recalled.entries.length, 2, 'both are retrievable')
  const byId = new Map(recalled.entries.map((entry) => [entry.id, entry]))

  // The distinction is in the record, not in the reader's head.
  const storedClaim = byId.get(claimed.id)
  assert.equal(storedClaim.assertion.kind, ASSERTION_KINDS.CLAIMED)
  assert.equal(storedClaim.assertion.by, 'user')
  assert.equal(storedClaim.verification.status, VERIFICATION_STATUS.UNVERIFIED)
  assert.equal(storedClaim.verification.verified, false)
  assert.equal(storedClaim.verification.by, null, 'nothing verified it, and the field says nothing rather than somebody')
  assert.equal(storedClaim.confidence.value, null, 'a claim carries no truth number at all')
  assert.equal(storedClaim.confidence.basis, CONFIDENCE_BASIS.USER_STATED)
  assert.match(storedClaim.confidence.note, /records that it was said, not that it is true/)

  const storedFact = byId.get(verified.id)
  assert.equal(storedFact.verification.status, VERIFICATION_STATUS.VERIFIED)
  assert.equal(storedFact.verification.by, 'line-count-stream')
  assert.equal(storedFact.verification.method, 'independent recomputation')
  assert.equal(storedFact.confidence.value, 1)
  assert.equal(storedFact.confidence.basis, CONFIDENCE_BASIS.CHECKED)
  assert.equal(storedFact.confidence.note, undefined, 'a verified fact does not carry the claim caveat')

  // The check is a provenance row too, so the evidence survives the entry's own summary of it.
  assert.deepEqual(storedFact.provenance.map((record) => record.kind), [PROVENANCE_KINDS.OBSERVATION, PROVENANCE_KINDS.CHECK])
  assert.equal(storedFact.provenance[1].detail.agreed, true)

  // And a caller can ask for only what was checked.
  const checked = fabric.recall({ layers: [LAYERS.SEMANTIC], verifiedOnly: true })
  assert.deepEqual(checked.entries.map((entry) => entry.id), [verified.id])
  assert.equal(fabric.inspect().verified, 1)
  assert.equal(fabric.inspect().unverified, 1)
})

test('deleting an entry removes its provenance, and the tombstone keeps no content', () => {
  const fabric = new MemoryFabric()
  const stored = fabric.remember(claim({ content: 'a thing that must not survive deletion' }))
  assert.equal(fabric.provenanceOf(stored.id).length, 1)

  const deleted = fabric.forget(stored.id, { actor: 'user', reason: 'the user asked for it to be removed' })
  assert.equal(deleted.provenanceRemoved, 1)

  // Nothing about the entry is retrievable, in any direction.
  assert.equal(fabric.get(stored.id), null)
  assert.deepEqual(fabric.provenanceOf(stored.id), [], 'the provenance went with the entry')
  assert.deepEqual(fabric.recall({ layers: [LAYERS.SEMANTIC] }).entries, [])
  assert.equal(fabric.inspect().entries, 0)
  assert.equal(fabric.inspect().provenanceRecords, 0)

  const tombstones = fabric.tombstones()
  assert.equal(tombstones.length, 1)
  assert.equal(tombstones[0].entryId, stored.id, 'the tombstone says what was deleted')
  assert.equal(tombstones[0].actor, 'user')
  assert.match(tombstones[0].reason, /asked for it to be removed/)
  assert.equal(tombstones[0].provenanceRemoved, 1)
  // And it keeps none of the content: search the whole database for the deleted text.
  const rows = fabric.db.prepare('SELECT * FROM fabric_tombstones').all()
  assert.ok(!JSON.stringify(rows).includes('must not survive'), 'the tombstone must not contain the deleted content')
  assert.ok(!JSON.stringify(rows).includes('release'), 'nor the deleted subject')

  assert.throws(() => fabric.forget(stored.id), (error) => error.code === 'not_found')
  assert.throws(() => fabric.forget(fabric.remember(claim({ content: 'other' })).id, { reason: '  ' }), (error) => error.code === 'missing_reason')
})

// --- provenance ---------------------------------------------------------------------

test('an entry with no provenance is refused', () => {
  const fabric = new MemoryFabric()
  assert.throws(() => fabric.remember(claim({ provenance: [] })), (error) => {
    assert.equal(error.code, 'missing_provenance')
    assert.match(error.message, /where it came from/)
    return true
  })
  assert.throws(() => fabric.remember(claim({ provenance: [{ kind: 'vibes', source: 'somewhere' }] })), (error) => error.code === 'invalid_provenance_kind')
  assert.throws(() => fabric.remember(claim({ provenance: [{ kind: PROVENANCE_KINDS.USER_STATEMENT }] })), (error) => error.code === 'missing_provenance_source')
  assert.throws(() => fabric.remember(claim({ content: '   ' })), (error) => error.code === 'empty_content')
  assert.throws(() => fabric.remember(claim({ layer: 'vibes' })), (error) => error.code === 'unknown_layer')
  assert.throws(() => fabric.remember(claim({ assertion: { kind: 'claimed' } })), (error) => error.code === 'missing_assertor')
  assert.throws(() => fabric.remember(claim({ scope: { kind: 'session' } })), (error) => error.code === 'missing_scope_id')
  assert.throws(() => fabric.remember(claim({ scope: { kind: 'universe' } })), (error) => error.code === 'invalid_scope')
})

test('a check that did not agree, or a check by the assertor, cannot verify anything', () => {
  const fabric = new MemoryFabric()
  assert.throws(
    () => fabric.remember(fact({ provenance: [
      { kind: PROVENANCE_KINDS.OBSERVATION, source: 'line-count-materialise' },
      { kind: PROVENANCE_KINDS.CHECK, source: 'line-count-stream', detail: { agreed: false } },
    ] })),
    (error) => {
      assert.equal(error.code, 'check_disagreed')
      assert.match(error.message, /record it as a refutation or not at all/)
      return true
    },
  )
  assert.throws(
    () => fabric.remember(fact({ assertion: { kind: ASSERTION_KINDS.OBSERVED, by: 'line-count-stream' }, provenance: [
      { kind: PROVENANCE_KINDS.OBSERVATION, source: 'line-count-stream' },
      { kind: PROVENANCE_KINDS.CHECK, source: 'line-count-stream', detail: { agreed: true } },
    ] })),
    (error) => {
      assert.equal(error.code, 'self_verification')
      assert.match(error.message, /cannot verify its own assertion/)
      return true
    },
  )
})

test('a confidence number must be explained, and an inference must name what it came from', () => {
  const fabric = new MemoryFabric()
  const base = fabric.remember(fact())
  assert.throws(() => fabric.remember(claim({ confidence: { value: 0.9, basis: CONFIDENCE_BASIS.USER_STATED } })), (error) => {
    assert.equal(error.code, 'no_truth_estimate_for_claim')
    return true
  })
  assert.throws(() => fabric.remember(claim({ confidence: { value: 0.7, basis: CONFIDENCE_BASIS.INFERRED } })), (error) => error.code === 'missing_inference_source')
  assert.throws(
    () => fabric.remember(claim({ confidence: { value: 0.7, basis: CONFIDENCE_BASIS.INFERRED, from: ['mem_does-not-exist'] } })),
    (error) => {
      assert.equal(error.code, 'unknown_inference_source')
      assert.match(error.message, /cannot rest on an entry that was never recorded/)
      return true
    },
  )
  assert.throws(() => fabric.remember(claim({ confidence: { value: 2, basis: CONFIDENCE_BASIS.MEASURED } })), (error) => error.code === 'invalid_confidence')
  assert.throws(() => fabric.remember(claim({ confidence: { value: 0.5, basis: CONFIDENCE_BASIS.MEASURED } })), (error) => {
    assert.equal(error.code, 'unmeasured_confidence')
    return true
  })
  assert.throws(() => fabric.remember(claim({ confidence: { value: 0.5, basis: CONFIDENCE_BASIS.CHECKED } })), (error) => error.code === 'unchecked_confidence')
  assert.throws(() => fabric.remember(claim({ confidence: { value: 0.5, basis: 'gut-feel' } })), (error) => error.code === 'invalid_confidence_basis')

  // A measured confidence needs a measurement in the provenance, and then it is accepted.
  const measured = fabric.remember({
    layer: LAYERS.PROJECT,
    content: 'the tree is 3.6 MB',
    assertion: { kind: ASSERTION_KINDS.OBSERVED, by: 'line-count-materialise' },
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: 'line-count-materialise', detail: { bytes: 3774873 } }],
    confidence: { value: 0.99, basis: CONFIDENCE_BASIS.MEASURED },
  })
  assert.equal(measured.confidence.value, 0.99)

  // An inference cites its sources, and both are readable from the entry.
  const inferred = fabric.remember(claim({
    content: 'releases are usually cut late in the week',
    confidence: { value: 0.6, basis: CONFIDENCE_BASIS.INFERRED, from: [base.id, measured.id] },
  }))
  assert.deepEqual(inferred.confidence.from, [base.id, measured.id])
})

// --- duplicates and contradictions ---------------------------------------------------

test('the same content from two sources is one entry with two provenances', () => {
  const fabric = new MemoryFabric()
  const first = fabric.remember(claim({ provenance: [{ kind: PROVENANCE_KINDS.USER_STATEMENT, source: 'turn-42' }] }))
  const second = fabric.remember(claim({ provenance: [{ kind: PROVENANCE_KINDS.USER_STATEMENT, source: 'turn-77' }] }))
  assert.equal(second.id, first.id, 'a duplicate collapses onto the entry that already existed')
  assert.equal(second.duplicate, true)
  assert.equal(second.seenCount, 2)
  assert.deepEqual(second.provenance.map((record) => record.source).sort(), ['turn-42', 'turn-77'])
  assert.equal(second.provenance.filter((record) => record.kind === PROVENANCE_KINDS.DUPLICATE_SOURCE).length, 1)
  assert.equal(fabric.recall({ layers: [LAYERS.SEMANTIC] }).entries.length, 1)
  assert.equal(fabric.inspect().entries, 1)
  assert.equal(fabric.inspect().provenanceRecords, 2)
})

test('two entries that disagree are both kept, listed, and each marked with what it contradicts', () => {
  const fabric = new MemoryFabric()
  const friday = fabric.remember(claim())
  const monday = fabric.remember(claim({ content: 'the release is cut on Mondays', value: 'weekly-monday' }))

  const conflicts = fabric.conflicts()
  assert.equal(conflicts.length, 1)
  assert.deepEqual([...conflicts[0].values].sort(), ['weekly-friday', 'weekly-monday'])
  assert.deepEqual([...conflicts[0].members].sort(), [friday.id, monday.id].sort())
  assert.equal(conflicts[0].subject, 'release')

  const recalled = fabric.recall({ layers: [LAYERS.SEMANTIC] })
  for (const entry of recalled.entries) {
    assert.equal(entry.contradicts.length, 1, 'each side names the other')
  }
  // Nothing was overwritten and nothing was resolved on the fabric's own initiative.
  assert.equal(fabric.inspect().live, 2)
  assert.equal(fabric.inspect().conflicts, 1)
})

test('resolving a conflict supersedes the loser, keeps it readable, and refuses to downgrade a verified fact', () => {
  const fabric = new MemoryFabric()
  const claimed = fabric.remember(claim())
  const verified = fabric.remember(fact({ subject: 'release', predicate: 'cadence', value: 'weekly-friday' }))
  assert.equal(fabric.conflicts().length, 0, 'a claim and a fact that agree in value do not conflict')

  const otherClaim = fabric.remember(claim({ content: 'the release is cut on Mondays', value: 'weekly-monday' }))
  assert.throws(() => fabric.resolve(claimed.id, otherClaim.id, { reason: '' }), (error) => error.code === 'missing_reason')

  // Resolving quietly is allowed between two claims; the loser stays readable.
  const resolved = fabric.resolve(claimed.id, otherClaim.id, { reason: 'the user corrected themselves on turn 88', actor: 'user' })
  assert.equal(resolved.kept, claimed.id)
  const loser = fabric.get(otherClaim.id)
  assert.equal(loser.supersededBy, claimed.id)
  assert.equal(loser.content, 'the release is cut on Mondays', 'the superseded version is not deleted')
  assert.deepEqual(fabric.recall({ layers: [LAYERS.SEMANTIC] }).entries.map((entry) => entry.id).sort(), [claimed.id, verified.id].sort())
  assert.equal(fabric.recall({ layers: [LAYERS.SEMANTIC], includeSuperseded: true }).entries.length, 3)

  // Replacing a verified fact with a claim is refused unless it is forced with a reason.
  const contradictionToVerified = fabric.remember(claim({ content: 'the source file count is 70', subject: 'services/core', predicate: 'source-files', value: '70' }))
  assert.throws(
    () => fabric.resolve(contradictionToVerified.id, verified.id, { reason: 'the user says so' }),
    (error) => {
      assert.equal(error.code, 'would_downgrade')
      assert.match(error.message, /refusing to replace verified entry/)
      return true
    },
  )
  const forced = fabric.resolve(contradictionToVerified.id, verified.id, { reason: 'the measurement was taken on a different revision', force: true })
  assert.equal(forced.forced, true)
  assert.equal(fabric.get(verified.id).supersededBy, contradictionToVerified.id)
})

// --- versions ------------------------------------------------------------------------

test('a correction appends a version, keeps the previous one readable, and needs a reason', () => {
  const fabric = new MemoryFabric()
  const original = fabric.remember(claim())
  assert.throws(() => fabric.correct(original.id, { content: 'changed' }), (error) => error.code === 'missing_reason')

  const corrected = fabric.correct(original.id, { content: 'the release is cut on Thursdays', value: 'weekly-thursday', reason: 'the team moved the cut day', actor: 'user' })
  assert.equal(corrected.supersedes, original.id)
  assert.equal(corrected.version, 2)
  assert.equal(corrected.correctionReason, 'the team moved the cut day')
  assert.equal(corrected.replaced.verification, VERIFICATION_STATUS.UNVERIFIED)

  const history = fabric.history(original.id)
  assert.deepEqual(history.map((entry) => entry.version), [1, 2])
  assert.deepEqual(history.map((entry) => entry.content), ['the release is cut on Fridays', 'the release is cut on Thursdays'])
  assert.equal(history[0].supersededBy, history[1].id)
  assert.equal(history[1].supersedes, history[0].id)

  // The live view shows the current belief; the versioned view shows both.
  const live = fabric.recall({ layers: [LAYERS.SEMANTIC] })
  assert.deepEqual(live.entries.map((entry) => entry.content), ['the release is cut on Thursdays'])
  assert.equal(fabric.recall({ layers: [LAYERS.SEMANTIC], includeSuperseded: true }).entries.length, 2)

  // The correction carries the reason in its provenance, so the "why" survives the entry.
  assert.ok(fabric.provenanceOf(corrected.id).some((record) => record.detail?.reason === 'the team moved the cut day'))
  assert.throws(() => fabric.correct('mem_missing', { content: 'x', reason: 'y' }), (error) => error.code === 'not_found')
})

test('a whole correction chain is walkable from either end', () => {
  const fabric = new MemoryFabric()
  const first = fabric.remember(claim())
  const second = fabric.correct(first.id, { content: 'cut on Thursday', value: 'thursday', reason: 'one' })
  const third = fabric.correct(second.id, { content: 'cut on Wednesday', value: 'wednesday', reason: 'two' })
  const fromFirst = fabric.history(first.id)
  const fromLast = fabric.history(third.id)
  assert.deepEqual(fromFirst.map((entry) => entry.id), [first.id, second.id, third.id])
  assert.deepEqual(fromLast.map((entry) => entry.id), [first.id, second.id, third.id])
  assert.equal(fabric.history(third.id).length, 3)
})

// --- scope, permission and layers -----------------------------------------------------

test('scope is enforced on read, and the working layer is never part of a long-term recall', () => {
  const fabric = new MemoryFabric()
  const sessionEntry = fabric.remember(claim({ content: 'mid-task note', scope: { kind: 'session', id: 's-1' } }))
  const projectEntry = fabric.remember(claim({ content: 'project fact', scope: { kind: 'project', id: 'ragam' } }))
  const working = fabric.remember(claim({ layer: LAYERS.WORKING, content: 'scratch: 12 files so far', scope: { kind: 'session', id: 's-1' } }))

  const sessionView = fabric.recall({ scope: { kind: 'session', id: 's-1' }, layers: [LAYERS.SEMANTIC, LAYERS.WORKING] })
  assert.deepEqual(sessionView.entries.map((entry) => entry.id).sort(), [sessionEntry.id, working.id].sort())
  const projectView = fabric.recall({ scope: { kind: 'project', id: 'ragam' } })
  assert.deepEqual(projectView.entries.map((entry) => entry.id), [projectEntry.id])

  // The session-scoped entry is visible to a project recall only when that scope is named.
  const widened = fabric.recall({ scope: { kind: 'project', id: 'ragam' }, allowScopes: [{ kind: 'session', id: 's-1' }] })
  assert.equal(widened.entries.length, 2)
  assert.ok(widened.denied.length >= 0)

  // A scoped recall reports what it did not look at, with the reason, rather than leaving the
  // caller to guess whether the absence meant "nothing" or "not asked for".
  assert.ok(projectView.denied.some((denied) => denied.id === sessionEntry.id && /scope session:s-1 was not asked for/.test(denied.reason)))
  // `denied` means "matched the request but was withheld", not "exists and was not requested":
  // the working entry is a different *layer* from the one asked for, so it is not denied -- it was
  // never in scope of the question. Keeping those two apart is what stops a denial list from
  // reading as "the system is hiding things" when the caller simply asked a narrower question.
  assert.ok(!projectView.denied.some((denied) => denied.id === working.id))
  assert.equal(projectView.deniedCount, projectView.denied.length)

  // Without a scope the caller is asking for everything it may read -- every layer except working
  // memory -- and nothing is denied, because nothing was out of bounds.
  const never = fabric.recall({})
  assert.ok(!never.entries.some((entry) => entry.layer === LAYERS.WORKING), 'working memory is not long-term memory')
  assert.deepEqual(never.entries.map((entry) => entry.id).sort(), [sessionEntry.id, projectEntry.id].sort())
  assert.deepEqual(never.denied, [], 'an unrestricted recall denies nothing on scope grounds')
  assert.equal(never.deniedCount, 0)

  const cleared = fabric.clearWorking({ kind: 'session', id: 's-1' })
  assert.equal(cleared.entriesRemoved, 1)
  assert.equal(cleared.provenanceRemoved, 1)
  assert.equal(fabric.inspect().byLayer[LAYERS.WORKING], 0)
})

test('an entry whose readers do not include the asker is not returned, and export is opt-in per entry', () => {
  const fabric = new MemoryFabric()
  const privateEntry = fabric.remember(claim({ content: 'a private note', permission: { readers: ['owner'], exportable: false } }))
  const shared = fabric.remember(claim({ content: 'a shared note', permission: { readers: ['owner', 'project-ragam'], exportable: true } }))

  const asOwner = fabric.recall({})
  assert.equal(asOwner.entries.length, 2)
  const asOther = fabric.recall({ as: 'project-ragam' })
  assert.deepEqual(asOther.entries.map((entry) => entry.id), [shared.id])
  assert.ok(asOther.denied.some((denied) => denied.id === privateEntry.id && /not a permitted reader/.test(denied.reason)))

  const exported = fabric.exportAll()
  assert.deepEqual(exported.entries.map((entry) => entry.id), [shared.id])
  assert.equal(exported.notExportable, 1)
  assert.match(exported.note, /not exportable and are not in this export at all/)
  const foreign = fabric.exportAll({ as: 'someone-else' })
  assert.deepEqual(foreign.entries, [])
  assert.equal(foreign.withheld.length, 1)
})

test('all seven layers exist, and a skill, episode or failure entry points at the system that owns it', () => {
  assert.deepEqual(Object.values(LAYERS), ['working', 'episodic', 'semantic', 'preference', 'project', 'skill', 'failure'])
  assert.deepEqual(SCOPE_KINDS, ['session', 'project', 'user', 'global'])

  const skills = new SkillRegistry({ now: () => 1_700_000_000_000 })
  proposeFromExperience(skills, {
    name: 'line-count-stream',
    failureCategory: 'inefficient-route',
    attempted: 'counted lines by materialising every file',
    observed: 'streaming was 1.6x faster above 32 KB per file',
    correction: 'stream the file in chunks and count newline bytes',
    verifiedSolution: 'two independent implementations agreed on the same tree',
    version: '0.1.0',
  })
  const episodes = new EpisodeLog(':memory:')
  const episode = episodes.append({ kind: 'task', outcome: OUTCOMES.SUCCESS, verification: { agree: true } })

  const fabric = new MemoryFabric(':memory:', { referenceExists: referencesFrom({ skills, episodes }) })
  const skillEntry = fabric.remember({
    layer: LAYERS.SKILL,
    content: 'line counting is faster streamed above ~32 KB per file',
    reference: { kind: 'skill', name: 'line-count-stream', version: '0.1.0' },
    provenance: [{ kind: PROVENANCE_KINDS.DERIVED, source: 'adaptive-loop', digest: 'b'.repeat(64) }],
  })
  assert.equal(skillEntry.reference.kind, 'skill')
  assert.equal(skillEntry.reference.checked, true, 'the pointer was confirmed to exist')

  const episodic = fabric.remember({
    layer: LAYERS.EPISODIC,
    content: 'counted 4218 lines across 37 files',
    reference: { kind: 'episode', seq: episode.seq, digest: episode.digest },
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: 'line-count-stream', digest: episode.digest }],
  })
  assert.equal(episodic.reference.seq, episode.seq)

  const failure = fabric.remember({
    layer: LAYERS.FAILURE,
    content: 'the streaming counter lost to the baseline on a many-small-files tree',
    reference: { kind: 'episode', seq: episode.seq, digest: episode.digest },
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: 'adaptive-loop', detail: { diagnosis: 'shape-mismatch' } }],
  })
  assert.equal(failure.layer, LAYERS.FAILURE)

  // A reference to something that is not there is refused, and the entry is not stored.
  assert.throws(
    () => fabric.remember({
      layer: LAYERS.SKILL,
      content: 'a procedure nobody wrote',
      reference: { kind: 'skill', name: 'no-such-skill', version: '9.9.9' },
      provenance: [{ kind: PROVENANCE_KINDS.DERIVED, source: 'invented' }],
    }),
    (error) => {
      assert.equal(error.code, 'unknown_reference')
      assert.match(error.message, /does not exist/)
      return true
    },
  )
  assert.equal(fabric.recall({ layers: [LAYERS.SKILL] }).entries.length, 1, 'the refused entry was not stored')
  assert.deepEqual(fabric.inspect().byLayer, { working: 0, episodic: 1, semantic: 0, preference: 0, project: 0, skill: 1, failure: 1 })
})

test('a reference with no checker is stored and marked unchecked rather than assumed good', () => {
  const fabric = new MemoryFabric()
  const entry = fabric.remember({
    layer: LAYERS.SKILL,
    content: 'a procedure from another installation',
    reference: { kind: 'skill', name: 'imported-procedure', version: '2.0.0' },
    provenance: [{ kind: PROVENANCE_KINDS.DERIVED, source: 'import' }],
  })
  assert.equal(entry.reference.checked, false)
  assert.match(entry.reference.note, /no reference checker was configured, so this pointer was not confirmed/)
  assert.throws(() => fabric.remember({
    layer: LAYERS.SKILL, content: 'no kind', reference: { name: 'x' },
    provenance: [{ kind: PROVENANCE_KINDS.DERIVED, source: 'import' }],
  }), (error) => error.code === 'invalid_reference')
})

// --- persistence and long-term shape ---------------------------------------------------

test('entries, versions, provenance and tombstones survive a reopen', () => {
  const file = tempFile('persist')
  const first = new MemoryFabric(file)
  const original = first.remember(claim())
  const corrected = first.correct(original.id, { content: 'cut on Thursday', value: 'thursday', reason: 'moved' })
  const deleted = first.remember(claim({ content: 'temporary note', scope: { kind: 'session', id: 's-9' } }))
  first.forget(deleted.id, { reason: 'session ended' })
  first.close()

  const reopened = new MemoryFabric(file)
  assert.equal(reopened.get(original.id).content, 'the release is cut on Fridays')
  assert.equal(reopened.get(corrected.id).version, 2)
  assert.equal(reopened.history(original.id).length, 2)
  assert.deepEqual(reopened.provenanceOf(original.id).map((record) => record.source), ['turn-42'])
  assert.equal(reopened.tombstones().length, 1)
  assert.equal(reopened.tombstones()[0].entryId, deleted.id)
  assert.equal(reopened.get(deleted.id), null)
  assert.equal(reopened.inspect().live, 1)
  reopened.close()
})

test('recollection can be asked what was believed at a point in time', () => {
  let clock = 1_700_000_000_000
  const fabric = new MemoryFabric(':memory:', { now: () => clock })
  const original = fabric.remember(claim())
  clock += 1000
  const corrected = fabric.correct(original.id, { content: 'cut on Thursday', value: 'thursday', reason: 'moved' })
  clock += 1000

  const before = fabric.recall({ layers: [LAYERS.SEMANTIC], asOf: original.createdAt })
  assert.deepEqual(before.entries.map((entry) => entry.content), ['the release is cut on Fridays'])
  const after = fabric.recall({ layers: [LAYERS.SEMANTIC] })
  assert.deepEqual(after.entries.map((entry) => entry.content), ['cut on Thursday'])
  assert.equal(fabric.history(corrected.id).length, 2)
})

test('the fabric never marks memory as training data, and says so in its own inspection', () => {
  const fabric = new MemoryFabric()
  fabric.remember(claim())
  const row = fabric.db.prepare('SELECT training_use FROM fabric_entries LIMIT 1').get()
  assert.equal(row.training_use, 'prohibited')
  assert.match(fabric.inspect().trainingUse, /prohibited for every entry, enforced by a CHECK/)
  // The constraint is in the database, not in a comment: a direct write of any other value fails.
  assert.throws(() => fabric.db.prepare('UPDATE fabric_entries SET training_use = ?').run('allowed'), /CHECK constraint failed/)
})

test('an unknown layer or an unlistable scope is refused rather than ignored', () => {
  const fabric = new MemoryFabric()
  fabric.remember(claim())
  assert.throws(() => fabric.recall({ layers: ['semantic', 'astrology'] }), (error) => error.code === 'unknown_layer')
  assert.throws(() => fabric.recall({ scope: { kind: 'galaxy' } }), (error) => error.code === 'invalid_scope')
  assert.equal(fabric.recall().entries.length, 1)
  assert.equal(fabric.recall({ layers: [] }).entries.length, 0, 'an empty layer list asks for nothing')
})
