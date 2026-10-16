// The bridge. The load-bearing test is the first one: a memory the user approved enters the
// fabric as a claim with no truth estimate, no matter what the store's own `kind` column calls it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { MemoryStore } from '../src/memory/store.mjs'
import { ASSERTION_KINDS, CONFIDENCE_BASIS, LAYERS, MemoryFabric, PROVENANCE_KINDS } from '../src/memory/fabric.mjs'
import { BridgeError, bridgeStatus, importApprovedMemories, proposeToStore } from '../src/memory/bridge.mjs'

const cleanup = []
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }) })

function pair() {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'))
  cleanup.push(dir)
  const store = new MemoryStore(join(dir, 'memory.sqlite'))
  const fabric = new MemoryFabric(join(dir, 'fabric.sqlite'), { now: () => 1_700_000_000_000 })
  return { store, fabric }
}

function approved(store, text, { kind = 'fact', subject = null } = {}) {
  const candidate = store.propose({ text, rationale: 'the user said so', proposedFrom: 'conversation' })
  const decided = store.decideCandidate(candidate.id, { approve: true, kind, subject })
  assert.equal(decided.approved, true, 'the test fixture must really have approved a memory')
  return decided.memory
}

test('an approved memory becomes a claim in the fabric, never a verified fact', () => {
  const { store, fabric } = pair()
  const memory = approved(store, 'the deploy window is Thursday 02:00 UTC', { kind: 'fact', subject: 'deploy' })
  // The store calls it a fact and the database records that the *user* approved it.
  assert.equal(store.getMemory(memory.id).kind, 'fact')
  assert.equal(store.getMemory(memory.id).approvedBy, 'user')

  const result = importApprovedMemories(store, fabric)
  assert.equal(result.considered, 1)
  assert.equal(result.imported.length, 1)
  assert.match(result.note, /none of them is verified by having been approved/)

  const entry = fabric.get(result.imported[0].entryId)
  assert.equal(entry.assertion.kind, ASSERTION_KINDS.CLAIMED)
  assert.equal(entry.assertion.by, 'user')
  assert.equal(entry.verification.status, 'unverified', 'approval is permission, not verification')
  assert.equal(entry.confidence.value, null, 'and it carries no truth estimate')
  assert.equal(entry.confidence.basis, CONFIDENCE_BASIS.USER_STATED)
  const provenance = entry.provenance[0]
  assert.equal(provenance.kind, PROVENANCE_KINDS.IMPORTED_MEMORY)
  assert.equal(provenance.source, `memory:${memory.id}`)
  assert.match(provenance.detail.note, /approval is permission, not verification/)
  assert.equal(provenance.detail.kindInStore, 'fact', 'the store\'s own label is recorded, not adopted')
  assert.equal(fabric.recall({ verifiedOnly: true }).entries.length, 0, 'nothing imported is verified')
})

test('importing twice records that the user said it twice rather than creating a second belief', () => {
  const { store, fabric } = pair()
  approved(store, 'the release branch is cut from main')
  const first = importApprovedMemories(store, fabric)
  const second = importApprovedMemories(store, fabric)
  assert.equal(first.imported[0].entryId, second.imported[0].entryId)
  assert.equal(second.imported[0].duplicate, true)
  assert.equal(fabric.inspect().entries, 1)
  assert.equal(fabric.inspect().provenanceRecords, 2, 'two sources, one belief')
  assert.equal(fabric.get(first.imported[0].entryId).seenCount, 2)
})

test('the bridge cannot approve a memory on the user\'s behalf', () => {
  const { store, fabric } = pair()
  const entry = fabric.remember({
    layer: LAYERS.SEMANTIC,
    content: 'the CI job takes about 50 seconds',
    assertion: { kind: ASSERTION_KINDS.OBSERVED, by: 'github-actions' },
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: 'ci-run-1234', detail: { seconds: 50 } }],
    confidence: { basis: CONFIDENCE_BASIS.MEASURED, value: 0.9 },
  })
  const proposal = proposeToStore(fabric, entry.id, store)
  assert.equal(proposal.state, 'pending', 'a candidate, waiting for a person')
  assert.equal(proposal.fromEntry, entry.id)
  assert.match(proposal.note, /nothing reaches a prompt until the user approves it/)

  // The pending candidate is invisible to the prompt path, and there is no approved memory.
  assert.deepEqual(store.contextFor('CI job').memories.filter((memory) => memory.text.includes('CI job')), [])
  assert.deepEqual(store.listMemories({ status: 'approved' }).map((memory) => memory.text), [])
  assert.equal(store.listCandidates({ status: 'pending' }).length, 1)
  // The rationale carries the entry's verification status and provenance, so the person deciding
  // can see whether they are being asked about a measurement or a statement.
  const candidate = store.listCandidates({ status: 'pending' })[0]
  assert.match(candidate.rationale, /verification: unverified/)
  assert.match(candidate.rationale, /observation:ci-run-1234/)

  // Approving it is the user's act, and then it becomes a claim like any other.
  const decided = store.decideCandidate(candidate.id, { approve: true, kind: 'fact' })
  const reimported = importApprovedMemories(store, fabric)
  assert.equal(reimported.imported.length, 1)
  assert.equal(fabric.get(reimported.imported[0].entryId).verification.status, 'unverified')
  // The person's act is what made it a memory, and the row says so -- read back through the store
  // rather than from the return value, because the approval is a fact about the database.
  assert.equal(store.getMemory(decided.memory.id).approvedBy, 'user')
  const row = store.db.prepare('SELECT approved_by FROM memories WHERE id = ?').get(decided.memory.id)
  assert.equal(row.approved_by, 'user', 'and the database itself refuses any other value')
})

