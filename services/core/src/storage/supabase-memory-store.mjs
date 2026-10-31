import { randomUUID } from 'node:crypto'
import { Bm25Index } from '../knowledge/bm25.mjs'
import {
  APPROVER, CANDIDATE_STATES, LIMITS, MEMORY_KINDS, MEMORY_MECHANISMS, MemoryError,
} from '../memory/contracts.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TABLES = Object.freeze({
  memories: 'ragam_memories',
  candidates: 'ragam_memory_candidates',
  sessions: 'ragam_chat_sessions',
  turns: 'ragam_chat_turns',
  deletions: 'ragam_memory_deletions',
})
const PAGE_SIZE = 500
const MAX_SCAN_ROWS = 10_000

export class SupabaseMemoryStoreError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SupabaseMemoryStoreError'
    this.code = code
  }
}

function validUuid(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SupabaseMemoryStoreError(code)
  return value
}

function integer(value, code) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new SupabaseMemoryStoreError(code)
  return number
}

function rpcObject(value, code) {
  const result = Array.isArray(value) ? value[0] : value
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SupabaseMemoryStoreError(code)
  return result
}

function validateTags(tags) {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new MemoryError('memory tags must be a list of text labels', 'invalid_tags')
  }
  return tags
}

function hydrateMemory(row, owner) {
  if (!row || row.account_id !== owner || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.text !== 'string' || !Array.isArray(row.tags)
      || !['approved', 'superseded'].includes(row.status)
      || row.approved_by !== APPROVER || row.consent !== 'user_approved'
      || row.purpose !== 'personal_context' || row.training_use !== 'prohibited') {
    throw new SupabaseMemoryStoreError('supabase_memory_row_invalid')
  }
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    subject: row.subject ?? null,
    tags: row.tags,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: integer(row.approved_at, 'supabase_memory_row_invalid'),
    createdAt: integer(row.created_at, 'supabase_memory_row_invalid'),
    updatedAt: integer(row.updated_at, 'supabase_memory_row_invalid'),
    supersededBy: row.superseded_by ?? null,
    sourceKind: row.source_kind,
    sourceSession: row.source_session ?? null,
    dataClass: row.data_class,
    consent: row.consent,
    purpose: row.purpose,
    trainingUse: row.training_use,
  }
}

function hydrateCandidate(row, owner) {
  if (!row || row.account_id !== owner || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.text !== 'string' || !Object.values(CANDIDATE_STATES).includes(row.status)) {
    throw new SupabaseMemoryStoreError('supabase_memory_candidate_invalid')
  }
  return {
    id: row.id,
    text: row.text,
    rationale: row.rationale ?? null,
    proposedFrom: row.proposed_from,
    proposedAt: integer(row.proposed_at, 'supabase_memory_candidate_invalid'),
    status: row.status,
    decidedAt: row.decided_at === null ? null : integer(row.decided_at, 'supabase_memory_candidate_invalid'),
    decidedBy: row.decided_by ?? null,
    memoryId: row.memory_id ?? null,
  }
}

function hydrateSession(row, owner) {
  if (!row || row.account_id !== owner || typeof row.id !== 'string' || !UUID.test(row.id)) {
    throw new SupabaseMemoryStoreError('supabase_memory_session_invalid')
  }
  return {
    id: row.id,
    title: row.title ?? null,
    startedAt: integer(row.started_at, 'supabase_memory_session_invalid'),
    lastAt: integer(row.last_at, 'supabase_memory_session_invalid'),
    turnCount: integer(row.turn_count, 'supabase_memory_session_invalid'),
  }
}

function hydrateTurn(row, owner) {
  if (!row || row.account_id !== owner || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.session_id !== 'string' || !UUID.test(row.session_id)
      || !['user', 'assistant', 'system'].includes(row.role) || typeof row.content !== 'string') {
    throw new SupabaseMemoryStoreError('supabase_memory_turn_invalid')
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    idx: integer(row.idx, 'supabase_memory_turn_invalid'),
    role: row.role,
    content: row.content,
    createdAt: integer(row.created_at, 'supabase_memory_turn_invalid'),
    dataClass: row.data_class ?? 'internal',
  }
}

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

