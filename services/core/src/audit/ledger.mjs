// Persistent audit ledger backed by node:sqlite (Node >= 22.5, zero dependencies).
//
// Every egress decision, policy denial, tool invocation, plugin action, model
// release and training event is recorded here. Directive §10 requires MCP/plugin
// actions to return "structured results with traceable outcomes"; §8 requires
// auditable index updates and a tested deletion path. Both land in this ledger.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  at          INTEGER NOT NULL,
  category    TEXT NOT NULL,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  actor       TEXT,
  subject     TEXT,
  policy      TEXT,
  detail      TEXT,
  redacted    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_seq      ON audit_events(seq);
CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_events(category, at);
CREATE INDEX IF NOT EXISTS idx_audit_subject  ON audit_events(subject);
`

export const AUDIT_OUTCOMES = Object.freeze({
  ALLOWED: 'allowed',
  DENIED: 'denied',
  SUCCESS: 'success',
  FAILURE: 'failure',
  INFO: 'info',
})

export class AuditLedger {
  /** @param {string} file path to the sqlite file, or ':memory:' */
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM audit_events').get()
    this.#seq = Number(row?.s ?? 0)
    this.#insert = this.db.prepare(
      `INSERT INTO audit_events (id, seq, at, category, action, outcome, actor, subject, policy, detail, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.#page = this.db.prepare(
      `SELECT * FROM audit_events WHERE seq <= ? AND (? = '' OR category = ?)
       ORDER BY seq DESC LIMIT ?`,
    )
  }

  #seq
  #insert
  #page

  /**
   * @param {object} e
   * @param {string} e.category  e.g. 'egress' | 'policy' | 'mcp' | 'plugin' | 'model' | 'training' | 'knowledge' | 'media' | 'task'
   * @param {string} e.action
   * @param {string} e.outcome   one of AUDIT_OUTCOMES
   */
  record({ category, action, outcome = AUDIT_OUTCOMES.INFO, actor = null, subject = null, policy = null, detail = null, redacted = null }) {
    if (!category || !action) throw new TypeError('audit event requires category and action')
    const id = randomUUID()
    this.#seq += 1
    this.#insert.run(
      id,
      this.#seq,
      Date.now(),
      String(category),
      String(action),
      String(outcome),
      actor == null ? null : String(actor),
      subject == null ? null : String(subject),
      policy == null ? null : String(policy),
      detail == null ? null : JSON.stringify(detail),
      redacted == null ? null : JSON.stringify(redacted),
    )
    return { id, seq: this.#seq, category, action, outcome }
  }

  /** Newest-first, cursor-paginated by seq so large ledgers stay bounded. */
  query({ limit = 50, beforeSeq = Number.MAX_SAFE_INTEGER, category = '' } = {}) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 50))
    const rows = this.#page.all(beforeSeq, category, category, capped)
    return rows.map((row) => ({
      ...row,
      detail: row.detail ? safeParse(row.detail) : null,
      redacted: row.redacted ? safeParse(row.redacted) : null,
    }))
  }

  count(category = null) {
    const row = category
      ? this.db.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE category = ?').get(category)
      : this.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get()
    return Number(row?.c ?? 0)
  }

  /** NDJSON export for offline review (mirrors Aetheris' audit export contract). */
  exportNdjson() {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq ASC').all()
    return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
  }

  /**
   * Tested deletion path: erase every event mentioning a subject (e.g. a document
   * id or conversation id) so retention controls actually remove evidence.
   */
  purgeSubject(subject) {
    const info = this.db.prepare('DELETE FROM audit_events WHERE subject = ?').run(String(subject))
    return Number(info.changes ?? 0)
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}
