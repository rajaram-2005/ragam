import { createHash, randomUUID } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const MAX_SCAN_ROWS = 10_000
const MAX_PAGE_ROWS = 500
const PERMISSIONS = Object.freeze(['read', 'write', 'admin'])

export class SupabaseKnowledgeStoreError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SupabaseKnowledgeStoreError'
    this.code = code
  }
}

function validId(value, code) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SupabaseKnowledgeStoreError(code)
  return value
}

function bounded(value, fallback, maximum, code) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) throw new SupabaseKnowledgeStoreError(code)
  return Math.min(value, maximum)
}

function object(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SupabaseKnowledgeStoreError(code)
  }
  return value
}

function rows(value, code, accountId) {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || row.account_id !== accountId)) {
    throw new SupabaseKnowledgeStoreError(code)
  }
  return value
}

function query(entries) {
  return new URLSearchParams(entries).toString()
}

function hydrateDocument(row) {
  if (!row || typeof row.id !== 'string' || typeof row.title !== 'string' || !SHA256.test(row.sha256)
    || !Number.isSafeInteger(row.size_bytes) || !Number.isSafeInteger(row.ingested_at)
    || !Number.isSafeInteger(row.updated_at) || !Number.isSafeInteger(row.chunk_count)
    || !['public', 'internal', 'confidential', 'restricted'].includes(row.classification)
    || !['active', 'archived'].includes(row.status)
    || !row.meta || typeof row.meta !== 'object' || Array.isArray(row.meta)) {
    throw new SupabaseKnowledgeStoreError('supabase_knowledge_document_invalid')
  }
  return {
    id: row.id,
    title: row.title,
    sourcePath: row.source_label ?? null,
    mime: row.mime ?? null,
    sha256: row.sha256,
    contentKey: row.content_key,
    sizeBytes: Number(row.size_bytes),
    classification: row.classification,
    owner: row.account_id,
    status: row.status,
    chunkCount: row.chunk_count,
    ingestedAt: row.ingested_at,
    updatedAt: row.updated_at,
    meta: row.meta,
  }
}

function hydrateChunk(row) {
  if (!row || !UUID.test(row.id) || !UUID.test(row.document_id)
    || !Number.isSafeInteger(row.idx) || !Number.isSafeInteger(row.start_offset)
    || !Number.isSafeInteger(row.end_offset) || !Number.isSafeInteger(row.token_count)
    || typeof row.text !== 'string') {
    throw new SupabaseKnowledgeStoreError('supabase_knowledge_chunk_invalid')
  }
  return { ...row }
}

function matchesPrincipal(granted, requested) {
  if (!requested) return false
  if (granted === requested || granted === '*') return true
  if (Array.isArray(requested)) return requested.includes(granted)
  if (requested && typeof requested === 'object') {
    if (requested.id === granted) return true
    return Array.isArray(requested.groups) && requested.groups.includes(granted)
  }
  return false
}

function vectorBytes(value, dim) {
  let bytes
  if (typeof value === 'string' && /^\\x(?:[0-9a-f]{2})+$/i.test(value)) bytes = Buffer.from(value.slice(2), 'hex')
  else if (Buffer.isBuffer(value)) bytes = value
  else throw new SupabaseKnowledgeStoreError('supabase_knowledge_embedding_invalid')
  if (bytes.byteLength !== dim * 4) throw new SupabaseKnowledgeStoreError('supabase_knowledge_embedding_invalid')
  const copy = Uint8Array.from(bytes)
  return new Float32Array(copy.buffer)
}

/** Account-scoped PostgREST store for document metadata, chunks and retrieval bookkeeping. */
export class SupabaseKnowledgeStore {
  #client
  #accountId
  #now

  constructor({ client, accountId, now = () => Date.now() } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseKnowledgeStoreError('supabase_client_invalid')
    this.#client = client
    this.#accountId = validId(accountId, 'supabase_account_id_invalid')
    if (typeof now !== 'function') throw new SupabaseKnowledgeStoreError('supabase_clock_invalid')
    this.#now = now
  }

