// Memory: approval, deletion, recall, and the distinctions §7 requires.
//
// The tests that matter are the negative ones. "A user-approved memory reaches a
// prompt" is not a property worth asserting on its own -- it is the thing the feature is
// for. "A memory that no user approved cannot reach a prompt, and cannot be written as
// training data even by raw SQL" is the property that keeps the feature honest, so that
// is what most of this file checks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  APPROVER, CANDIDATE_STATES, LIMITS, MEMORY_KINDS, MEMORY_MECHANISMS, MemoryError, MemoryStore,
} from '../src/memory/store.mjs'

const fresh = () => new MemoryStore(':memory:')

// --- remembering requires the user -------------------------------------------------

test('a memory is stored with the user as its approver and training use prohibited', () => {
  const store = fresh()
  const { memory } = store.remember({ text: 'Prefers concise answers.', kind: MEMORY_KINDS.PREFERENCE })
  assert.equal(memory.approvedBy, APPROVER)
  assert.equal(memory.consent, 'user_approved')
  assert.equal(memory.purpose, 'personal_context')
  assert.equal(memory.trainingUse, 'prohibited')
  assert.equal(memory.status, 'approved')
})

test('the schema refuses an approval that did not come from the user', () => {
  // The application never writes this, but a future caller might. The point of putting
  // the rule in the schema is that "we do not do that" becomes "the database will not
  // let us".
  const store = fresh()
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO memories (id, text, kind, tags, status, approved_by, approved_at, created_at, updated_at,
         source_kind, data_class, consent, purpose, training_use)
       VALUES ('x', 'the agent decided this', 'fact', '[]', 'approved', 'agent', 1, 1, 1, 'agent', 'internal',
         'user_approved', 'personal_context', 'prohibited')`,
    ).run(),
    /CHECK|constraint/i,
  )
})

test('the schema refuses to write a memory as training data', () => {
  const store = fresh()
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO memories (id, text, kind, tags, status, approved_by, approved_at, created_at, updated_at,
         source_kind, data_class, consent, purpose, training_use)
       VALUES ('y', 'training corpus candidate', 'fact', '[]', 'approved', 'user', 1, 1, 1, 'user', 'internal',
         'user_approved', 'personal_context', 'permitted')`,
    ).run(),
    /CHECK|constraint/i,
  )
  // And there is no API that offers a different value for either column.
  assert.equal(APPROVER, 'user')
  const source = readFileSync(new URL('../src/memory/store.mjs', import.meta.url), 'utf8')
  assert.ok(!/training_use\s*[:=]\s*['"](?!prohibited)/.test(source),
    'no code path may write a training_use other than prohibited')
})

test('a memory longer than the limit is refused, with the reason a memory is not a document', () => {
  const store = fresh()
  assert.throws(
    () => store.remember({ text: 'x'.repeat(LIMITS.maxMemoryChars + 1) }),
    (error) => error instanceof MemoryError && error.code === 'too_long'
      && /put documents in the knowledge store/.test(error.message),
  )
  assert.equal(store.remember({ text: 'x'.repeat(LIMITS.maxMemoryChars) }).duplicate, false)
})

test('an empty memory and an unknown kind are refused', () => {
  const store = fresh()
  assert.throws(() => store.remember({ text: '   ' }), (error) => error.code === 'text_required')
  assert.throws(() => store.remember({ text: 'ok', kind: 'vibe' }), (error) => error.code === 'unknown_kind')
})

test('the same memory twice is deduplicated rather than duplicated', () => {
  const store = fresh()
  const first = store.remember({ text: 'Deploys on Fridays are avoided.' })
  const second = store.remember({ text: 'Deploys on Fridays are avoided.' })
  assert.equal(second.duplicate, true)
  assert.equal(second.memory.id, first.memory.id)
  assert.equal(store.stats().memories, 1)
})

test('the store refuses to grow past its limit instead of evicting silently', () => {
  const store = new MemoryStore(':memory:', { limits: { maxMemories: 3 } })
  for (let i = 0; i < 3; i++) store.remember({ text: `memory ${i}` })
  assert.throws(
    () => store.remember({ text: 'one too many' }),
    (error) => error.code === 'memory_limit' && /Nothing was deleted to make room/.test(error.message),
  )
  assert.equal(store.stats().memories, 3, 'the existing memories are untouched')
})

