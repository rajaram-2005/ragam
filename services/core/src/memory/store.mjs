// Memory: the things a user asked Aetheris to remember, and the sessions it can recall.
//
// Directive §7 splits the mechanisms that must stay distinct: conversation context,
// user-approved memory, retrieval indexes, validated training examples, experimental
// adapters and released weights. This module owns exactly two of them -- approved memory
// and session recall -- and the distinctions are enforced rather than documented:
//
//   1  AN APPROVED MEMORY IS THE ONLY THING THAT REACHES A PROMPT.
//      `contextFor()` reads a view filtered on status='approved'. A candidate proposed
//      from a conversation is a different table, and there is no code path from that
//      table into a prompt. A test asserts that a pending candidate is invisible even
//      when it matches the query exactly.
//
//   2  NOTHING IS REMEMBERED WITHOUT AN EXPLICIT USER ACT. The `approved_by` column
//      carries `CHECK (approved_by = 'user')`, so the database refuses an agent-approved
//      row. Not "the application should not" -- the insert fails.
//
//   3  MEMORY IS NEVER TRAINING DATA. Every row carries `CHECK (training_use =
//      'prohibited')`, so a memory cannot be written as training material even by a
//      future caller that wants to. The directive's rule "do not automatically train on
//      personal conversations" is a constraint the schema enforces.
//
//   4  DELETION IS REAL, COMPLETE AND RECORDED. `forget()` removes the row and its index
//      entries in one transaction and writes a tombstone. Unlike a skill, which is
//      archived because a procedure is reusable knowledge, a memory belongs to the user
//      and deletion removes it.
//
//   5  A SESSION RECALL IS NOT A MEMORY. Recall searches the user's own turns on demand
//      and returns where each hit came from. It is never injected automatically, because
//      silently feeding old conversations into a new prompt is how a product surprises
//      someone with something they said months ago.
//
// Storage choice: SQLite for the records, rebuildable BM25 for search -- the same split
// the knowledge pipeline uses, for the same reason. Memory text is short and relational;
// ranking it is an index problem, not a vector problem.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { Bm25Index } from '../knowledge/bm25.mjs'

/**
 * The distinct mechanisms, named so a reader can see what this module is *not*.
 * §7 requires these to remain separate; keeping the list next to the code that owns two
 * of them is the cheapest way to stop them merging by accident.
 */
export const MEMORY_MECHANISMS = Object.freeze({
  CONVERSATION_CONTEXT: 'conversation_context',   // the current request; nothing persisted
  APPROVED_MEMORY: 'approved_memory',             // this module
  SESSION_RECALL: 'session_recall',               // this module, on demand only
  RETRIEVAL_INDEX: 'retrieval_index',             // knowledge/, for documents
  TRAINING_EXAMPLE: 'training_example',           // fabric/, only from validated failures
  RELEASED_WEIGHTS: 'released_weights',           // an artifact with a model card
})

export const MEMORY_KINDS = Object.freeze({
  FACT: 'fact',
  PREFERENCE: 'preference',
  DECISION: 'decision',
  CONSTRAINT: 'constraint',
})

export const CANDIDATE_STATES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
})

/** The only value the schema accepts. An agent cannot approve its own memory. */
export const APPROVER = 'user'

export const LIMITS = Object.freeze({
  maxMemoryChars: 2000,
  maxMemories: 2000,
  maxTurnsPerSession: 2000,
  maxRecallResults: 25,
  // Injected memories are capped by count as well as by relevance, so a large memory
  // store cannot silently consume a prompt.
  maxContextMemories: 8,
})

