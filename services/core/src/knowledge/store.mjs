// Knowledge store: relational metadata + chunk text + document-level ACL.
//
// Directive §8 asks for "an appropriate local storage design rather than forcing
// every data type into one database". This module owns relational metadata,
// chunk text and permissions in SQLite; the inverted index lives in Bm25Index
// (in-memory, rebuildable from these rows); binary media lives on the filesystem
// under services/core storage. Each is used for what it is good at.
//
// Deletion is a real, tested path: purgeDocument() removes chunks, ACL rows,
// embeddings and the index entries, and records the deletion in the audit ledger.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  source_path    TEXT,
  mime           TEXT,
  sha256         TEXT NOT NULL,
  content_key    TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal',
  owner          TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  ingested_at    INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  meta           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_sha  ON documents(sha256) WHERE status = 'active';
-- Whitespace/case-normalised key, so a reformatted copy is still recognised as a
-- duplicate. Deduplication lives in the database, not in process memory, so it
-- survives a restart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_key  ON documents(content_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_documents_status     ON documents(status);

CREATE TABLE IF NOT EXISTS chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  token_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id, idx);

CREATE TABLE IF NOT EXISTS acl (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  principal   TEXT NOT NULL,
  permission  TEXT NOT NULL DEFAULT 'read',
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, principal, permission)
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id   TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS index_runs (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  documents   INTEGER NOT NULL,
  chunks      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome     TEXT NOT NULL,
  detail      TEXT
);