/**
 * Async account-owned counterpart of MemoryStore. Multi-row changes use narrowly scoped
 * database RPCs; every direct PostgREST read/write also includes the authenticated account id.
 * BM25 remains derived, per-invocation state and is rebuilt from approved rows on retrieval.
 */
export class SupabaseMemoryStore {
  #client
  #accountId
  #now

  constructor({ client, accountId, now = () => Date.now(), limits = LIMITS } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseMemoryStoreError('supabase_client_invalid')
    if (typeof now !== 'function') throw new SupabaseMemoryStoreError('supabase_clock_invalid')
    this.#client = client
    this.#accountId = validUuid(accountId, 'supabase_account_id_invalid')
    this.#now = now
    this.limits = { ...LIMITS, ...limits }
  }

  async #rows(name, { filters = [], order = 'id.asc', limit = 2000 } = {}) {
    const table = TABLES[name]
    if (!table) throw new SupabaseMemoryStoreError('supabase_memory_table_invalid')
    const cap = Math.max(0, Math.min(MAX_SCAN_ROWS + 1, Number.isInteger(limit) ? limit : 2000))
    const rows = []
    for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
      const pageLimit = Math.min(PAGE_SIZE, cap - offset)
      const query = new URLSearchParams([
        ['select', '*'], ['account_id', `eq.${this.#accountId}`], ...filters,
        ['order', order], ['limit', String(pageLimit)], ['offset', String(offset)],
      ]).toString()
      const page = await this.#client.request(`rest/v1/${table}`, { method: 'GET', query })
      if (!Array.isArray(page) || page.some((row) => row?.account_id !== this.#accountId)) {
        throw new SupabaseMemoryStoreError('supabase_memory_rows_invalid')
      }
      rows.push(...page)
      if (page.length < pageLimit) break
    }
    return rows
  }

  async #row(name, id) {
    const rows = await this.#rows(name, { filters: [['id', `eq.${validUuid(id, 'supabase_row_id_invalid')}`]], limit: 2 })
    if (rows.length > 1) throw new SupabaseMemoryStoreError('supabase_memory_row_duplicated')
    return rows[0] ?? null
  }

  async #rpc(name, body) {
    const result = rpcObject(await this.#client.request(`rest/v1/rpc/${name}`, { method: 'POST', body }), 'supabase_memory_rpc_invalid')
    if (result.ok !== true) {
      const code = typeof result.code === 'string' && /^[a-z0-9_]{1,64}$/.test(result.code)
        ? result.code
        : 'supabase_memory_operation_failed'
      throw new MemoryError(code, code)
    }
    return result
  }

  async #write(name, method, id, body, { conflict = null } = {}) {
    const table = TABLES[name]
    const owner = this.#accountId
    const query = method === 'POST'
      ? (conflict ? `on_conflict=${encodeURIComponent(conflict)}` : '')
      : new URLSearchParams([['account_id', `eq.${owner}`], ['id', `eq.${validUuid(id, 'supabase_row_id_invalid')}`], ['select', '*']]).toString()
    const response = await this.#client.request(`rest/v1/${table}`, {
      method,
      query,
      headers: { prefer: 'return=representation' },
      body: method === 'POST' ? { ...body, account_id: owner } : body,
    })
    if (!Array.isArray(response) || response.length > 1
        || response.some((row) => row?.account_id !== owner)) {
      throw new SupabaseMemoryStoreError('supabase_memory_write_invalid')
    }
    return response[0] ?? null
  }

  async remember({ text, kind = MEMORY_KINDS.FACT, subject = null, tags = [], sourceSession = null,
    dataClass = 'internal', sourceKind = 'user_statement' } = {}) {
    const clean = String(text ?? '').trim()
    if (!clean) throw new MemoryError('a memory needs text', 'text_required')
    if (clean.length > this.limits.maxMemoryChars) {
      throw new MemoryError(`a memory may be at most ${this.limits.maxMemoryChars} characters; this is ${clean.length}. A memory is a statement, not a document -- put documents in the knowledge store.`, 'too_long')
    }
    if (!Object.values(MEMORY_KINDS).includes(kind)) {
      throw new MemoryError(`unknown kind '${kind}'; known kinds are ${Object.values(MEMORY_KINDS).join(', ')}`, 'unknown_kind')
    }
    const checkedTags = validateTags(tags)
    const result = await this.#rpc('ragam_memory_remember', {
      p_account_id: this.#accountId,
      p_id: randomUUID(),
      p_text: clean,
      p_kind: kind,
      p_subject: subject,
      p_tags: checkedTags,
      p_source_kind: sourceKind,
      p_source_session: sourceSession,
      p_data_class: dataClass,
      p_now: this.#now(),
      p_max_memories: this.limits.maxMemories,
    })
    return { duplicate: result.duplicate === true, memory: hydrateMemory(result.memory, this.#accountId) }
  }

  async getMemory(id) {
    const row = await this.#row('memories', id)
    return row ? hydrateMemory(row, this.#accountId) : null
  }

  async listMemories({ status = 'approved', limit = 200 } = {}) {
    if (!['approved', 'superseded'].includes(status)) throw new MemoryError(`unknown memory status '${status}'`, 'unknown_status')
    const cap = Math.max(1, Math.min(2000, Number.isInteger(limit) ? limit : 200))
    const rows = await this.#rows('memories', {
      filters: [['status', `eq.${status}`]], order: 'created_at.desc,id.desc', limit: cap,
    })
    return rows.map((row) => hydrateMemory(row, this.#accountId))
  }

  async updateMemory(id, patch = {}) {
    const current = await this.getMemory(id)
    if (!current) throw new MemoryError(`no memory '${id}'`, 'not_found')
    const text = patch.text === undefined ? current.text : String(patch.text).trim()
    if (!text) throw new MemoryError('a memory needs text', 'text_required')
    if (text.length > this.limits.maxMemoryChars) throw new MemoryError(`a memory may be at most ${this.limits.maxMemoryChars} characters`, 'too_long')
    const kind = patch.kind ?? current.kind
    if (!Object.values(MEMORY_KINDS).includes(kind)) throw new MemoryError(`unknown kind '${kind}'`, 'unknown_kind')
    const subject = patch.subject === undefined ? current.subject : patch.subject
    const tags = validateTags(patch.tags ?? current.tags)
    const row = await this.#write('memories', 'PATCH', id, { text, kind, subject, tags, updated_at: this.#now() })
    if (!row) throw new MemoryError(`no memory '${id}'`, 'not_found')
    return hydrateMemory(row, this.#accountId)
  }

  async supersede(id, { text, kind = null, subject = undefined, tags = undefined } = {}) {
    const current = await this.getMemory(id)
    if (!current) throw new MemoryError(`no memory '${id}'`, 'not_found')
    if (current.status !== 'approved') throw new MemoryError(`memory '${id}' is '${current.status}' and cannot be superseded`, 'not_approved')
    const clean = String(text ?? '').trim()
    if (!clean) throw new MemoryError('a memory needs text', 'text_required')
    if (clean.length > this.limits.maxMemoryChars) throw new MemoryError(`a memory may be at most ${this.limits.maxMemoryChars} characters`, 'too_long')
    const selectedKind = kind ?? current.kind
    if (!Object.values(MEMORY_KINDS).includes(selectedKind)) throw new MemoryError(`unknown kind '${selectedKind}'`, 'unknown_kind')
    const result = await this.#rpc('ragam_memory_supersede', {
      p_account_id: this.#accountId,
      p_old_id: validUuid(id, 'supabase_row_id_invalid'),
      p_new_id: randomUUID(),
      p_text: clean,
      p_kind: selectedKind,
      p_subject: subject === undefined ? current.subject : subject,
      p_tags: validateTags(tags ?? current.tags),
      p_source_session: current.sourceSession,
      p_data_class: current.dataClass,
      p_now: this.#now(),
      p_max_memories: this.limits.maxMemories,
    })
    return {
      superseded: hydrateMemory(result.superseded, this.#accountId),
      replacement: hydrateMemory(result.replacement, this.#accountId),
      duplicate: result.duplicate === true,
    }
  }

  async forget(id, { reason = null, requestedBy = 'user' } = {}) {
    const result = await this.#rpc('ragam_memory_forget', {
      p_account_id: this.#accountId,
      p_memory_id: validUuid(id, 'supabase_row_id_invalid'),
      p_deletion_id: randomUUID(),
      p_now: this.#now(),
      p_reason: reason,
      p_requested_by: requestedBy,
    })
    return { deleted: true, memoryId: result.memory_id, textWas: result.text_was === true }
  }

  async forgetAll({ reason = 'user requested full memory deletion', requestedBy = 'user' } = {}) {
    const result = await this.#rpc('ragam_memory_forget_all', {
      p_account_id: this.#accountId, p_now: this.#now(), p_reason: reason, p_requested_by: requestedBy,
    })
    return { deletedMemories: integer(result.deleted_memories, 'supabase_memory_rpc_invalid'), deletedCandidates: integer(result.deleted_candidates, 'supabase_memory_rpc_invalid') }
  }

  async propose({ text, rationale = null, proposedFrom = 'conversation' } = {}) {
    const clean = String(text ?? '').trim()
    if (!clean) throw new MemoryError('a candidate needs text', 'text_required')
    if (clean.length > this.limits.maxMemoryChars) throw new MemoryError('candidate text is too long', 'too_long')
    if (!proposedFrom) throw new MemoryError('a candidate must record what proposed it', 'source_required')
    const row = await this.#write('candidates', 'POST', null, {
      id: randomUUID(), text: clean, rationale, proposed_from: proposedFrom,
      proposed_at: this.#now(), status: CANDIDATE_STATES.PENDING,
      decided_at: null, decided_by: null, memory_id: null,
    })
    return { id: row.id, text: row.text, status: row.status }
  }

  async listCandidates({ status = CANDIDATE_STATES.PENDING, limit = 100 } = {}) {
    if (!Object.values(CANDIDATE_STATES).includes(status)) throw new MemoryError(`unknown candidate status '${status}'`, 'unknown_status')
    const rows = await this.#rows('candidates', {
      filters: [['status', `eq.${status}`]], order: 'proposed_at.desc,id.desc',
      limit: Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 100)),
    })
    return rows.map((row) => hydrateCandidate(row, this.#accountId))
  }

  async decideCandidate(id, { approve, kind = MEMORY_KINDS.FACT, subject = null, tags = [] } = {}) {
    if (approve && !Object.values(MEMORY_KINDS).includes(kind)) throw new MemoryError(`unknown kind '${kind}'`, 'unknown_kind')
    const result = await this.#rpc('ragam_memory_decide_candidate', {
      p_account_id: this.#accountId,
      p_candidate_id: validUuid(id, 'supabase_row_id_invalid'),
      p_approve: approve === true,
      p_memory_id: randomUUID(),
      p_kind: kind,
      p_subject: subject,
      p_tags: validateTags(tags),
      p_now: this.#now(),
      p_max_memories: this.limits.maxMemories,
    })
    if (!result.approved) return { approved: false, candidate: hydrateCandidate(result.candidate, this.#accountId) }
    return {
      approved: true,
      memory: hydrateMemory(result.memory, this.#accountId),
      duplicate: result.duplicate === true,
    }
  }

  async contextFor(query, { limit = this.limits.maxContextMemories } = {}) {
    const text = String(query ?? '').trim()
    const capped = Math.min(Math.max(1, Number(limit) || this.limits.maxContextMemories), this.limits.maxContextMemories)
    if (!text) return { memories: await this.listMemories({ limit: capped }), matched: 'recency' }
    const rows = await this.#rows('memories', { filters: [['status', 'eq.approved']], order: 'id.asc', limit: this.limits.maxMemories })
    const index = new Bm25Index()
    const byId = new Map()
    for (const row of rows) {
      const memory = hydrateMemory(row, this.#accountId)
      byId.set(memory.id, memory)
      index.add(memory.id, `${memory.text} ${memory.subject ?? ''} ${memory.tags.join(' ')}`)
    }
    const memories = index.search(text, { topK: capped }).map((hit) => byId.get(hit.docId)).filter(Boolean)
    return { memories, matched: 'relevance', considered: index.size }
  }

  async searchMemories(query, { topK = 10 } = {}) {
    const rows = await this.#rows('memories', { filters: [['status', 'eq.approved']], order: 'id.asc', limit: this.limits.maxMemories })
    const index = new Bm25Index()
    const byId = new Map()
    for (const row of rows) {
      const memory = hydrateMemory(row, this.#accountId)
      byId.set(memory.id, memory)
      index.add(memory.id, `${memory.text} ${memory.subject ?? ''} ${memory.tags.join(' ')}`)
    }
    return index.search(query, { topK }).map((hit) => ({ ...hit, memory: byId.get(hit.docId) })).filter((hit) => hit.memory)
  }

  async buildContext(query, { limit } = {}) {
    const { memories, matched } = await this.contextFor(query, { limit })
    if (!memories.length) return { hasMemories: false, promptContext: '', memories: [], matched }
    const lines = memories.map((memory, index) => `[M${index + 1}] (${memory.kind}) ${memory.subject ? `${memory.subject}: ` : ''}${memory.text}`)
    return {
      hasMemories: true,
      matched,
      memories,
      promptContext: [
        'The following are things the user asked you to remember. Use them only when',
        'relevant. If they conflict with what the user says now, follow what the user',
        'says now. Do not mention this list unless the user refers to it.',
        ...lines,
      ].join('\n'),
    }
  }

  async startSession({ id = null, title = null } = {}) {
    const sessionId = validUuid(id ?? randomUUID(), 'supabase_row_id_invalid')
    const existing = await this.#row('sessions', sessionId)
    if (existing) return hydrateSession(existing, this.#accountId)
    const now = this.#now()
    const row = await this.#write('sessions', 'POST', null, {
      id: sessionId, title, started_at: now, last_at: now, turn_count: 0,
    })
    if (!row) throw new SupabaseMemoryStoreError('supabase_memory_session_write_invalid')
    return hydrateSession(row, this.#accountId)
  }

  async appendTurn(sessionId, { role, content, dataClass = 'internal' } = {}) {
    const session = validUuid(sessionId, 'supabase_row_id_invalid')
    if (!['user', 'assistant', 'system'].includes(role)) throw new MemoryError(`unknown role '${role}'`, 'unknown_role')
    const body = String(content ?? '')
    if (!body.trim()) throw new MemoryError('a turn needs content; an empty turn records nothing', 'content_required')
    const result = await this.#rpc('ragam_memory_append_turn', {
      p_account_id: this.#accountId, p_session_id: session, p_turn_id: randomUUID(),
      p_role: role, p_content: body, p_data_class: dataClass,
      p_now: this.#now(), p_max_turns: this.limits.maxTurnsPerSession,
    })
    const row = result.turn
    return {
      id: validUuid(row.id, 'supabase_memory_turn_invalid'),
      sessionId: validUuid(row.session_id, 'supabase_memory_turn_invalid'),
      idx: integer(row.idx, 'supabase_memory_turn_invalid'),
      role: row.role,
      createdAt: integer(row.created_at, 'supabase_memory_turn_invalid'),
    }
  }

  async listSessions({ limit = 50 } = {}) {
    const rows = await this.#rows('sessions', {
      order: 'last_at.desc,id.desc', limit: Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 50)),
    })
    return rows.map((row) => hydrateSession(row, this.#accountId))
  }

  async getSession(id) {
    const row = await this.#row('sessions', id)
    if (!row) return null
    const session = hydrateSession(row, this.#accountId)
    return { ...session, turns: await this.turns(id) }
  }

  async turns(sessionId, { limit = 500 } = {}) {
    const id = validUuid(sessionId, 'supabase_row_id_invalid')
    const rows = await this.#rows('turns', {
      filters: [['session_id', `eq.${id}`]], order: 'idx.asc,id.asc',
      limit: Math.max(1, Math.min(this.limits.maxTurnsPerSession, Number.isInteger(limit) ? limit : 500)),
    })
    return rows.map((row) => {
      const turn = hydrateTurn(row, this.#accountId)
      return { id: turn.id, idx: turn.idx, role: turn.role, content: turn.content, createdAt: turn.createdAt, dataClass: turn.dataClass }
    })
  }

  async deleteSession(id) {
    const result = await this.#rpc('ragam_memory_delete_session', {
      p_account_id: this.#accountId, p_session_id: validUuid(id, 'supabase_row_id_invalid'),
    })
    return { deleted: true, sessionId: id, turnsRemoved: integer(result.turns_removed, 'supabase_memory_rpc_invalid') }
  }

  async recall(query, { topK = 10 } = {}) {
    const text = String(query ?? '').trim()
    if (!text) return { query: text, hits: [], reason: 'empty query' }
    const capped = Math.min(Math.max(Number(topK) || 1, 1), this.limits.maxRecallResults)
    const [turnRows, sessionRows] = await Promise.all([
      this.#rows('turns', { order: 'id.asc', limit: MAX_SCAN_ROWS + 1 }),
      this.#rows('sessions', { order: 'id.asc', limit: MAX_SCAN_ROWS + 1 }),
    ])
    if (turnRows.length > MAX_SCAN_ROWS || sessionRows.length > MAX_SCAN_ROWS) {
      throw new MemoryError('session recall is capped at 10,000 rows per account to stay within bounded serverless work; no partial recall was returned', 'recall_limit')
    }
    const sessions = new Map(sessionRows.map((row) => [row.id, hydrateSession(row, this.#accountId)]))
    const turns = turnRows.map((row) => hydrateTurn(row, this.#accountId))
    const index = new Bm25Index()
    for (const turn of turns) index.add(turn.id, turn.content, { role: turn.role, sessionId: turn.sessionId })
    const hits = []
    const turnsById = new Map(turns.map((turn) => [turn.id, turn]))
    for (const hit of index.search(text, { topK: capped * 2 })) {
      const turn = turnsById.get(hit.docId)
      if (!turn) continue
      const session = sessions.get(turn.sessionId)
      hits.push({
        turnId: turn.id,
        sessionId: turn.sessionId,
        sessionTitle: session?.title ?? null,
        role: turn.role,
        at: turn.createdAt,
        score: hit.score,
        excerpt: excerpt(turn.content, text),
      })
      if (hits.length >= capped) break
    }
    return { query: text, hits, searchedTurns: index.size }
  }

  async stats() {
    const result = rpcObject(await this.#client.request('rest/v1/rpc/ragam_memory_stats', {
      method: 'POST', body: { p_account_id: this.#accountId },
    }), 'supabase_memory_stats_invalid')
    const keys = ['memories', 'supersededMemories', 'pendingCandidates', 'sessions', 'turns', 'deletionsRecorded']
    for (const key of keys) result[key] = integer(result[key], 'supabase_memory_stats_invalid')
    return { ...result, limits: this.limits, mechanisms: MEMORY_MECHANISMS }
  }

  async exportAll() {
    const [memoryRows, candidateRows, sessionRows, deletionRows, turnRows] = await Promise.all([
      this.#rows('memories', { order: 'created_at.asc,id.asc', limit: MAX_SCAN_ROWS + 1 }),
      this.#rows('candidates', { order: 'proposed_at.asc,id.asc', limit: MAX_SCAN_ROWS + 1 }),
      this.#rows('sessions', { order: 'started_at.asc,id.asc', limit: MAX_SCAN_ROWS + 1 }),
      this.#rows('deletions', { order: 'deleted_at.asc,id.asc', limit: MAX_SCAN_ROWS + 1 }),
      this.#rows('turns', { order: 'session_id.asc,idx.asc,id.asc', limit: MAX_SCAN_ROWS + 1 }),
    ])
    if ([memoryRows, candidateRows, sessionRows, deletionRows, turnRows].some((rows) => rows.length > MAX_SCAN_ROWS)) {
      throw new MemoryError('this hosted export exceeds the 10,000-row bounded response limit; no partial export was returned', 'export_limit')
    }
    const turnsBySession = new Map()
    for (const row of turnRows) {
      const turn = hydrateTurn(row, this.#accountId)
      if (!turnsBySession.has(turn.sessionId)) turnsBySession.set(turn.sessionId, [])
      turnsBySession.get(turn.sessionId).push({
        id: turn.id, idx: turn.idx, role: turn.role, content: turn.content,
        createdAt: turn.createdAt, dataClass: turn.dataClass,
      })
    }
    const sessions = sessionRows.map((row) => {
      const session = hydrateSession(row, this.#accountId)
      return { ...session, turns: turnsBySession.get(session.id) ?? [] }
    })
    return {
      format: 'aetheris-memory-export/v1',
      exportedAt: new Date(this.#now()).toISOString(),
      consent: 'user_approved',
      trainingUse: 'prohibited',
      memories: memoryRows.map((row) => hydrateMemory(row, this.#accountId)),
      candidates: candidateRows.map((row) => hydrateCandidate(row, this.#accountId)),
      sessions,
      deletions: deletionRows.map((row) => ({ memory_id: row.memory_id, deleted_at: integer(row.deleted_at, 'supabase_memory_deletion_invalid'), reason: row.reason ?? null })),
    }
  }

  async close() {}
}