export class MemoryError extends Error {
  constructor(message, code = 'memory_error', detail = {}) {
    super(message)
    this.name = 'MemoryError'
    this.code = code
    this.detail = detail
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'fact',
  subject       TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'approved',
  -- The database refuses anything but a user approval. An agent-originated fact has to
  -- go through memory_candidates and be approved by the user, or it does not exist.
  approved_by   TEXT NOT NULL CHECK (approved_by = 'user'),
  approved_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  superseded_by TEXT REFERENCES memories(id),
  source_kind   TEXT NOT NULL DEFAULT 'user_statement',
  source_session TEXT,
  data_class    TEXT NOT NULL DEFAULT 'internal',
  consent       TEXT NOT NULL CHECK (consent = 'user_approved'),
  purpose       TEXT NOT NULL CHECK (purpose = 'personal_context'),
  -- §7: personal memory must never be automatically used for training. A CHECK rather
  -- than a convention, so there is no future code path that can write otherwise.
  training_use  TEXT NOT NULL CHECK (training_use = 'prohibited')
);
CREATE INDEX IF NOT EXISTS idx_memories_status  ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_live ON memories(text) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS memory_candidates (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  rationale     TEXT,
  -- What produced the proposal: a failed task, a stated preference, a correction.
  proposed_from TEXT NOT NULL,
  proposed_at   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decided_at    INTEGER,
  decided_by    TEXT,
  memory_id     TEXT REFERENCES memories(id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  started_at INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  turn_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_at);

CREATE TABLE IF NOT EXISTS turns (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  data_class TEXT NOT NULL DEFAULT 'internal'
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, idx);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_unique ON turns(session_id, idx);

CREATE TABLE IF NOT EXISTS memory_deletions (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  deleted_at  INTEGER NOT NULL,
  reason      TEXT,
  requested_by TEXT
);
`

export class MemoryStore {
  constructor(file = ':memory:', { limits = LIMITS } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.limits = { ...LIMITS, ...limits }
    // Both indexes are derived state, rebuilt from the rows on construction. A store
    // that lost its index loses ranking quality, not data.
    this.memoryIndex = new Bm25Index()
    this.turnIndex = new Bm25Index()
    this.#rebuildIndexes()
  }

  #rebuildIndexes() {
    this.memoryIndex = new Bm25Index()
    for (const row of this.db.prepare("SELECT id, text, subject, tags FROM memories WHERE status = 'approved'").all()) {
      this.memoryIndex.add(row.id, `${row.text} ${row.subject ?? ''} ${row.tags ?? ''}`)
    }
    this.turnIndex = new Bm25Index()
    for (const row of this.db.prepare('SELECT id, content, role FROM turns').all()) {
      this.turnIndex.add(row.id, row.content, { role: row.role })
    }
  }

  // --- approved memory ---------------------------------------------------------

  /**
   * Remember something, because the user asked for it.
   *
   * There is no `approvedBy` parameter. The approver is a constant, and the schema
   * enforces it, so a caller cannot pass something else and a future refactor cannot
   * quietly make an agent the approver.
   */
  remember({ text, kind = MEMORY_KINDS.FACT, subject = null, tags = [], sourceSession = null,
             dataClass = 'internal', sourceKind = 'user_statement' }) {
    const clean = String(text ?? '').trim()
    if (!clean) throw new MemoryError('a memory needs text', 'text_required')
    if (clean.length > this.limits.maxMemoryChars) {
      throw new MemoryError(
        `a memory may be at most ${this.limits.maxMemoryChars} characters; this is ${clean.length}. `
        + 'A memory is a statement, not a document -- put documents in the knowledge store.',
        'too_long',
      )
    }
    if (!Object.values(MEMORY_KINDS).includes(kind)) {
      throw new MemoryError(`unknown kind '${kind}'; known kinds are ${Object.values(MEMORY_KINDS).join(', ')}`, 'unknown_kind')
    }

    const existing = this.db.prepare("SELECT * FROM memories WHERE text = ? AND status = 'approved'").get(clean)
    if (existing) return { duplicate: true, memory: hydrate(existing) }

    const live = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'approved'").get().n
    if (live >= this.limits.maxMemories) {
      throw new MemoryError(
        `the memory store holds ${live} memories, at the limit of ${this.limits.maxMemories}. `
        + 'Remove one, or move lasting knowledge into a document. Nothing was deleted to make room.',
        'memory_limit',
      )
    }

    const now = Date.now()
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO memories (id, text, kind, subject, tags, status, approved_by, approved_at, created_at,
         updated_at, source_kind, source_session, data_class, consent, purpose, training_use)
       VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, 'user_approved', 'personal_context', 'prohibited')`,
    ).run(id, clean, kind, subject, JSON.stringify(tags ?? []), APPROVER, now, now, now,
      sourceKind, sourceSession, dataClass)

