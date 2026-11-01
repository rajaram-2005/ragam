const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Only tables whose primary key is `id` belong here. Tables with composite keys or
// singleton/global semantics use purpose-built repositories rather than a loose query API.
const ACCOUNT_TABLES = new Set([
  'ragam_memories',
  'ragam_memory_candidates',
  'ragam_chat_sessions',
  'ragam_chat_turns',
  'ragam_memory_deletions',
  'ragam_fabric_entries',
  'ragam_fabric_provenance',
  'ragam_fabric_tombstones',
  'ragam_knowledge_documents',
  'ragam_knowledge_chunks',
  'ragam_knowledge_index_runs',
  'ragam_knowledge_deletions',
  'ragam_media_jobs',
  'ragam_media_artifacts',
])

export class SupabaseRepositoryError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SupabaseRepositoryError'
    this.code = code
  }
}

function accountId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SupabaseRepositoryError('supabase_account_id_invalid')
  return value
}

function rowId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SupabaseRepositoryError('supabase_row_id_invalid')
  return value
}

function tableName(value) {
  if (!ACCOUNT_TABLES.has(value)) throw new SupabaseRepositoryError('supabase_table_invalid')
  return value
}

function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new SupabaseRepositoryError(code)
  }
  return value
}

function queryString(entries) {
  return new URLSearchParams(entries).toString()
}

/**
 * Minimal account-scoped PostgREST repository. It always adds an account_id filter and
 * refuses caller-supplied ownership changes. It is not a general query builder; compound
 * workflows that need atomicity must be implemented as reviewed Postgres RPC functions.
 */
export class SupabaseAccountRepository {
  #client

  constructor(client) {
    if (!client || typeof client.request !== 'function') throw new SupabaseRepositoryError('supabase_client_invalid')
    this.#client = client
  }

  async list(table, owner, { limit = 100 } = {}) {
    const target = tableName(table)
    const ownerId = accountId(owner)
    const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(500, limit)) : 100
    return this.#client.request(`rest/v1/${target}`, {
      method: 'GET',
      query: queryString([['select', '*'], ['account_id', `eq.${ownerId}`], ['limit', String(boundedLimit)]]),
    })
  }

  async get(table, owner, id) {
    const target = tableName(table)
    const ownerId = accountId(owner)
    const key = rowId(id)
    const rows = await this.#client.request(`rest/v1/${target}`, {
      method: 'GET',
      query: queryString([['select', '*'], ['account_id', `eq.${ownerId}`], ['id', `eq.${key}`], ['limit', '2']]),
    })
    if (!Array.isArray(rows)) throw new SupabaseRepositoryError('supabase_rows_invalid')
    if (rows.length > 1) throw new SupabaseRepositoryError('supabase_primary_key_duplicated')
    return rows[0] ?? null
  }

  async insert(table, owner, input) {
    const target = tableName(table)
    const ownerId = accountId(owner)
    const values = record(input, 'supabase_record_invalid')
    if (values.account_id !== undefined && values.account_id !== ownerId) {
      throw new SupabaseRepositoryError('supabase_owner_mismatch')
    }
    const rows = await this.#client.request(`rest/v1/${target}`, {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: { ...values, account_id: ownerId },
    })
    if (!Array.isArray(rows) || rows.length !== 1) throw new SupabaseRepositoryError('supabase_insert_result_invalid')
    return rows[0]
  }

  async update(table, owner, id, input) {
    const target = tableName(table)
    const ownerId = accountId(owner)
    const key = rowId(id)
    const patch = record(input, 'supabase_patch_invalid')
    if (Object.hasOwn(patch, 'account_id') || Object.hasOwn(patch, 'id')) {
      throw new SupabaseRepositoryError('supabase_identity_immutable')
    }
    const rows = await this.#client.request(`rest/v1/${target}`, {
      method: 'PATCH',
      query: queryString([['account_id', `eq.${ownerId}`], ['id', `eq.${key}`], ['select', '*']]),
      headers: { prefer: 'return=representation' },
      body: patch,
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseRepositoryError('supabase_update_result_invalid')
    return rows[0] ?? null
  }

  async delete(table, owner, id) {
    const target = tableName(table)
    const ownerId = accountId(owner)
    const key = rowId(id)
    const rows = await this.#client.request(`rest/v1/${target}`, {
      method: 'DELETE',
      query: queryString([['account_id', `eq.${ownerId}`], ['id', `eq.${key}`], ['select', 'id']]),
      headers: { prefer: 'return=representation' },
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseRepositoryError('supabase_delete_result_invalid')
    return rows.length === 1
  }
}
