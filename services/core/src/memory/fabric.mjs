// The memory fabric: seven layers, each entry carrying where it came from, how sure the
// system is and why, what it is allowed to reach, and every version it has been.
//
// `memory/store.mjs` already exists and is the *product* memory: what a user asked Aetheris to
// remember, approval-gated by a database CHECK (`approved_by = 'user'`), prompt-facing through
// `contextFor`, and never training data. It is good at that and this module does not duplicate
// it. What the store does not have, and what the directive asks for here, is the difference
// this module is built around:
//
//   A USER STATEMENT IS NOT A FACT.
//
// The store has `kind = 'fact'` and `approved_by = 'user'`. That combination is honest about
// *permission* -- the user approved it -- and says nothing about *truth*, and a system that
// reads those two columns as "verified" has turned "the user said so" into "it is so". So every
// entry here carries two separate records: `assertion` (who said it, and how) and `verification`
// (whether an independent check ever confirmed it, and which one). A claim has no truth number
// at all: `confidence.value` is null with basis `user-stated`, and the record says in words that
// it records the saying and not the truth. A verified fact has a check named on it, and the check
// may not be the thing that asserted the claim -- the same independence rule the adaptive
// loop applies to routes applies here to evidence.
//
// The rest of the rules, each with a test:
//
//   * Provenance is required and is *rows*, not a field. An entry with no provenance row is
//     refused, because an entry that cannot say where it came from is a rumour with a schema.
//   * Nothing is silently overwritten. A correction appends a version and marks the old one
//     superseded; the old version stays readable, and `history()` returns the whole chain.
//     Replacing a verified entry with a claim is refused by default (`would_downgrade`).
//   * Contradictions are kept. Two entries that disagree about the same subject and predicate
//     are both retrievable, each marked with what it contradicts, and `conflicts()` lists them.
//     Resolving one requires a reason, and the loser is superseded rather than deleted.
//   * Duplicates collapse into one entry with extra provenance. The same content from two
//     sources is one belief held twice, not two beliefs.
//   * Scope is enforced on read: a session-scoped entry is not returned by a project recall, and
//     an entry whose readers do not include the asker is not returned at all.
//   * Deletion is real, and it takes the provenance with it. A memory belongs to the person it
//     is about; a tombstone records that something was deleted, when, by whom and why -- and
//     nothing else, because a tombstone that kept the content would defeat the deletion.
//   * The skill, episodic and failure layers hold *references* to the systems that own those
//     things (the skill registry, the episode log) rather than copies, and a dangling reference
//     is refused. Two sources of truth is how they drift apart.

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const LAYERS = Object.freeze({
  WORKING: 'working',       // this task only; purged when the task ends
  EPISODIC: 'episodic',     // what happened, pointing at the episode log
  SEMANTIC: 'semantic',     // what is the case, about the world or the project
  PREFERENCE: 'preference', // how the user wants things done
  PROJECT: 'project',       // facts about a named project
  SKILL: 'skill',           // a pointer at a versioned procedure in the skill registry
  FAILURE: 'failure',       // what went wrong, pointing at the diagnosis
})

export const ASSERTION_KINDS = Object.freeze({
  CLAIMED: 'claimed',   // someone said it
  OBSERVED: 'observed', // something was seen directly by a named observer
})

export const VERIFICATION_STATUS = Object.freeze({
  UNVERIFIED: 'unverified',
  VERIFIED: 'verified',
  REFUTED: 'refuted',
})

export const CONFIDENCE_BASIS = Object.freeze({
  USER_STATED: 'user-stated', // no truth estimate: this records the saying
  MEASURED: 'measured',
  INFERRED: 'inferred',       // names the entries it was inferred from
  CHECKED: 'checked',
})

export const SCOPE_KINDS = Object.freeze(['session', 'project', 'user', 'global'])

export const PROVENANCE_KINDS = Object.freeze({
  USER_STATEMENT: 'user-statement',
  OBSERVATION: 'observation',
  CHECK: 'check',
  DERIVED: 'derived',
  DUPLICATE_SOURCE: 'duplicate-source',
  IMPORTED_MEMORY: 'imported-memory',
})