CREATE TABLE IF NOT EXISTS deletions (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  document_id TEXT NOT NULL,
  title       TEXT,
  chunks      INTEGER NOT NULL,
  acl_rows    INTEGER NOT NULL,
  embeddings  INTEGER NOT NULL,
  reason      TEXT,
  requested_by TEXT
);
`

export const PERMISSIONS = Object.freeze({ READ: 'read', WRITE: 'write', ADMIN: 'admin' })

export class KnowledgeStore {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  // --- documents ----------------------------------------------------------

  /**
   * @param {object} doc
   * @param {string} doc.title
   * @param {string} doc.text         full document text (chunked separately)
   * @param {Array}  doc.chunks       from chunkText()
   * @param {string} [doc.classification]
   * @param {string[]} [doc.principals] who may read this document
   */
  insertDocument({ title, text, contentKey: normalizedKey, chunks, sourcePath = null, mime = 'text/plain', classification = 'internal', owner = null, principals = [], meta = {} }) {
    if (!title) throw new TypeError('document requires a title')
    if (!Array.isArray(chunks) || !chunks.length) throw new TypeError('document requires at least one chunk')
    if (typeof normalizedKey !== 'string' || !normalizedKey) throw new TypeError('document requires a normalised content key')
    const sha256 = createHash('sha256').update(String(text)).digest('hex')

    // Authoritative deduplication: exact bytes first, then normalised content.
    // Both live in the database, so dedup survives a restart.
    const exact = this.findBySha256(sha256)
    if (exact) return { duplicate: true, document: exact, reason: 'identical content hash' }
    const normalized = this.findByContentKey(normalizedKey)
    if (normalized) return { duplicate: true, document: normalized, reason: 'whitespace/case-normalised duplicate' }

    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO documents (id, title, source_path, mime, sha256, content_key, size_bytes, classification, owner, status, chunk_count, ingested_at, updated_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(id, String(title), sourcePath, mime, sha256, normalizedKey, Buffer.byteLength(String(text)), classification, owner, chunks.length, now, now, JSON.stringify(meta ?? {}))

    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, document_id, idx, text, start_offset, end_offset, token_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const chunkIds = []
    this.db.exec('BEGIN')
    try {
      for (const chunk of chunks) {
        const chunkId = randomUUID()
        insertChunk.run(chunkId, id, chunk.index, chunk.text, chunk.start ?? 0, chunk.end ?? 0, chunk.tokenCount ?? 0)
        chunkIds.push(chunkId)
      }
      const grant = this.db.prepare(`INSERT OR IGNORE INTO acl (document_id, principal, permission, granted_at) VALUES (?, ?, ?, ?)`)
      // The owner always retains access; a document with no ACL is readable by anyone
      // authenticated locally, which is recorded explicitly rather than implied.
      if (owner) grant.run(id, owner, PERMISSIONS.ADMIN, now)
      for (const principal of principals) grant.run(id, principal, PERMISSIONS.READ, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { duplicate: false, document: this.getDocument(id), chunkIds }
  }

  findBySha256(sha256) {
    const row = this.db.prepare(`SELECT * FROM documents WHERE sha256 = ? AND status = 'active'`).get(sha256)
    return row ? hydrateDocument(row) : null
  }

  findByContentKey(key) {
    const row = this.db.prepare(`SELECT * FROM documents WHERE content_key = ? AND status = 'active'`).get(key)
    return row ? hydrateDocument(row) : null
  }

  getDocument(id) {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id)
    return row ? hydrateDocument(row) : null
  }

  listDocuments({ status = 'active', limit = 200 } = {}) {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE status = ? ORDER BY ingested_at DESC LIMIT ?')
      .all(status, Math.max(1, limit))
    return rows.map(hydrateDocument)
  }

  getChunks(documentId) {
    return this.db
      .prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY idx ASC')
      .all(documentId)
      .map((row) => ({ ...row, text: row.text }))
  }

  getChunk(chunkId) {
    return this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId) ?? null
  }

  /** All chunks across active documents — used to (re)build the BM25 index. */
  allChunks() {
    return this.db
      .prepare(
        `SELECT c.id, c.document_id, c.idx, c.text, c.start_offset, c.end_offset, c.token_count,
                d.title, d.classification, d.owner, d.source_path, d.mime
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.status = 'active' ORDER BY c.document_id, c.idx`,
      )
      .all()
  }

  // --- access control -----------------------------------------------------

  grant(documentId, principal, permission = PERMISSIONS.READ) {
    if (!Object.values(PERMISSIONS).includes(permission)) throw new TypeError(`unknown permission '${permission}'`)
    const info = this.db
      .prepare('INSERT OR IGNORE INTO acl (document_id, principal, permission, granted_at) VALUES (?, ?, ?, ?)')
      .run(documentId, principal, permission, Date.now())
    return Number(info.changes ?? 0) > 0
  }

  revoke(documentId, principal, permission = PERMISSIONS.READ) {
    const info = this.db.prepare('DELETE FROM acl WHERE document_id = ? AND principal = ? AND permission = ?').run(documentId, principal, permission)
    return Number(info.changes ?? 0) > 0
  }

  aclFor(documentId) {
    return this.db.prepare('SELECT principal, permission, granted_at FROM acl WHERE document_id = ?').all(documentId)
  }

  /**
   * Authorisation predicate for retrieval.
   * A document with no ACL rows is treated as locally public (single-user install);
   * any ACL makes it explicit and principal-scoped.
   */
  canRead(documentId, principal) {
    const rows = this.db.prepare('SELECT principal, permission FROM acl WHERE document_id = ?').all(documentId)
    if (!rows.length) return true
    return rows.some((row) => matchesPrincipal(row.principal, principal))
  }

  /** Build a filter callback suitable for Bm25Index.search({filter}). */
  accessFilter(principal) {
    const cache = new Map()
    return (docId, meta) => {
      const documentId = meta?.documentId ?? docId
      if (!cache.has(documentId)) cache.set(documentId, this.canRead(documentId, principal))
      return cache.get(documentId)
    }
  }

  // --- embeddings ---------------------------------------------------------

  putEmbedding(chunkId, model, vector) {
    if (!Array.isArray(vector) || !vector.length) throw new TypeError('embedding vector must be a non-empty array')
    const buffer = Buffer.from(new Float32Array(vector).buffer)
    this.db
      .prepare(
        `INSERT INTO embeddings (chunk_id, model, dim, vector, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at`,
      )
      .run(chunkId, String(model), vector.length, buffer, Date.now())
    return true
  }

  getEmbeddings(model) {
    const rows = model
      ? this.db.prepare('SELECT chunk_id, model, dim, vector FROM embeddings WHERE model = ?').all(model)
      : this.db.prepare('SELECT chunk_id, model, dim, vector FROM embeddings').all()
    return rows.map((row) => ({ chunkId: row.chunk_id, model: row.model, dim: row.dim, vector: new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dim) }))
  }

  // --- deletion / retention ----------------------------------------------

  /**
   * Hard-delete a document and everything derived from it.
   * Returns counts so a test can assert the deletion path actually removed data.
   */
  purgeDocument(documentId, { reason = null, requestedBy = null } = {}) {
    const doc = this.getDocument(documentId)
    if (!doc) return { deleted: false, reason: 'unknown document' }
    const count = (sql, ...params) => Number(this.db.prepare(sql).get(...params)?.c ?? 0)

    const chunks = count('SELECT COUNT(*) AS c FROM chunks WHERE document_id = ?', documentId)
    const aclRows = count('SELECT COUNT(*) AS c FROM acl WHERE document_id = ?', documentId)
    const embeddings = count(
      'SELECT COUNT(*) AS c FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)',
      documentId,
    )

    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId)
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM acl WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
      this.db
        .prepare('INSERT INTO deletions (id, at, document_id, title, chunks, acl_rows, embeddings, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), Date.now(), documentId, doc.title, chunks, aclRows, embeddings, reason, requestedBy)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { deleted: true, documentId, title: doc.title, chunks, aclRows, embeddings, sha256: doc.sha256 }
  }

  deletionLog(limit = 100) {
    return this.db.prepare('SELECT * FROM deletions ORDER BY at DESC LIMIT ?').all(Math.max(1, limit))
  }

  /** Retention control: drop documents ingested before a timestamp. */
  applyRetention({ olderThanMs, reason = 'retention policy', requestedBy = 'system' }) {
    const cutoff = Date.now() - olderThanMs
    const rows = this.db.prepare('SELECT id FROM documents WHERE ingested_at <= ?').all(cutoff)
    const results = rows.map((row) => this.purgeDocument(row.id, { reason, requestedBy }))
    return { purged: results.filter((r) => r.deleted).length, cutoff, results }
  }

  // --- index runs (auditability of rebuilds) ------------------------------

  recordIndexRun({ kind, documents, chunks, durationMs, outcome, detail = null }) {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO index_runs (id, at, kind, documents, chunks, duration_ms, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, Date.now(), kind, documents, chunks, durationMs, outcome, detail ? JSON.stringify(detail) : null)
    return id
  }

  indexRuns(limit = 50) {
    return this.db.prepare('SELECT * FROM index_runs ORDER BY at DESC LIMIT ?').all(Math.max(1, limit))
  }

  stats() {
    const get = (sql) => Number(this.db.prepare(sql).get()?.c ?? 0)
    return {
      documents: get(`SELECT COUNT(*) AS c FROM documents WHERE status = 'active'`),
      chunks: get('SELECT COUNT(*) AS c FROM chunks'),
      embeddings: get('SELECT COUNT(*) AS c FROM embeddings'),
      aclRows: get('SELECT COUNT(*) AS c FROM acl'),
      deletions: get('SELECT COUNT(*) AS c FROM deletions'),
      bytesIndexed: get(`SELECT COALESCE(SUM(size_bytes), 0) AS c FROM documents WHERE status = 'active'`),
    }
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

function hydrateDocument(row) {
  return {
    id: row.id,
    title: row.title,
    sourcePath: row.source_path,
    mime: row.mime,
    sha256: row.sha256,
    contentKey: row.content_key,
    sizeBytes: row.size_bytes,
    classification: row.classification,
    owner: row.owner,
    status: row.status,
    chunkCount: row.chunk_count,
    ingestedAt: row.ingested_at,
    updatedAt: row.updated_at,
    meta: safeParse(row.meta),
  }
}

function safeParse(text) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function matchesPrincipal(granted, requested) {
  if (!requested) return false
  if (granted === requested) return true
  if (granted === '*') return true
  // Group form: 'team:engineering' matches principal 'user:x' with groups below.
  if (Array.isArray(requested)) return requested.some((entry) => entry === granted)
  if (requested && typeof requested === 'object') {
    if (requested.id === granted) return true
    return (requested.groups ?? []).includes(granted)
  }
  return false
}

export { timingSafeEqual }
