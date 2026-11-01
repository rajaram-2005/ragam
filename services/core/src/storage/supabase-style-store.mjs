import { STYLE_IDS, styleFor } from '../online/styles.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class SupabaseStyleStoreError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SupabaseStyleStoreError'
    this.code = code
  }
}

function validAccountId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new SupabaseStyleStoreError('supabase_account_id_invalid')
  return value
}

function resultRows(rows, code) {
  if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseStyleStoreError(code)
  return rows
}

/**
 * Async Supabase counterpart for per-account response-style preferences.
 *
 * A missing row means no explicit preference. A row whose style is null means that the
 * person explicitly chose the no-style option. Style IDs are validated here even though
 * the HTTP route validates them too; database input must not become an instruction merely
 * because it arrived through a different server call path.
 */
export class SupabaseStyleStore {
  #client
  #now

  constructor({ client, now = () => Date.now() } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseStyleStoreError('supabase_client_invalid')
    if (typeof now !== 'function') throw new SupabaseStyleStoreError('supabase_clock_invalid')
    this.#client = client
    this.#now = now
  }

  async get(accountId) {
    const owner = validAccountId(accountId)
    const rows = resultRows(await this.#client.request('rest/v1/ragam_styles', {
      method: 'GET',
      query: new URLSearchParams([
        ['select', 'account_id,style,updated_at'],
        ['account_id', `eq.${owner}`],
        ['limit', '2'],
      ]).toString(),
    }), 'supabase_style_rows_invalid')
    if (rows.length === 0) return { style: null, explicit: false }
    const row = rows[0]
    if (!row || row.account_id !== owner || !row.style || typeof row.style !== 'object'
      || Array.isArray(row.style) || !Object.hasOwn(row.style, 'style')) {
      throw new SupabaseStyleStoreError('supabase_style_row_invalid')
    }
    const style = row.style.style
    if (style !== null && !STYLE_IDS.includes(style)) throw new SupabaseStyleStoreError('supabase_style_value_invalid')
    return { style, explicit: true }
  }

  async set(accountId, style) {
    const owner = validAccountId(accountId)
    if (style !== null) styleFor(style)
    const rows = resultRows(await this.#client.request('rest/v1/ragam_styles', {
      method: 'POST',
      query: 'on_conflict=account_id',
      headers: { prefer: 'resolution=merge-duplicates,return=representation' },
      body: {
        account_id: owner,
        style: { schema: 1, style, explicit: true },
        updated_at: this.#now(),
      },
    }), 'supabase_style_write_invalid')
    if (rows.length !== 1 || rows[0]?.account_id !== owner || rows[0]?.style?.style !== style) {
      throw new SupabaseStyleStoreError('supabase_style_write_invalid')
    }
    return { style, explicit: true }
  }
}