// --- the central guarantee: a candidate is not memory ------------------------------

test('a proposed candidate is invisible to a prompt and to memory search, even on an exact match', () => {
  const store = fresh()
  const candidate = store.propose({
    text: 'The user works in Chennai.',
    rationale: 'stated a location while asking about weather',
    proposedFrom: 'conversation',
  })
  assert.equal(candidate.status, CANDIDATE_STATES.PENDING)

  // An exact query match is the strongest case, and it still returns nothing, because
  // there are two independent layers: the search index holds only approved memories, and
  // the hydration step re-checks the row's status. A control that removed only the index
  // filter still passed -- which is how the second layer was discovered. The control was
  // rewritten to defeat both, and then this test fails as it should.
  assert.deepEqual(store.contextFor('The user works in Chennai.').memories, [])
  assert.deepEqual(store.searchMemories('Chennai'), [])
  assert.equal(store.buildContext('Chennai').hasMemories, false)
  assert.equal(store.buildContext('Chennai').promptContext, '')

  // Approving it is the only route in, and the link back is recorded.
  const decided = store.decideCandidate(candidate.id, { approve: true })
  assert.equal(decided.memory.approvedBy, APPROVER)
  assert.equal(store.contextFor('Chennai').memories.length, 1)
  const [listed] = store.listCandidates({ status: CANDIDATE_STATES.APPROVED })
  assert.equal(listed.memoryId, decided.memory.id)
  assert.equal(listed.decidedBy, APPROVER)
})

test('a rejected candidate stays rejected and cannot be decided twice', () => {
  const store = fresh()
  const candidate = store.propose({ text: 'The user might like tea.', proposedFrom: 'conversation' })
  const rejected = store.decideCandidate(candidate.id, { approve: false })
  assert.equal(rejected.approved, false)
  assert.equal(rejected.candidate.status, CANDIDATE_STATES.REJECTED)
  assert.equal(store.stats().memories, 0, 'a rejected candidate never became a memory')
  assert.throws(() => store.decideCandidate(candidate.id, { approve: true }),
    (error) => error.code === 'already_decided')
})

test('a candidate must record what proposed it', () => {
  const store = fresh()
  assert.throws(() => store.propose({ text: 'something', proposedFrom: '' }),
    (error) => error.code === 'source_required')
})

// --- curation: superseding keeps the history ---------------------------------------

test('a superseded memory drops out of prompts but stays readable', () => {
  const store = fresh()
  const { memory } = store.remember({ text: 'Uses Python 3.10.' })
  const { superseded, replacement } = store.supersede(memory.id, { text: 'Uses Python 3.11.' })

  assert.equal(superseded.status, 'superseded')
  assert.equal(superseded.supersededBy, replacement.id)
  assert.equal(replacement.status, 'approved')

  const live = store.contextFor('Python').memories.map((m) => m.text)
  assert.deepEqual(live, ['Uses Python 3.11.'], 'the superseded text is not injected')
  assert.equal(store.listMemories({ status: 'superseded' }).length, 1)
  assert.throws(() => store.supersede(memory.id, { text: 'again' }), (error) => error.code === 'not_approved')
})

test('editing a memory updates what the index can find', () => {
  const store = fresh()
  const { memory } = store.remember({ text: 'Works on embedded systems.', subject: 'day job' })
  assert.equal(store.searchMemories('embedded').length, 1)
  store.updateMemory(memory.id, { text: 'Works on distributed systems.' })
  assert.equal(store.searchMemories('embedded').length, 0, 'the old text is no longer indexed')
  assert.equal(store.searchMemories('distributed').length, 1)
  assert.equal(store.getMemory(memory.id).subject, 'day job', 'untouched fields survive an edit')
})

// --- deletion ----------------------------------------------------------------------