  async #rows(table, parameters, code, { maximum = MAX_PAGE_ROWS, order = null, rejectOverflow = true } = {}) {
    const entries = [
      ['select', '*'],
      ['account_id', `eq.${this.#accountId}`],
      ...parameters,
      ...(order ? [['order', order]] : []),
      ['limit', String(maximum + (rejectOverflow ? 1 : 0))],
    ]
    const result = rows(await this.#client.request(`rest/v1/${table}`, { method: 'GET', query: query(entries) }), code, this.#accountId)
    if (result.length > maximum) throw new SupabaseKnowledgeStoreError(code.replace(/_invalid$/, '_limit'))
    return result
  }

  async #one(table, parameters, code) {
    const result = await this.#rows(table, parameters, code, { maximum: 1 })
    return result[0] ?? null
  }

  async listDocuments({ status = 'active', limit = 200 } = {}) {
    if (!['active', 'archived'].includes(status)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_status_invalid')
    const boundedLimit = bounded(limit, 200, MAX_PAGE_ROWS, 'supabase_knowledge_limit_invalid')
    const result = await this.#rows('ragam_knowledge_documents', [['status', `eq.${status}`]], 'supabase_knowledge_rows_invalid', {
      maximum: boundedLimit, order: 'ingested_at.desc', rejectOverflow: false,
    })
    return result.map(hydrateDocument)
  }

  async getDocument(id) {
    const key = validId(id, 'supabase_knowledge_id_invalid')
    const row = await this.#one('ragam_knowledge_documents', [['id', `eq.${key}`]], 'supabase_knowledge_rows_invalid')
    return row ? hydrateDocument(row) : null
  }

  async findBySha256(sha256) {
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_sha_invalid')
    const row = await this.#one('ragam_knowledge_documents', [['sha256', `eq.${sha256}`], ['status', 'eq.active']], 'supabase_knowledge_rows_invalid')
    return row ? hydrateDocument(row) : null
  }

  async findByContentKey(key) {
    if (typeof key !== 'string' || !key || key.length > 2_000_000) throw new SupabaseKnowledgeStoreError('supabase_knowledge_key_invalid')
    const row = await this.#one('ragam_knowledge_documents', [['content_key', `eq.${key}`], ['status', 'eq.active']], 'supabase_knowledge_rows_invalid')
    return row ? hydrateDocument(row) : null
  }

  async insertDocument({ title, text, contentKey, chunks, sourcePath = null, mime = 'text/plain', classification = 'internal', owner = this.#accountId, principals = [], meta = {} } = {}) {
    if (typeof title !== 'string' || !title.trim() || title.length > 500) throw new TypeError('document requires a title of at most 500 characters')
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 20 * 1024 * 1024) throw new TypeError('document text is empty or exceeds the 20 MB limit')
    if (typeof contentKey !== 'string' || !contentKey || contentKey.length > 2_000_000) throw new TypeError('document requires a normalised content key')
    if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_SCAN_ROWS) throw new TypeError('document requires between 1 and 10,000 chunks')
    if (owner !== this.#accountId || !Array.isArray(principals) || principals.some((item) => typeof item !== 'string' || !item || item.length > 255)) {
      throw new SupabaseKnowledgeStoreError('supabase_knowledge_owner_invalid')
    }
    if (!['public', 'internal', 'confidential', 'restricted'].includes(classification)) throw new TypeError('unknown data classification')
    object(meta, 'supabase_knowledge_meta_invalid')
    const id = randomUUID()
    const chunkRows = chunks.map((chunk) => {
      object(chunk, 'supabase_knowledge_chunk_invalid')
      if (typeof chunk.text !== 'string' || !Number.isSafeInteger(chunk.index) || chunk.index < 0
        || !Number.isSafeInteger(chunk.start ?? 0) || !Number.isSafeInteger(chunk.end ?? 0)
        || !Number.isSafeInteger(chunk.tokenCount ?? 0)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_chunk_invalid')
      return {
        id: randomUUID(), idx: chunk.index, text: chunk.text,
        start_offset: chunk.start ?? 0, end_offset: chunk.end ?? 0, token_count: chunk.tokenCount ?? 0,
      }
    })
    const now = this.#now()
    if (!Number.isSafeInteger(now)) throw new SupabaseKnowledgeStoreError('supabase_clock_invalid')
    const sha256 = createHash('sha256').update(text).digest('hex')
    const document = {
      id, title: title.trim(), source_label: sourcePath, mime, sha256, content_key: contentKey,
      size_bytes: Buffer.byteLength(text), classification, status: 'active', chunk_count: chunkRows.length,
      ingested_at: now, updated_at: now, meta,
    }
    const result = await this.#client.request('rest/v1/rpc/ragam_knowledge_insert_document', {
      method: 'POST', body: {
        p_account_id: this.#accountId, p_document: document, p_chunks: chunkRows,
        p_principals: [...new Set(principals)], p_now: now,
      },
    })
    if (!result || result.ok !== true || typeof result.duplicate !== 'boolean' || !result.document) {
      throw new SupabaseKnowledgeStoreError(result?.code ?? 'supabase_knowledge_insert_invalid')
    }
    const stored = hydrateDocument({ ...result.document, account_id: this.#accountId })
    return { duplicate: result.duplicate, document: stored, reason: result.reason ?? null, chunkIds: result.chunk_ids ?? [] }
  }

  async getChunks(documentId) {
    const key = validId(documentId, 'supabase_knowledge_id_invalid')
    const result = await this.#rows('ragam_knowledge_chunks', [['document_id', `eq.${key}`]], 'supabase_knowledge_chunks_invalid', {
      maximum: MAX_SCAN_ROWS, order: 'idx.asc',
    })
    return result.map(hydrateChunk)
  }

  async getChunk(chunkId) {
    const key = validId(chunkId, 'supabase_knowledge_chunk_id_invalid')
    const row = await this.#one('ragam_knowledge_chunks', [['id', `eq.${key}`]], 'supabase_knowledge_chunks_invalid')
    return row ? hydrateChunk(row) : null
  }

  async allChunks() {
    const maximum = MAX_SCAN_ROWS
    const entries = [
      ['select', '*,ragam_knowledge_documents!inner(title,classification,source_label,mime,status,sha256)'],
      ['account_id', `eq.${this.#accountId}`],
      ['ragam_knowledge_documents.status', 'eq.active'],
      ['order', 'document_id.asc,idx.asc'],
      ['limit', String(maximum + 1)],
    ]
    const result = rows(await this.#client.request('rest/v1/ragam_knowledge_chunks', { method: 'GET', query: query(entries) }), 'supabase_knowledge_chunks_invalid', this.#accountId)
    if (result.length > maximum) throw new SupabaseKnowledgeStoreError('supabase_knowledge_chunk_limit')
    return result.map((row) => {
      const chunk = hydrateChunk(row)
      const document = row.ragam_knowledge_documents
      if (!document || document.status !== 'active') throw new SupabaseKnowledgeStoreError('supabase_knowledge_join_invalid')
      return {
        ...chunk,
        title: document.title,
        classification: document.classification,
        owner: this.#accountId,
        source_path: document.source_label,
        mime: document.mime,
        sha256: document.sha256,
      }
    })
  }

  async grant(documentId, principal, permission = 'read') {
    const id = validId(documentId, 'supabase_knowledge_id_invalid')
    if (typeof principal !== 'string' || !principal || principal.length > 255 || !PERMISSIONS.includes(permission)) {
      throw new SupabaseKnowledgeStoreError('supabase_knowledge_acl_invalid')
    }
    const result = await this.#client.request('rest/v1/ragam_knowledge_acl', {
      method: 'POST',
      query: query([['on_conflict', 'account_id,document_id,principal,permission']]),
      headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
      body: { account_id: this.#accountId, document_id: id, principal, permission, granted_at: this.#now() },
    })
    if (!Array.isArray(result) || result.length > 1) throw new SupabaseKnowledgeStoreError('supabase_knowledge_acl_invalid')
    return result.length === 1
  }

  async revoke(documentId, principal, permission = 'read') {
    const id = validId(documentId, 'supabase_knowledge_id_invalid')
    if (typeof principal !== 'string' || !principal || !PERMISSIONS.includes(permission)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_acl_invalid')
    const removed = await this.#client.request('rest/v1/ragam_knowledge_acl', {
      method: 'DELETE',
      query: query([['account_id', `eq.${this.#accountId}`], ['document_id', `eq.${id}`], ['principal', `eq.${principal}`], ['permission', `eq.${permission}`], ['select', 'document_id']]),
      headers: { prefer: 'return=representation' },
    })
    if (!Array.isArray(removed) || removed.length > 1) throw new SupabaseKnowledgeStoreError('supabase_knowledge_acl_invalid')
    return removed.length === 1
  }

  async aclFor(documentId) {
    const id = validId(documentId, 'supabase_knowledge_id_invalid')
    const result = await this.#rows('ragam_knowledge_acl', [['document_id', `eq.${id}`]], 'supabase_knowledge_acl_invalid', { maximum: MAX_PAGE_ROWS })
    return result.map((row) => {
      if (typeof row.principal !== 'string' || !PERMISSIONS.includes(row.permission) || !Number.isSafeInteger(row.granted_at)) {
        throw new SupabaseKnowledgeStoreError('supabase_knowledge_acl_invalid')
      }
      return { principal: row.principal, permission: row.permission, granted_at: row.granted_at }
    })
  }

  async canRead(documentId, principal) {
    const grants = await this.aclFor(documentId)
    return grants.length === 0 || grants.some((grant) => grant.permission !== 'write' && matchesPrincipal(grant.principal, principal))
  }

  accessFilter(principal) {
    const cache = new Map()
    return async (docId) => {
      const documentId = validId(docId, 'supabase_knowledge_id_invalid')
      if (!cache.has(documentId)) cache.set(documentId, await this.canRead(documentId, principal))
      return cache.get(documentId)
    }
  }

  async putEmbedding(chunkId, model, vector) {
    const id = validId(chunkId, 'supabase_knowledge_chunk_id_invalid')
    if (typeof model !== 'string' || !model || !Array.isArray(vector) || !vector.length || vector.length > 65_536
      || vector.some((value) => !Number.isFinite(value))) throw new SupabaseKnowledgeStoreError('supabase_knowledge_embedding_invalid')
    const bytes = Buffer.from(new Float32Array(vector).buffer)
    await this.#client.request('rest/v1/ragam_knowledge_embeddings', {
      method: 'POST',
      query: query([['on_conflict', 'account_id,chunk_id']]),
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { account_id: this.#accountId, chunk_id: id, model, dim: vector.length, vector: `\\x${bytes.toString('hex')}`, created_at: this.#now() },
    })
    return true
  }

  async getEmbeddings(model = null) {
    if (model !== null && (typeof model !== 'string' || !model)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_embedding_invalid')
    const parameters = model ? [['model', `eq.${model}`]] : []
    const result = await this.#rows('ragam_knowledge_embeddings', parameters, 'supabase_knowledge_embeddings_invalid', { maximum: MAX_SCAN_ROWS })
    return result.map((row) => {
      if (!UUID.test(row.chunk_id) || typeof row.model !== 'string' || !Number.isSafeInteger(row.dim) || row.dim < 1) {
        throw new SupabaseKnowledgeStoreError('supabase_knowledge_embedding_invalid')
      }
      return { chunkId: row.chunk_id, model: row.model, dim: row.dim, vector: vectorBytes(row.vector, row.dim) }
    })
  }

  async purgeDocument(documentId, { reason = null, requestedBy = this.#accountId } = {}) {
    const id = validId(documentId, 'supabase_knowledge_id_invalid')
    if (reason !== null && (typeof reason !== 'string' || reason.length > 1000)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_reason_invalid')
    if (requestedBy !== null && typeof requestedBy !== 'string') throw new SupabaseKnowledgeStoreError('supabase_knowledge_actor_invalid')
    const result = await this.#client.request('rest/v1/rpc/ragam_knowledge_purge_document', {
      method: 'POST', body: { p_account_id: this.#accountId, p_document_id: id, p_reason: reason, p_requested_by: requestedBy, p_now: this.#now() },
    })
    if (!result || typeof result.deleted !== 'boolean') throw new SupabaseKnowledgeStoreError('supabase_knowledge_purge_invalid')
    return result
  }

  async deletionLog(limit = 100) {
    const boundedLimit = bounded(limit, 100, MAX_PAGE_ROWS, 'supabase_knowledge_limit_invalid')
    const result = await this.#rows('ragam_knowledge_deletions', [], 'supabase_knowledge_deletions_invalid', { maximum: boundedLimit, order: 'at.desc', rejectOverflow: false })
    return result.map((row) => ({ ...row }))
  }

  async applyRetention({ olderThanMs, reason = 'retention policy', requestedBy = this.#accountId } = {}) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new SupabaseKnowledgeStoreError('supabase_knowledge_retention_invalid')
    const cutoff = this.#now() - olderThanMs
    const selected = await this.#rows('ragam_knowledge_documents', [['ingested_at', `lte.${cutoff}`]], 'supabase_knowledge_rows_invalid', { maximum: MAX_SCAN_ROWS })
    const results = []
    for (const row of selected) results.push(await this.purgeDocument(row.id, { reason, requestedBy }))
    return { purged: results.filter((item) => item.deleted).length, cutoff, results }
  }

  async recordIndexRun({ kind, documents, chunks, durationMs, outcome, detail = null } = {}) {
    if (typeof kind !== 'string' || !kind || !Number.isSafeInteger(documents) || documents < 0
      || !Number.isSafeInteger(chunks) || chunks < 0 || !Number.isSafeInteger(durationMs) || durationMs < 0
      || !['success', 'failure'].includes(outcome)) throw new SupabaseKnowledgeStoreError('supabase_knowledge_index_run_invalid')
    const payload = {
      id: randomUUID(), account_id: this.#accountId, at: this.#now(), kind, documents, chunks, duration_ms: durationMs,
      outcome, detail: detail === null ? null : object(detail, 'supabase_knowledge_index_run_invalid'),
    }
    const inserted = await this.#client.request('rest/v1/ragam_knowledge_index_runs', {
      method: 'POST', headers: { prefer: 'return=representation' }, body: payload,
    })
    if (!Array.isArray(inserted) || inserted.length !== 1 || inserted[0].account_id !== this.#accountId) {
      throw new SupabaseKnowledgeStoreError('supabase_knowledge_index_run_invalid')
    }
    return inserted[0].id
  }

  async indexRuns(limit = 50) {
    const boundedLimit = bounded(limit, 50, MAX_PAGE_ROWS, 'supabase_knowledge_limit_invalid')
    return this.#rows('ragam_knowledge_index_runs', [], 'supabase_knowledge_index_runs_invalid', { maximum: boundedLimit, order: 'at.desc', rejectOverflow: false })
  }

  async stats() {
    const result = await this.#client.request('rest/v1/rpc/ragam_knowledge_stats', {
      method: 'POST', body: { p_account_id: this.#accountId },
    })
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || !['documents', 'chunks', 'embeddings', 'aclRows', 'deletions', 'bytesIndexed'].every((key) => Number.isSafeInteger(result[key]) && result[key] >= 0)) {
      throw new SupabaseKnowledgeStoreError('supabase_knowledge_stats_invalid')
    }
    return result
  }

  close() {}
}