test('working memory is not offered as a durable memory, and a missing entry is named', () => {
  const { store, fabric } = pair()
  const working = fabric.remember({
    layer: LAYERS.WORKING,
    content: 'mid-task scratch: 12 of 40 files done',
    scope: { kind: 'session', id: 's-1' },
    provenance: [{ kind: PROVENANCE_KINDS.OBSERVATION, source: 'runner' }],
  })
  assert.throws(() => proposeToStore(fabric, working.id, store), (error) => {
    assert.equal(error.code, 'working_not_durable')
    assert.match(error.message, /scratch space and is not offered as a durable memory/)
    return true
  })
  assert.throws(() => proposeToStore(fabric, 'mem_missing', store), (error) => error.code === 'not_found')
  assert.equal(store.listCandidates({ status: 'pending' }).length, 0)
})

test('the status view reports the gap between what was approved and what the fabric has', () => {
  const { store, fabric } = pair()
  approved(store, 'the team uses TypeScript strict mode')
  approved(store, 'reviews happen on Tuesday afternoons')
  assert.deepEqual(bridgeStatus(store, fabric), {
    approvedMemories: 2,
    importedIntoFabric: 0,
    notYetImported: 2,
    pendingCandidates: 0,
    note: 'approval is permission; the fabric records each imported memory as a claim and never as a verified fact',
  })
  importApprovedMemories(store, fabric)
  const after = bridgeStatus(store, fabric)
  assert.equal(after.importedIntoFabric, 2)
  assert.equal(after.notYetImported, 0)
  assert.equal(after.note, bridgeStatus(store, fabric).note)
})

test('a memory deleted from the store leaves its claim behind in the fabric, and that is visible', () => {
  // The two systems have different deletion semantics on purpose: the store is the person's own
  // record and deletion is immediate and total, while the fabric records what the system believed
  // and when. This test pins the consequence so it is a known property rather than a surprise --
  // deleting in the store does not reach into the fabric, and a bridge that pretended otherwise
  // would report a deletion that did not happen.
  const { store, fabric } = pair()
  const memory = approved(store, 'the staging cluster is in eu-west-1')
  const imported = importApprovedMemories(store, fabric)
  store.forget(memory.id, { reason: 'the user asked for it' })
  assert.equal(store.getMemory(memory.id), null)
  const entry = fabric.get(imported.imported[0].entryId)
  assert.equal(entry.content, 'the staging cluster is in eu-west-1')
  assert.equal(entry.provenance[0].source, `memory:${memory.id}`, 'the provenance still names the deleted memory')
  // So the fabric offers its own deletion, and it removes the provenance too.
  const deleted = fabric.forget(entry.id, { actor: 'user', reason: 'the underlying memory was deleted' })
  assert.equal(deleted.provenanceRemoved, 1)
  assert.equal(fabric.get(entry.id), null)
  assert.equal(bridgeStatus(store, fabric).importedIntoFabric, 0, 'and the status view follows the deletion')
})

test('a bridge error is a named refusal, not a TypeError', () => {
  const { store, fabric } = pair()
  assert.ok(new BridgeError('x', 'y') instanceof BridgeError)
  const entry = fabric.remember({
    layer: LAYERS.PREFERENCE,
    content: 'prefers short answers',
    assertion: { kind: ASSERTION_KINDS.CLAIMED, by: 'user' },
    provenance: [{ kind: PROVENANCE_KINDS.USER_STATEMENT, source: 'turn-7' }],
  })
  const proposal = proposeToStore(fabric, entry.id, store, { rationale: 'asked in the first turn' })
  assert.equal(proposal.state, 'pending')
  const candidate = store.listCandidates({ status: 'pending' })[0]
  assert.match(candidate.rationale, /^asked in the first turn \| fabric entry/)
  assert.match(candidate.rationale, /provenance: user-statement:turn-7/)
})