test('forgetting removes the memory, its index entry, and records a tombstone without the text', () => {
  const store = fresh()
  const { memory } = store.remember({ text: 'The launch code is in the safe.' })
  const result = store.forget(memory.id, { reason: 'no longer true' })

  assert.equal(result.deleted, true)
  assert.equal(store.getMemory(memory.id), null)
  assert.equal(store.searchMemories('launch').length, 0)
  assert.equal(store.stats().memories, 0)

  const [tombstone] = store.db.prepare('SELECT * FROM memory_deletions').all()
  assert.equal(tombstone.memory_id, memory.id)
  assert.equal(tombstone.reason, 'no longer true')
  // The tombstone records that a deletion happened, not what was deleted -- a deletion
  // log that quotes the deleted text defeats the deletion.
  assert.ok(!/launch code/.test(JSON.stringify(tombstone)), 'the tombstone must not quote the memory')
  assert.throws(() => store.forget(memory.id), (error) => error.code === 'not_found')
})

test('forgetting everything clears memories and pending candidates in one transaction', () => {
  const store = fresh()
  store.remember({ text: 'first' })
  store.remember({ text: 'second' })
  store.propose({ text: 'maybe later', proposedFrom: 'conversation' })
  const result = store.forgetAll()
  assert.deepEqual(result, { deletedMemories: 2, deletedCandidates: 1 })
  assert.equal(store.stats().memories, 0)
  assert.equal(store.stats().pendingCandidates, 0)
  assert.equal(store.stats().deletionsRecorded, 2)
})

// --- sessions and recall -----------------------------------------------------------

test('turns are stored per session in order, and recall says where a hit came from', () => {
  const store = fresh()
  const session = store.startSession({ title: 'Ingest troubleshooting' })
  store.appendTurn(session.id, { role: 'user', content: 'The ingest job keeps failing on CSV files.' })
  store.appendTurn(session.id, { role: 'assistant', content: 'Which delimiter does the file use?' })
  store.appendTurn(session.id, { role: 'user', content: 'Semicolons. It is a European export.' })

  const other = store.startSession({ title: 'Unrelated' })
  store.appendTurn(other.id, { role: 'user', content: 'What is the capital of Peru?' })

  const { hits, searchedTurns } = store.recall('delimiter')
  assert.equal(searchedTurns, 4)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sessionId, session.id)
  assert.equal(hits[0].role, 'assistant')
  // Provenance is the point: a recalled sentence without an origin cannot be told apart
  // from the model inventing it.
  assert.equal(hits[0].sessionTitle, 'Ingest troubleshooting')
  assert.ok(hits[0].excerpt.text.includes('delimiter'))
  assert.equal(hits[0].excerpt.truncated, false)

  assert.deepEqual(store.recall('').hits, [])
  assert.equal(store.listSessions().length, 2)
  assert.equal(store.getSession(session.id).turns.length, 3)
})

test('recall never feeds itself into a prompt: it is a separate call from memory context', () => {
  const store = fresh()
  const session = store.startSession()
  store.appendTurn(session.id, { role: 'user', content: 'My account number is 12345678.' })
  // The turn is findable on request...
  assert.equal(store.recall('account number').hits.length, 1)
  // ...and contributes nothing to what a prompt is given, because turns are not memories.
  assert.equal(store.buildContext('account number').hasMemories, false)
  assert.deepEqual(store.contextFor('account number').memories, [])
})

test('a full session refuses another turn rather than dropping the oldest', () => {
  const store = new MemoryStore(':memory:', { limits: { maxTurnsPerSession: 2 } })
  const session = store.startSession()
  store.appendTurn(session.id, { role: 'user', content: 'one' })
  store.appendTurn(session.id, { role: 'assistant', content: 'two' })
  assert.throws(
    () => store.appendTurn(session.id, { role: 'user', content: 'three' }),
    (error) => error.code === 'session_limit' && /nothing was removed/.test(error.message),
  )
  assert.deepEqual(store.turns(session.id).map((t) => t.content), ['one', 'two'])
})

test('deleting a session removes its turns and their index entries', () => {
  const store = fresh()
  const session = store.startSession()
  store.appendTurn(session.id, { role: 'user', content: 'a distinctive phrase' })
  const result = store.deleteSession(session.id)
  assert.equal(result.turnsRemoved, 1)
  assert.equal(store.recall('distinctive').hits.length, 0)
  assert.equal(store.getSession(session.id), null)
  assert.throws(() => store.deleteSession(session.id), (error) => error.code === 'not_found')
})