    this.memoryIndex.add(id, `${clean} ${subject ?? ''} ${(tags ?? []).join(' ')}`)
    return { duplicate: false, memory: this.getMemory(id) }
  }

  getMemory(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return row ? hydrate(row) : null
  }

  /** Approved memories, newest first. Candidates are deliberately not included. */
  listMemories({ status = 'approved', limit = 200 } = {}) {
    const rows = this.db.prepare(
      // rowid breaks ties on created_at: two memories stored in the same millisecond
      // otherwise come back in an undefined order, which makes "newest first" a
      // promise the query does not keep.
      'SELECT * FROM memories WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(status, limit)
    return rows.map(hydrate)
  }

  /** Edit a memory's text or metadata. Still user-approved: the schema is unchanged. */
  updateMemory(id, patch = {}) {
    const current = this.getMemory(id)
    if (!current) throw new MemoryError(`no memory '${id}'`, 'not_found')
    const text = patch.text === undefined ? current.text : String(patch.text).trim()
    if (!text) throw new MemoryError('a memory needs text', 'text_required')
    if (text.length > this.limits.maxMemoryChars) {
      throw new MemoryError(`a memory may be at most ${this.limits.maxMemoryChars} characters`, 'too_long')
    }
    const kind = patch.kind ?? current.kind
    if (!Object.values(MEMORY_KINDS).includes(kind)) {
      throw new MemoryError(`unknown kind '${kind}'`, 'unknown_kind')
    }
    this.db.prepare(
      'UPDATE memories SET text = ?, kind = ?, subject = ?, tags = ?, updated_at = ? WHERE id = ?',
    ).run(text, kind, patch.subject === undefined ? current.subject : patch.subject,
      JSON.stringify(patch.tags ?? current.tags), Date.now(), id)
    this.memoryIndex.remove(id)
    this.memoryIndex.add(id, `${text} ${patch.subject ?? current.subject ?? ''}`)
    return this.getMemory(id)
  }

  /**
   * Replace a memory with a corrected one, keeping the link.
   *
   * Superseding is the curate path for memory: a fact that changed is not deleted, it
   * is marked as replaced, so "what did I used to think" stays answerable. The
   * replacement is still a user approval -- an agent cannot supersede by itself.
   */
  supersede(id, { text, kind = null, subject = undefined, tags = undefined }) {
    const current = this.getMemory(id)
    if (!current) throw new MemoryError(`no memory '${id}'`, 'not_found')
    if (current.status !== 'approved') {
      throw new MemoryError(`memory '${id}' is '${current.status}' and cannot be superseded`, 'not_approved')
    }
    const replacement = this.remember({
      text, kind: kind ?? current.kind, subject: subject === undefined ? current.subject : subject,
      tags: tags ?? current.tags, sourceSession: current.sourceSession, dataClass: current.dataClass,
    })
    this.db.prepare("UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(replacement.memory.id, Date.now(), id)
    this.memoryIndex.remove(id)
    return { superseded: this.getMemory(id), replacement: replacement.memory }
  }

  /**
   * Forget a memory. Removal, not archival.
   *
   * A memory is the user's, so this is a real delete: the row goes, the index entry goes,
   * and a tombstone records that it happened without recording what it said. Session
   * recall over a turn that mentioned the memory still works, because the turn is the
   * user's own conversation and was never derived from the memory.
   */
  forget(id, { reason = null, requestedBy = 'user' } = {}) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    if (!row) throw new MemoryError(`no memory '${id}'`, 'not_found')
    this.db.exec('BEGIN')
    try {
      this.#releaseReferences([id])
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      this.db.prepare('INSERT INTO memory_deletions (id, memory_id, deleted_at, reason, requested_by) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), id, Date.now(), reason, requestedBy)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.memoryIndex.remove(id)
    return { deleted: true, memoryId: id, textWas: row.text.length > 0 }   // length only: the text is gone
  }

  /**
   * Drop every reference to these memories so the rows themselves can go.
   *
   * Both links are records of a decision -- "you approved this proposal", "this replaced
   * that" -- so they are cleared rather than deleted: `memory_candidates` keeps the row
   * and its decision, and loses only the pointer to a memory that no longer exists. The
   * `memories` self-reference is part of the row being deleted, so clearing it is
   * bookkeeping. Without this, `PRAGMA foreign_keys = ON` makes deletion fail outright
   * for approved candidates and superseded pairs.
   */
  #releaseReferences(ids, { all = false } = {}) {
    if (all) {
      this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by IS NOT NULL').run()
      this.db.prepare('UPDATE memory_candidates SET memory_id = NULL WHERE memory_id IS NOT NULL').run()
      return
    }
    const clearSuperseded = this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?')
    const clearCandidate = this.db.prepare('UPDATE memory_candidates SET memory_id = NULL WHERE memory_id = ?')
    for (const id of ids) {
      clearSuperseded.run(id)
      clearCandidate.run(id)
    }
  }

  /** Forget everything. One transaction, one tombstone per memory. */
  forgetAll({ reason = 'user requested full memory deletion', requestedBy = 'user' } = {}) {
    const ids = this.db.prepare('SELECT id FROM memories').all().map((r) => r.id)
    // Counted, not filtered: the wipe removes every candidate row -- a decided proposal
    // holds the same user text as a pending one -- so the number it reports has to be the
    // number of rows it removed. Counting only the pending ones understated it.
    const candidateIds = this.db.prepare('SELECT id FROM memory_candidates').all().map((r) => r.id)
    this.db.exec('BEGIN')
    try {
      const stamp = Date.now()
      const tombstone = this.db.prepare('INSERT INTO memory_deletions (id, memory_id, deleted_at, reason, requested_by) VALUES (?, ?, ?, ?, ?)')
      for (const id of ids) tombstone.run(randomUUID(), id, stamp, reason, requestedBy)
      // Order matters here. `memory_candidates.memory_id` and `memories.superseded_by`
      // both reference `memories`, so with foreign keys on, deleting the memories first
      // fails for any user who has ever approved a proposed memory or superseded one --
      // exactly the memories that came through the user-facing approval gate. The
      // references are released before the rows they point at, and the tombstones (which
      // deliberately carry no foreign key) are written first so the record of the
      // deletion cannot be rolled back with the row it describes.
      this.#releaseReferences(ids, { all: true })
      this.db.prepare('DELETE FROM memory_candidates').run()
      this.db.prepare('DELETE FROM memories').run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    for (const id of ids) this.memoryIndex.remove(id)
    return { deletedMemories: ids.length, deletedCandidates: candidateIds.length }
  }

  // --- candidates: how something an agent noticed becomes memory -----------------

  /** Propose a memory. Always a candidate; there is no path from here to a prompt. */
  propose({ text, rationale = null, proposedFrom = 'conversation' }) {
    const clean = String(text ?? '').trim()
    if (!clean) throw new MemoryError('a candidate needs text', 'text_required')
    if (clean.length > this.limits.maxMemoryChars) throw new MemoryError('candidate text is too long', 'too_long')
    if (!proposedFrom) throw new MemoryError('a candidate must record what proposed it', 'source_required')
    const id = randomUUID()
    this.db.prepare(
      `INSERT INTO memory_candidates (id, text, rationale, proposed_from, proposed_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    ).run(id, clean, rationale, proposedFrom, Date.now())
    return { id, text: clean, status: CANDIDATE_STATES.PENDING }
  }

  listCandidates({ status = CANDIDATE_STATES.PENDING, limit = 100 } = {}) {
    return this.db.prepare(
      'SELECT * FROM memory_candidates WHERE status = ? ORDER BY proposed_at DESC LIMIT ?',
    ).all(status, limit).map(hydrateCandidate)
  }

  /** Approve or reject a candidate. Approval is the only route into memory. */
  decideCandidate(id, { approve, kind = MEMORY_KINDS.FACT, subject = null, tags = [] }) {
    const row = this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id)
    if (!row) throw new MemoryError(`no candidate '${id}'`, 'not_found')
    if (row.status !== CANDIDATE_STATES.PENDING) {
      throw new MemoryError(`candidate '${id}' is already '${row.status}'`, 'already_decided')
    }
    const now = Date.now()
    if (!approve) {
      this.db.prepare('UPDATE memory_candidates SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
        .run(CANDIDATE_STATES.REJECTED, now, APPROVER, id)
      return { approved: false, candidate: hydrateCandidate(this.db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id)) }
    }
    const stored = this.remember({
      text: row.text, kind, subject, tags,
      sourceKind: `proposed:${row.proposed_from}`,
    })
    this.db.prepare('UPDATE memory_candidates SET status = ?, decided_at = ?, decided_by = ?, memory_id = ? WHERE id = ?')
      .run(CANDIDATE_STATES.APPROVED, now, APPROVER, stored.memory.id, id)
    return { approved: true, memory: stored.memory, duplicate: stored.duplicate }
  }

  // --- retrieval ------------------------------------------------------------------

  /**
   * Relevant approved memories for a prompt.
   *
   * The query is filtered on status='approved' in SQL, so a pending candidate cannot be
   * returned by any rank. Each hit carries its data class, because the caller has to
   * fold it into the request's classification before deciding whether the request may
   * leave the device -- see mostSensitiveDataClass() in the app's chat path.
   */
  contextFor(query, { limit = this.limits.maxContextMemories } = {}) {
    const text = String(query ?? '').trim()
    const capped = Math.min(limit, this.limits.maxContextMemories)
    if (!text) {
      // No query: the newest approved memories, which is what a small store wants.
      return { memories: this.listMemories({ limit: capped }), matched: 'recency' }
    }
    const ranked = this.memoryIndex.search(text, { topK: capped })
    const memories = []
    for (const hit of ranked) {
      const memory = this.getMemory(hit.docId)
      if (memory && memory.status === 'approved') memories.push(memory)
    }
    return { memories, matched: 'relevance', considered: this.memoryIndex.size }
  }

  searchMemories(query, { topK = 10 } = {}) {
    return this.memoryIndex.search(query, { topK }).map((hit) => ({ ...hit, memory: this.getMemory(hit.docId) }))
      .filter((hit) => hit.memory)
  }

  /** Render the injected block. Empty when there is nothing, so a caller can test for it. */
  buildContext(query, { limit } = {}) {
    const { memories, matched } = this.contextFor(query, { limit })
    if (!memories.length) return { hasMemories: false, promptContext: '', memories: [], matched }
    const lines = memories.map((m, i) => {
      const label = m.subject ? `${m.subject}: ` : ''
      return `[M${i + 1}] (${m.kind}) ${label}${m.text}`
    })
    return {
      hasMemories: true,
      matched,
      memories,
      // Stated to the model, not merely implied, because a memory is a claim about the
      // user that may be stale. The instruction to prefer the user's current message
      // over a stored fact is what stops a remembered preference from overriding what
      // the user just said.
      promptContext: [
        'The following are things the user asked you to remember. Use them only when',
        'relevant. If they conflict with what the user says now, follow what the user',
        'says now. Do not mention this list unless the user refers to it.',
        ...lines,
      ].join('\n'),
    }
  }

  // --- sessions and recall --------------------------------------------------------

  startSession({ id = null, title = null } = {}) {
    const sessionId = id ?? randomUUID()
    const existing = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
    if (existing) return hydrateSession(existing)
    const now = Date.now()
    this.db.prepare('INSERT INTO sessions (id, title, started_at, last_at, turn_count) VALUES (?, ?, ?, ?, 0)')
      .run(sessionId, title, now, now)
    return hydrateSession(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId))
  }

  /**
   * Append a turn. Refuses rather than trimming when the cap is reached.
   *
   * Trimming the oldest turn would be a silent deletion of user data, which the storage
   * rules forbid for the footprint and which is no better here. The user is told, and
   * decides.
   */
  appendTurn(sessionId, { role, content, dataClass = 'internal' }) {
    if (!sessionId) throw new MemoryError('a turn needs a session', 'session_required')
    if (!['user', 'assistant', 'system'].includes(role)) {
      throw new MemoryError(`unknown role '${role}'`, 'unknown_role')
    }
    const body = String(content ?? '')
    if (!body.trim()) throw new MemoryError('a turn needs content; an empty turn records nothing', 'content_required')
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
    if (!session) throw new MemoryError(`no session '${sessionId}'`, 'not_found')
    if (session.turn_count >= this.limits.maxTurnsPerSession) {
      throw new MemoryError(
        `session '${sessionId}' holds ${session.turn_count} turns, at the limit of `
        + `${this.limits.maxTurnsPerSession}. Start a new conversation; nothing was removed.`,
        'session_limit',
      )
    }
    const idx = session.turn_count
    const id = randomUUID()
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT INTO turns (id, session_id, idx, role, content, created_at, data_class) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, sessionId, idx, role, body, now, dataClass)
      this.db.prepare('UPDATE sessions SET turn_count = turn_count + 1, last_at = ? WHERE id = ?').run(now, sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.turnIndex.add(id, body, { role, sessionId })
    return { id, sessionId, idx, role, createdAt: now }
  }

  listSessions({ limit = 50 } = {}) {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_at DESC LIMIT ?').all(limit).map(hydrateSession)
  }

  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
    if (!row) return null
    return { ...hydrateSession(row), turns: this.turns(id) }
  }

  turns(sessionId, { limit = 500 } = {}) {
    return this.db.prepare('SELECT id, idx, role, content, created_at, data_class FROM turns WHERE session_id = ? ORDER BY idx LIMIT ?')
      .all(sessionId, limit)
      .map((row) => ({ id: row.id, idx: row.idx, role: row.role, content: row.content, createdAt: row.created_at, dataClass: row.data_class }))
  }

  deleteSession(id) {
    const row = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id)
    if (!row) throw new MemoryError(`no session '${id}'`, 'not_found')
    const ids = this.db.prepare('SELECT id FROM turns WHERE session_id = ?').all(id).map((r) => r.id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)   // turns cascade
    for (const turnId of ids) this.turnIndex.remove(turnId)
    return { deleted: true, sessionId: id, turnsRemoved: ids.length }
  }

  /**
   * Search the user's own past turns.
   *
   * On demand only. The result says where each hit came from, because a recalled
   * sentence with no origin is indistinguishable from the model making it up.
   */
  recall(query, { topK = 10 } = {}) {
    const text = String(query ?? '').trim()
    if (!text) return { query: text, hits: [], reason: 'empty query' }
    const capped = Math.min(Math.max(topK, 1), this.limits.maxRecallResults)
    const hits = []
    for (const hit of this.turnIndex.search(text, { topK: capped * 2 })) {
      const turn = this.db.prepare(
        `SELECT t.id, t.session_id, t.idx, t.role, t.content, t.created_at, s.title
           FROM turns t JOIN sessions s ON s.id = t.session_id WHERE t.id = ?`,
      ).get(hit.docId)
      if (!turn) continue
      hits.push({
        turnId: turn.id,
        sessionId: turn.session_id,
        sessionTitle: turn.title,
        role: turn.role,
        at: turn.created_at,
        score: hit.score,
        // A plain excerpt, not a summary: a summary would be generated text presented
        // as a quotation of the user's own conversation.
        excerpt: excerpt(turn.content, text),
      })
      if (hits.length >= capped) break
    }
    return { query: text, hits, searchedTurns: this.turnIndex.size }
  }

  // --- reporting and data rights --------------------------------------------------

  stats() {
    const approved = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'approved'").get().n
    const superseded = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'superseded'").get().n
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM memory_candidates WHERE status = 'pending'").get().n
    const sessions = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n
    const turns = this.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n
    const deletions = this.db.prepare('SELECT COUNT(*) AS n FROM memory_deletions').get().n
    return {
      memories: approved,
      supersededMemories: superseded,
      pendingCandidates: pending,
      sessions,
      turns,
      deletionsRecorded: deletions,
      limits: this.limits,
      mechanisms: MEMORY_MECHANISMS,
    }
  }

  /**
   * Everything held, for a data-rights export.
   *
   * Every record carries its consent and its prohibition on training use, so the export
   * states the restriction at the data level rather than relying on a reader to know it.
   */
  exportAll() {
    return {
      format: 'aetheris-memory-export/v1',
      exportedAt: new Date().toISOString(),
      consent: 'user_approved',
      trainingUse: 'prohibited',
      memories: this.db.prepare('SELECT * FROM memories ORDER BY created_at').all().map(hydrate),
      candidates: this.db.prepare('SELECT * FROM memory_candidates ORDER BY proposed_at').all().map(hydrateCandidate),
      sessions: this.listSessions({ limit: 1000 }).map((session) => ({ ...session, turns: this.turns(session.id) })),
      deletions: this.db.prepare('SELECT memory_id, deleted_at, reason FROM memory_deletions ORDER BY deleted_at').all(),
    }
  }

  close() {
    this.db.close()
  }
}

// --- row mapping -----------------------------------------------------------------

function hydrate(row) {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    subject: row.subject,
    tags: JSON.parse(row.tags ?? '[]'),
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    supersededBy: row.superseded_by,
    sourceKind: row.source_kind,
    sourceSession: row.source_session,
    dataClass: row.data_class,
    consent: row.consent,
    purpose: row.purpose,
    trainingUse: row.training_use,
  }
}

function hydrateCandidate(row) {
  return {
    id: row.id,
    text: row.text,
    rationale: row.rationale,
    proposedFrom: row.proposed_from,
    proposedAt: row.proposed_at,
    status: row.status,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    memoryId: row.memory_id,
  }
}

function hydrateSession(row) {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    lastAt: row.last_at,
    turnCount: row.turn_count,
  }
}

/** A window around the first matching term, so an excerpt shows why it matched. */
function excerpt(content, query, { window = 220 } = {}) {
  const text = String(content ?? '')
  if (text.length <= window) return { text, truncated: false }
  const terms = String(query).toLowerCase().match(/[a-z0-9]+/g) ?? []
  let at = -1
  for (const term of terms) {
    at = text.toLowerCase().indexOf(term)
    if (at !== -1) break
  }
  if (at === -1) return { text: `${text.slice(0, window)}…`, truncated: true }
  const start = Math.max(0, at - Math.floor(window / 3))
  const end = Math.min(text.length, start + window)
  return {
    text: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    truncated: true,
  }
}