export class FabricError extends Error {
  constructor(message, code = 'fabric_error', detail = {}) {
    super(message)
    this.name = 'FabricError'
    this.code = code
    this.detail = detail
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fabric_entries (
  id            TEXT PRIMARY KEY,
  layer         TEXT NOT NULL CHECK (layer IN ('working','episodic','semantic','preference','project','skill','failure')),
  subject       TEXT,
  predicate     TEXT,
  value         TEXT,
  content       TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  assertion_kind TEXT NOT NULL CHECK (assertion_kind IN ('claimed','observed')),
  asserted_by   TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                CHECK (verification_status IN ('unverified','verified','refuted')),
  verified_by   TEXT,
  verified_method TEXT,
  confidence    REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_basis TEXT NOT NULL,
  confidence_from TEXT NOT NULL DEFAULT '[]',
  scope_kind    TEXT NOT NULL CHECK (scope_kind IN ('session','project','user','global')),
  scope_id      TEXT,
  readers       TEXT NOT NULL DEFAULT '["owner"]',
  exportable    INTEGER NOT NULL DEFAULT 0 CHECK (exportable IN (0,1)),
  -- §7, as a CHECK rather than a convention: personal memory is never training data.
  training_use  TEXT NOT NULL CHECK (training_use = 'prohibited'),
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes    TEXT,
  superseded_by TEXT,
  reference     TEXT,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fabric_layer  ON fabric_entries(layer, scope_kind, scope_id);
CREATE INDEX IF NOT EXISTS idx_fabric_subject ON fabric_entries(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_fabric_live   ON fabric_entries(superseded_by) WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS fabric_provenance (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES fabric_entries(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  source     TEXT NOT NULL,
  detail     TEXT,
  digest     TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fabric_prov ON fabric_provenance(entry_id);

CREATE TABLE IF NOT EXISTS fabric_tombstones (
  id                TEXT PRIMARY KEY,
  entry_id          TEXT NOT NULL,
  layer             TEXT NOT NULL,
  deleted_at        INTEGER NOT NULL,
  actor             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  provenance_removed INTEGER NOT NULL,
  -- Deliberately absent: subject, content, value, asserted_by and every provenance row.
  -- A tombstone that kept them would be the deletion it claims to be the record of.
  CHECK (length(reason) > 0)
);
`

const digest = (text) => createHash('sha256').update(String(text)).digest('hex')

export class MemoryFabric {
  #references

  /**
   * @param {string} [file]  a SQLite path, or ':memory:'
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {(reference: object) => boolean} [options.referenceExists]
   *        Asked to confirm that a skill version or episode a reference names really exists.
   *        Without it, a reference is recorded and marked `unchecked` rather than assumed good.
   */
  constructor(file = ':memory:', { now = () => Date.now(), referenceExists = null } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.now = now
    this.#references = referenceExists
    this.file = file
  }

  /**
   * Remember something. Every field that a later decision depends on is required, and each
   * refusal names what is missing rather than defaulting it.
   */
  remember({
    layer,
    content,
    subject = null,
    predicate = null,
    value = null,
    assertion = { kind: ASSERTION_KINDS.CLAIMED, by: 'user' },
    confidence = null,
    scope = { kind: 'user', id: null },
    permission = { readers: ['owner'], exportable: false },
    provenance = [],
    reference = null,
  }) {
    if (!Object.values(LAYERS).includes(layer)) {
      throw new FabricError(`'${layer}' is not a memory layer; one of ${Object.values(LAYERS).join(', ')}`, 'unknown_layer')
    }
    if (!content || !String(content).trim()) {
      throw new FabricError('an entry needs content; a memory with no content is a pointer to nothing', 'empty_content')
    }
    if (!Array.isArray(provenance) || provenance.length === 0) {
      throw new FabricError(
        'an entry needs at least one provenance record saying where it came from',
        'missing_provenance',
        { layer },
      )
    }
    if (!SCOPE_KINDS.includes(scope.kind)) {
      throw new FabricError(`scope kind '${scope.kind}' must be one of ${SCOPE_KINDS.join(', ')}`, 'invalid_scope')
    }
    if (scope.kind === 'session' && !scope.id) {
      throw new FabricError('a session-scoped entry must name its session', 'missing_scope_id')
    }

    const assertionKind = assertion?.kind ?? ASSERTION_KINDS.CLAIMED
    if (!Object.values(ASSERTION_KINDS).includes(assertionKind)) {
      throw new FabricError(`assertion kind must be one of ${Object.values(ASSERTION_KINDS).join(', ')}`, 'invalid_assertion')
    }
    if (!assertion?.by) {
      throw new FabricError('an assertion must name who made it; "someone said so" is not an assertion', 'missing_assertor')
    }

    const check = provenance.find((record) => record.kind === PROVENANCE_KINDS.CHECK)
    const verified = Boolean(check)
    if (check) {
      if (check.detail?.agreed !== true) {
        throw new FabricError(
          'a check that did not agree cannot verify an entry; record it as a refutation or not at all',
          'check_disagreed',
          { source: check.source },
        )
      }
      if (check.source === assertion.by) {
        throw new FabricError(
          `'${check.source}' cannot verify its own assertion; an independent check must come from somewhere else`,
          'self_verification',
          { source: check.source },
        )
      }
    }

    const confidenceRecord = this.#readConfidence({ confidence, verified, assertionKind, provenance })

    const now = this.now()
    const contentDigest = digest(`${layer}|${scope.kind}|${scope.id ?? ''}|${content}`)

    // A duplicate is one belief held twice, not two beliefs: the existing entry gains the new
    // source instead of a twin appearing beside it.
    const duplicate = this.db.prepare(
      `SELECT * FROM fabric_entries
        WHERE content_digest = ? AND layer = ? AND scope_kind = ? AND COALESCE(scope_id,'') = COALESCE(?,'')
          AND superseded_by IS NULL`,
    ).get(contentDigest, layer, scope.kind, scope.id ?? null)
    if (duplicate) {
      this.db.prepare('UPDATE fabric_entries SET seen_count = seen_count + 1, updated_at = ? WHERE id = ?').run(now, duplicate.id)
      for (const record of provenance) {
        this.#addProvenance(duplicate.id, { ...record, kind: PROVENANCE_KINDS.DUPLICATE_SOURCE, detail: { also: record.detail ?? null, original: record.source } })
      }
      if (check) this.#markVerified(duplicate.id, { check, now })
      return { ...this.get(duplicate.id), duplicate: true }
    }

    const id = `mem_${randomUUID()}`
    this.db.prepare(
      `INSERT INTO fabric_entries (
         id, layer, subject, predicate, value, content, content_digest,
         assertion_kind, asserted_by, verification_status, verified_by, verified_method,
         confidence, confidence_basis, confidence_from,
         scope_kind, scope_id, readers, exportable, training_use, version, reference,
         seen_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prohibited', 1, ?, 1, ?, ?)`,
    ).run(
      id, layer, subject, predicate, value, String(content), contentDigest,
      assertionKind, assertion.by,
      verified ? VERIFICATION_STATUS.VERIFIED : VERIFICATION_STATUS.UNVERIFIED,
      verified ? check.source : null,
      verified ? (check.detail?.method ?? 'independent recomputation') : null,
      confidenceRecord.value, confidenceRecord.basis, JSON.stringify(confidenceRecord.from),
      scope.kind, scope.id ?? null, JSON.stringify(permission.readers ?? ['owner']),
      permission.exportable === true ? 1 : 0,
      reference ? JSON.stringify(reference) : null,
      now, now,
    )
    for (const record of provenance) this.#addProvenance(id, record)
    if (reference) this.#checkReference(id, reference)
    return { ...this.get(id), duplicate: false }
  }

  /**
   * Confidence is never a bare number. A user claim carries no truth estimate at all, and an
   * inferred entry has to name the entries it was inferred from -- an inference whose inputs
   * cannot be named is a guess.
   */
  #readConfidence({ confidence, verified, assertionKind, provenance }) {
    const given = confidence ?? null
    // The number is checked first, whatever the basis: a value outside [0,1] is wrong on its own
    // terms, and reporting a missing measurement for `2` sends the caller to fix the wrong thing.
    if (given?.value !== undefined && given?.value !== null) this.#number(given.value)
    const basis = given?.basis ?? (verified ? CONFIDENCE_BASIS.CHECKED : assertionKind === ASSERTION_KINDS.OBSERVED ? CONFIDENCE_BASIS.MEASURED : CONFIDENCE_BASIS.USER_STATED)
    if (!Object.values(CONFIDENCE_BASIS).includes(basis)) {
      throw new FabricError(`confidence basis '${basis}' must be one of ${Object.values(CONFIDENCE_BASIS).join(', ')}`, 'invalid_confidence_basis')
    }
    if (basis === CONFIDENCE_BASIS.USER_STATED) {
      if (given?.value !== undefined && given?.value !== null) {
        throw new FabricError(
          'a user statement carries no truth estimate: the record says the user said it, not that it is true',
          'no_truth_estimate_for_claim',
        )
      }
      return { value: null, basis, from: [] }
    }
    if (basis === CONFIDENCE_BASIS.INFERRED) {
      const from = given?.from ?? []
      if (!Array.isArray(from) || from.length === 0) {
        throw new FabricError('an inferred entry must name the entries it was inferred from', 'missing_inference_source')
      }
      for (const sourceId of from) {
        if (!this.get(sourceId)) {
          throw new FabricError(
            `inference source '${sourceId}' does not exist; an inference cannot rest on an entry that was never recorded`,
            'unknown_inference_source',
            { sourceId },
          )
        }
      }
      return { value: this.#number(given.value), basis, from: [...from] }
    }
    if (basis === CONFIDENCE_BASIS.MEASURED) {
      const measured = provenance.some((record) => record.kind === PROVENANCE_KINDS.OBSERVATION || record.kind === PROVENANCE_KINDS.CHECK)
      if (!measured) {
        throw new FabricError('a measured confidence needs a measured provenance record to measure', 'unmeasured_confidence')
      }
      return { value: this.#number(given.value), basis, from: [] }
    }
    // CHECKED
    if (!verified) {
      throw new FabricError('a checked confidence needs a check', 'unchecked_confidence')
    }
    return { value: given?.value ?? 1, basis, from: [] }
  }

  #number(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new FabricError(`a confidence value must be a number between 0 and 1, got ${JSON.stringify(value)}`, 'invalid_confidence')
    }
    return value
  }

  #markVerified(entryId, { check, now }) {
    this.db.prepare(
      `UPDATE fabric_entries SET verification_status = 'verified', verified_by = ?, verified_method = ?,
        confidence = COALESCE(confidence, 1), confidence_basis = 'checked', updated_at = ? WHERE id = ?`,
    ).run(check.source, check.detail?.method ?? 'independent recomputation', now, entryId)
  }

  #addProvenance(entryId, record) {
    if (!record?.kind || !Object.values(PROVENANCE_KINDS).includes(record.kind)) {
      throw new FabricError(`provenance kind '${record?.kind}' must be one of ${Object.values(PROVENANCE_KINDS).join(', ')}`, 'invalid_provenance_kind')
    }
    if (!record.source) {
      throw new FabricError('a provenance record must name its source', 'missing_provenance_source')
    }
    this.db.prepare(
      'INSERT INTO fabric_provenance (id, entry_id, kind, source, detail, digest, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `prov_${randomUUID()}`, entryId, record.kind, record.source,
      record.detail === undefined || record.detail === null ? null : JSON.stringify(record.detail),
      record.digest ?? null, record.at ?? this.now(),
    )
  }

  /**
   * A reference points at an entry in another system. It is checked when a checker was given,
   * and marked `unchecked` when none was: an unverifiable pointer is reported as unverifiable
   * rather than assumed to lead somewhere.
   */
  #checkReference(entryId, reference) {
    if (!reference?.kind) {
      throw new FabricError('a reference must name what kind of thing it points at', 'invalid_reference')
    }
    const row = this.db.prepare('SELECT reference FROM fabric_entries WHERE id = ?').get(entryId)
    const record = JSON.parse(row.reference)
    if (typeof this.#references !== 'function') {
      this.db.prepare('UPDATE fabric_entries SET reference = ? WHERE id = ?')
        .run(JSON.stringify({ ...record, checked: false, note: 'no reference checker was configured, so this pointer was not confirmed' }), entryId)
      return
    }
    if (!this.#references(reference)) {
      // The entry is removed rather than stored with a dangling pointer: a memory claiming a
      // skill version that does not exist is exactly the fabricated provenance this module exists
      // to prevent.
      this.db.prepare('DELETE FROM fabric_entries WHERE id = ?').run(entryId)
      throw new FabricError(
        `reference to ${reference.kind} '${reference.name ?? reference.id ?? reference.seq ?? '?'}' does not exist`,
        'unknown_reference',
        { reference },
      )
    }
    this.db.prepare('UPDATE fabric_entries SET reference = ? WHERE id = ?')
      .run(JSON.stringify({ ...record, checked: true }), entryId)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM fabric_entries WHERE id = ?').get(id)
    if (!row) return null
    return this.#decorate(row)
  }