test('a turn needs a real session, and an unknown role is refused', () => {
  const store = fresh()
  assert.throws(() => store.appendTurn('nope', { role: 'user', content: 'x' }), (error) => error.code === 'not_found')
  const session = store.startSession()
  assert.throws(() => store.appendTurn(session.id, { role: 'tool', content: 'x' }), (error) => error.code === 'unknown_role')
  assert.throws(() => store.appendTurn(session.id, { role: 'user' }), (error) => error.code === 'content_required')
  assert.throws(() => store.appendTurn(session.id, { role: 'user', content: '   ' }), (error) => error.code === 'content_required')
  assert.throws(() => store.appendTurn(null, { role: 'user', content: 'x' }), (error) => error.code === 'session_required')
})

// --- what reaches a prompt ---------------------------------------------------------

test('the injected block carries its rules and its citations', () => {
  const store = fresh()
  store.remember({ text: 'Answers questions in British English.', kind: MEMORY_KINDS.PREFERENCE, subject: 'writing' })
  const context = store.buildContext('writing style')
  assert.equal(context.hasMemories, true)
  assert.match(context.promptContext, /things the user asked you to remember/)
  // The rule that stops a remembered preference overriding what the user says now.
  assert.match(context.promptContext, /follow what the user\nsays now/)
  assert.match(context.promptContext, /\[M1\] \(preference\) writing: Answers questions in British English\./)
  assert.equal(context.memories[0].id, store.listMemories()[0].id)
})

test('the injected memory count is capped, so a large store cannot consume a prompt', () => {
  const store = fresh()
  for (let i = 0; i < 20; i++) store.remember({ text: `distinctive memory number ${i}` })
  assert.equal(store.buildContext('distinctive memory').memories.length, LIMITS.maxContextMemories)
  // Asking for more than the cap is clamped rather than honoured.
  assert.equal(store.contextFor('distinctive', { limit: 999 }).memories.length, LIMITS.maxContextMemories)
})

test('every injected memory carries its data class, so the caller can gate egress on it', () => {
  const store = fresh()
  store.remember({ text: 'Project Falcon ships in March.', dataClass: 'confidential' })
  const [memory] = store.contextFor('Falcon').memories
  assert.equal(memory.dataClass, 'confidential')
})

test('with no query the newest memories are used, and that is stated', () => {
  const store = fresh()
  store.remember({ text: 'older' })
  store.remember({ text: 'newer' })
  const context = store.contextFor('')
  assert.equal(context.matched, 'recency')
  assert.deepEqual(context.memories.map((m) => m.text), ['newer', 'older'])
})

// --- data rights -------------------------------------------------------------------

test('the export states its restrictions at the data level', () => {
  const store = fresh()
  store.remember({ text: 'Exports cleanly.' })
  store.propose({ text: 'A pending thought.', proposedFrom: 'conversation' })
  const session = store.startSession({ title: 'Export test' })
  store.appendTurn(session.id, { role: 'user', content: 'hello' })

  const dump = store.exportAll()
  assert.equal(dump.format, 'aetheris-memory-export/v1')
  assert.equal(dump.consent, 'user_approved')
  assert.equal(dump.trainingUse, 'prohibited')
  assert.equal(dump.memories.length, 1)
  assert.equal(dump.candidates.length, 1)
  assert.equal(dump.sessions[0].turns.length, 1)
  // The restriction travels with each record too, not only with the envelope.
  assert.equal(dump.memories[0].trainingUse, 'prohibited')
})

test('the module names the mechanisms §7 requires to stay distinct', () => {
  assert.deepEqual(Object.values(MEMORY_MECHANISMS), [
    'conversation_context', 'approved_memory', 'session_recall', 'retrieval_index',
    'training_example', 'released_weights',
  ])
})

test('the stats report what is held without exposing it', () => {
  const store = fresh()
  store.remember({ text: 'a private thing' })
  const stats = store.stats()
  assert.deepEqual(Object.keys(stats).sort(), [
    'deletionsRecorded', 'limits', 'mechanisms', 'memories', 'pendingCandidates',
    'sessions', 'supersededMemories', 'turns',
  ])
  assert.ok(!JSON.stringify(stats).includes('a private thing'))
})