  provenanceOf(id) {
    // `rowid` breaks the tie on `at`: two provenance rows written in the same millisecond used to
    // come back in random-id order, which made an entry's evidence list nondeterministic.
    return this.db.prepare('SELECT * FROM fabric_provenance WHERE entry_id = ? ORDER BY at, rowid').all(id)
      .map((row) => Object.freeze({
        id: row.id,
        kind: row.kind,
        source: row.source,
        detail: row.detail ? JSON.parse(row.detail) : null,
        digest: row.digest,
        at: row.at,
      }))
  }

  #decorate(row) {
    const readers = JSON.parse(row.readers)
    const reference = row.reference ? JSON.parse(row.reference) : null
    return Object.freeze({
      id: row.id,
      layer: row.layer,
      subject: row.subject,
      predicate: row.predicate,
      value: row.value,
      content: row.content,
      digest: row.content_digest,
      assertion: Object.freeze({ kind: row.assertion_kind, by: row.asserted_by }),
      verification: Object.freeze({
        status: row.verification_status,
        verified: row.verification_status === VERIFICATION_STATUS.VERIFIED,
        by: row.verified_by,
        method: row.verified_method,
      }),
      confidence: Object.freeze({
        value: row.confidence,
        basis: row.confidence_basis,
        from: Object.freeze(JSON.parse(row.confidence_from)),
        ...(row.confidence_basis === CONFIDENCE_BASIS.USER_STATED
          ? { note: 'no truth estimate: this records that it was said, not that it is true' }
          : {}),
      }),
      scope: Object.freeze({ kind: row.scope_kind, id: row.scope_id }),
      permission: Object.freeze({ readers: Object.freeze(readers), exportable: row.exportable === 1 }),
      trainingUse: row.training_use,
      version: row.version,
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      reference,
      seenCount: row.seen_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      provenance: this.provenanceOf(row.id),
    })
  }

  /**
   * Retrieval. Scope and readers are enforced here rather than trusted from the caller, the
   * working layer is never returned unless it is asked for by name, and superseded versions stay
   * out of the way unless `includeSuperseded` or `asOf` says otherwise.
   */
  recall({
    layers = null,
    scope = null,
    as = 'owner',
    subject = null,
    verifiedOnly = false,
    includeSuperseded = false,
    asOf = null,
    allowScopes = null,
  } = {}) {
    const clauses = []
    const params = []
    if (layers) {
      if (!Array.isArray(layers) || layers.some((layer) => !Object.values(LAYERS).includes(layer))) {
        throw new FabricError(`recall needs known layers; one of ${Object.values(LAYERS).join(', ')}`, 'unknown_layer')
      }
      clauses.push(`layer IN (${layers.map(() => '?').join(',')})`)
      params.push(...layers)
    } else {
      // The working layer is the current task's scratch space. Ask for it by name or not at all.
      clauses.push('layer != ?')
      params.push(LAYERS.WORKING)
    }
    if (scope && !SCOPE_KINDS.includes(scope.kind)) {
      throw new FabricError(`unknown scope kind '${scope.kind}'`, 'invalid_scope')
    }
    // Scope is *not* a WHERE clause. Filtering it in SQL meant a query narrowed to one scope and
    // `allowScopes` could never widen it again -- and worse, entries from other scopes were never
    // fetched, so the `denied` list that tells a caller what it did not see was built from rows
    // that had already been discarded. Scope and readers are applied below, over every candidate
    // row, and each exclusion is reported with its reason.
    if (subject !== null) {
      clauses.push('subject = ?')
      params.push(subject)
    }
    if (verifiedOnly) clauses.push(`verification_status = '${VERIFICATION_STATUS.VERIFIED}'`)
    // An entry was believed at time T if it existed by then and had not yet been superseded. When
    // `asOf` is asked for it defines the view, so the plain live-only clause is not also added --
    // adding both excluded every superseded version, which is the whole point of asking.
    if (!includeSuperseded && asOf === null) clauses.push('superseded_by IS NULL')
    if (asOf !== null) {
      clauses.push('created_at <= ? AND (superseded_by IS NULL OR updated_at > ?)')
      params.push(asOf, asOf)
    }
    const rows = this.db.prepare(
      `SELECT * FROM fabric_entries WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id`,
    ).all(...params)

    const permitted = []
    const denied = []
    for (const row of rows) {
      const readers = JSON.parse(row.readers)
      const sameScope = !scope || (row.scope_kind === scope.kind && (row.scope_id ?? null) === (scope.id ?? null))
      const reachable = sameScope || (allowScopes ?? []).some(
        (allowed) => allowed.kind === row.scope_kind && (allowed.id ?? null) === (row.scope_id ?? null),
      )
      if (!readers.includes(as)) denied.push({ id: row.id, layer: row.layer, reason: `'${as}' is not a permitted reader` })
      else if (!reachable) denied.push({ id: row.id, layer: row.layer, reason: `scope ${row.scope_kind}${row.scope_id ? `:${row.scope_id}` : ''} was not asked for` })
      else permitted.push(row)
    }

    const decorated = permitted.map((row) => this.#decorate(row))
    const contradicting = new Map()
    for (const group of this.conflicts()) {
      for (const member of group.members) {
        contradicting.set(member, group.members.filter((id) => id !== member))
      }
    }
    return Object.freeze({
      entries: Object.freeze(decorated.map((entry) => Object.freeze({
        ...entry,
        contradicts: Object.freeze(contradicting.get(entry.id) ?? []),
      }))),
      denied: Object.freeze(denied),
      deniedCount: denied.length,
    })
  }

  /**
   * Entries that disagree about the same subject and predicate, within one layer and scope.
   * Returned as groups rather than resolved: a fabric that picked a winner on its own would be
   * deciding what is true from what was said first or last.
   */
  conflicts() {
    const rows = this.db.prepare(
      `SELECT id, layer, scope_kind, COALESCE(scope_id,'') AS scope_id, subject, predicate, value
         FROM fabric_entries
        WHERE superseded_by IS NULL AND subject IS NOT NULL AND predicate IS NOT NULL AND value IS NOT NULL`,
    ).all()
    const groups = new Map()
    for (const row of rows) {
      const key = `${row.layer}|${row.scope_kind}|${row.scope_id}|${row.subject}|${row.predicate}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(row)
    }
    const conflicts = []
    for (const [, members] of groups) {
      const values = new Set(members.map((member) => member.value))
      if (values.size < 2) continue
      conflicts.push(Object.freeze({
        layer: members[0].layer,
        scope: Object.freeze({ kind: members[0].scope_kind, id: members[0].scope_id || null }),
        subject: members[0].subject,
        predicate: members[0].predicate,
        values: Object.freeze([...values]),
        members: Object.freeze(members.map((member) => member.id)),
      }))
    }
    return Object.freeze(conflicts)
  }

  /**
   * Correct an entry: append a version rather than overwrite, so the previous belief stays
   * readable and the reason for the change is part of the record.
   */
  correct(id, { content, value = undefined, reason, actor = 'user', provenance = [] }) {
    const existing = this.get(id)
    if (!existing) throw new FabricError(`no entry '${id}'`, 'not_found')
    if (!reason || !String(reason).trim()) {
      throw new FabricError('a correction needs a reason; "it changed" is not one', 'missing_reason')
    }
    const provenanceRows = provenance.length
      ? provenance
      : [{ kind: PROVENANCE_KINDS.USER_STATEMENT, source: actor, detail: { correctionOf: id, reason } }]
    const next = this.remember({
      layer: existing.layer,
      content: content ?? existing.content,
      subject: existing.subject,
      predicate: existing.predicate,
      value: value === undefined ? existing.value : value,
      assertion: { kind: ASSERTION_KINDS.CLAIMED, by: actor },
      confidence: existing.confidence.basis === CONFIDENCE_BASIS.USER_STATED ? null : undefined,
      scope: existing.scope,
      permission: existing.permission,
      provenance: provenanceRows,
    })
    this.db.prepare('UPDATE fabric_entries SET version = ?, supersedes = ?, updated_at = ? WHERE id = ?')
      .run(existing.version + 1, id, this.now(), next.id)
    this.db.prepare('UPDATE fabric_entries SET superseded_by = ?, updated_at = ? WHERE id = ?')
      .run(next.id, this.now(), id)
    return Object.freeze({
      ...this.get(next.id),
      supersedes: id,
      correctionReason: reason,
      replaced: Object.freeze({ id, content: existing.content, version: existing.version, verification: existing.verification.status }),
    })
  }

  /**
   * Resolve a contradiction by superseding the loser. The loser is kept and readable: the record
   * of having believed something is part of the history of believing the other thing.
   */
  resolve(keepId, dropId, { reason, actor = 'user', force = false }) {
    const keep = this.get(keepId)
    const drop = this.get(dropId)
    if (!keep || !drop) throw new FabricError('both entries must exist to resolve a conflict', 'not_found')
    if (!reason || !String(reason).trim()) throw new FabricError('resolving a conflict needs a reason', 'missing_reason')
    if (
      drop.verification.verified &&
      !keep.verification.verified &&
      !force
    ) {
      throw new FabricError(
        `refusing to replace verified entry ${dropId} with unverified entry ${keepId}; pass force with a reason if that is really intended`,
        'would_downgrade',
        { keep: keepId, drop: dropId },
      )
    }
    this.db.prepare('UPDATE fabric_entries SET superseded_by = ?, updated_at = ? WHERE id = ?').run(keepId, this.now(), dropId)
    this.#addProvenance(keepId, {
      kind: PROVENANCE_KINDS.USER_STATEMENT,
      source: actor,
      detail: { resolvedConflict: true, superseded: dropId, reason, forced: force === true },
    })
    return Object.freeze({ kept: keepId, superseded: dropId, reason, forced: force === true })
  }

  /** The whole version chain this entry belongs to, oldest first. */
  history(id) {
    let cursor = this.get(id)
    if (!cursor) throw new FabricError(`no entry '${id}'`, 'not_found')
    while (cursor.supersedes) {
      const previous = this.get(cursor.supersedes)
      if (!previous) break
      cursor = previous
    }
    const chain = [cursor]
    while (chain.at(-1).supersededBy) {
      const next = this.get(chain.at(-1).supersededBy)
      if (!next) break
      chain.push(next)
    }
    return Object.freeze(chain)
  }

  /**
   * Delete an entry and its provenance. A memory belongs to the person it is about, so the
   * provenance goes with it: the tombstone records that something was deleted, when, by whom and
   * why, and keeps no subject, no content and no value.
   */
  forget(id, { actor = 'user', reason = 'user requested deletion' } = {}) {
    const existing = this.get(id)
    if (!existing) throw new FabricError(`no entry '${id}'`, 'not_found')
    if (!reason || !String(reason).trim()) throw new FabricError('a deletion needs a reason', 'missing_reason')
    const provenanceCount = existing.provenance.length
    this.db.exec('BEGIN')
    try {
      // Clear links first: a supersede pointer to a row about to disappear would make the
      // deletion fail under foreign keys, and the link is bookkeeping rather than content.
      this.db.prepare('UPDATE fabric_entries SET superseded_by = NULL WHERE superseded_by = ?').run(id)
      this.db.prepare('UPDATE fabric_entries SET supersedes = NULL WHERE supersedes = ?').run(id)
      this.db.prepare('DELETE FROM fabric_provenance WHERE entry_id = ?').run(id)
      this.db.prepare('DELETE FROM fabric_entries WHERE id = ?').run(id)
      this.db.prepare(
        'INSERT INTO fabric_tombstones (id, entry_id, layer, deleted_at, actor, reason, provenance_removed) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(`tomb_${randomUUID()}`, id, existing.layer, this.now(), actor, reason, provenanceCount)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return Object.freeze({ deleted: true, entryId: id, layer: existing.layer, provenanceRemoved: provenanceCount })
  }

  tombstones() {
    return this.db.prepare('SELECT * FROM fabric_tombstones ORDER BY deleted_at').all().map((row) => Object.freeze({
      id: row.id,
      entryId: row.entry_id,
      layer: row.layer,
      deletedAt: row.deleted_at,
      actor: row.actor,
      reason: row.reason,
      provenanceRemoved: row.provenance_removed,
    }))
  }

  /** Working memory is the current task's scratch space; ending the task clears it. */
  clearWorking(scope) {
    const result = this.db.prepare(`DELETE FROM fabric_provenance WHERE entry_id IN (
      SELECT id FROM fabric_entries WHERE layer = ? AND scope_kind = ? AND COALESCE(scope_id,'') = COALESCE(?,''))`)
      .run(LAYERS.WORKING, scope.kind, scope.id ?? null)
    const entries = this.db.prepare(
      `DELETE FROM fabric_entries WHERE layer = ? AND scope_kind = ? AND COALESCE(scope_id,'') = COALESCE(?,'')`,
    ).run(LAYERS.WORKING, scope.kind, scope.id ?? null)
    return Object.freeze({ entriesRemoved: entries.changes, provenanceRemoved: result.changes })
  }

  /**
   * Export what the caller is allowed to take. `exportable` is per entry and defaults to false,
   * because a memory that can leave the machine by default is a memory that leaves.
   */
  exportAll({ as = 'owner' } = {}) {
    const rows = this.db.prepare('SELECT * FROM fabric_entries WHERE exportable = 1 ORDER BY created_at').all()
    const included = []
    const withheld = []
    for (const row of rows) {
      const readers = JSON.parse(row.readers)
      if (readers.includes(as)) included.push(this.#decorate(row))
      else withheld.push({ id: row.id, reason: `'${as}' is not a permitted reader` })
    }
    const notExportable = this.db.prepare('SELECT COUNT(*) AS n FROM fabric_entries WHERE exportable = 0').get().n
    return Object.freeze({
      entries: Object.freeze(included),
      withheld: Object.freeze(withheld),
      notExportable,
      note: `${notExportable} entr(ies) are marked not exportable and are not in this export at all`,
    })
  }

  /** What a status page reads. Counts, never content. */
  inspect() {
    const byLayer = {}
    for (const layer of Object.values(LAYERS)) {
      byLayer[layer] = this.db.prepare('SELECT COUNT(*) AS n FROM fabric_entries WHERE layer = ?').get(layer).n
    }
    return Object.freeze({
      entries: this.db.prepare('SELECT COUNT(*) AS n FROM fabric_entries').get().n,
      live: this.db.prepare('SELECT COUNT(*) AS n FROM fabric_entries WHERE superseded_by IS NULL').get().n,
      byLayer: Object.freeze(byLayer),
      verified: this.db.prepare(`SELECT COUNT(*) AS n FROM fabric_entries WHERE verification_status = 'verified'`).get().n,
      unverified: this.db.prepare(`SELECT COUNT(*) AS n FROM fabric_entries WHERE verification_status = 'unverified'`).get().n,
      provenanceRecords: this.db.prepare('SELECT COUNT(*) AS n FROM fabric_provenance').get().n,
      conflicts: this.conflicts().length,
      tombstones: this.db.prepare('SELECT COUNT(*) AS n FROM fabric_tombstones').get().n,
      trainingUse: 'prohibited for every entry, enforced by a CHECK on the table',
    })
  }

  close() {
    this.db.close()
  }
}

/**
 * A reference checker for the skill registry and the episode log, so a `skill` or `episodic`
 * entry that points at a version or an episode that does not exist is refused at write time.
 */
export function referencesFrom({ skills = null, episodes = null } = {}) {
  // Absence is the answer this checker gives; a registry *failing* is not an absence, so only the
  // not-found codes are absorbed and anything else propagates. Swallowing every error here would
  // turn a broken registry into "the reference does not exist", which is a different sentence.
  const ABSENT = new Set(['unknown_skill', 'unknown_version', 'not_found'])
  return (reference) => {
    if (reference.kind === 'skill') {
      if (!skills) return false
      try {
        return Boolean(skills.document(reference.name, reference.version))
      } catch (error) {
        if (ABSENT.has(error?.code)) return false
        throw error
      }
    }
    if (reference.kind === 'episode') {
      if (!episodes) return false
      const records = episodes.list()
      return records.some((record) => record.seq === reference.seq && (!reference.digest || record.digest === reference.digest))
    }
    return false
  }
}
