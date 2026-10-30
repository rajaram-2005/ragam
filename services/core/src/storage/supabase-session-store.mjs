import { createHash, randomBytes } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/

export class SupabaseSessionError extends Error {
  constructor(code, status = 500) {
    super(code)
    this.name = 'SupabaseSessionError'
    this.code = code
    this.status = status
  }
}

function sessionHash(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function rpcResult(value) {
  const result = Array.isArray(value) ? value[0] : value
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SupabaseSessionError('supabase_session_rpc_invalid')
  return result
}

function query(entries) {
  return new URLSearchParams(entries).toString()
}

/** Durable server-side sessions; only a hash of the browser's opaque token is stored. */
export class SupabaseSessionStore {
  #client
  #now

  constructor({ client, now = () => Date.now(), ttlMs = 8 * 60 * 60_000, perAccount = 4, installationLimit = 256 } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseSessionError('supabase_client_invalid')
    if (typeof now !== 'function') throw new SupabaseSessionError('supabase_clock_invalid')
    this.#client = client
    this.#now = now
    this.ttlMs = Math.max(60_000, Math.min(24 * 60 * 60_000, Number(ttlMs) || 8 * 60 * 60_000))
    this.perAccount = Math.max(1, Math.min(32, Number.isInteger(perAccount) ? perAccount : 4))
    this.installationLimit = Math.max(this.perAccount, Math.min(10_000, Number.isInteger(installationLimit) ? installationLimit : 256))
  }

  async create(account) {
    if (!account || typeof account.id !== 'string' || !UUID.test(account.id)) throw new SupabaseSessionError('supabase_account_id_invalid')
    const token = randomBytes(32).toString('base64url')
    const now = this.#now()
    const expiresAt = now + this.ttlMs
    const response = rpcResult(await this.#client.request('rest/v1/rpc/ragam_create_session', {
      method: 'POST',
      body: {
        p_account_id: account.id,
        p_token_hash: sessionHash(token),
        p_now: now,
        p_expires_at: expiresAt,
        p_per_account: this.perAccount,
        p_installation_limit: this.installationLimit,
      },
    }))
    if (response.ok !== true) {
      const code = typeof response.code === 'string' && /^[a-z0-9_]{1,64}$/.test(response.code) ? response.code : 'supabase_session_create_failed'
      throw new SupabaseSessionError(code, code === 'session_limit' ? 429 : 500)
    }
    return token
  }

  async get(token) {
    const digest = sessionHash(token)
    if (!digest) return null
    const now = this.#now()
    const rows = await this.#client.request('rest/v1/ragam_sessions', {
      method: 'GET',
      query: query([
        ['select', 'account_id,expires_at'],
        ['token_hash', `eq.${digest}`],
        ['revoked_at', 'is.null'],
        ['expires_at', `gt.${now}`],
        ['limit', '1'],
      ]),
    })
    if (!Array.isArray(rows) || rows.length === 0) return null
    if (rows.length !== 1 || typeof rows[0].account_id !== 'string') throw new SupabaseSessionError('supabase_session_result_invalid')
    const expires = Number(rows[0].expires_at)
    if (!Number.isSafeInteger(expires) || expires <= now) return null
    const accountId = rows[0].account_id
    const accounts = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET',
      query: query([['select', 'id,email,role'], ['id', `eq.${accountId}`], ['limit', '1']]),
    })
    const account = Array.isArray(accounts) ? accounts[0] : null
    if (!account || account.id !== accountId || typeof account.email !== 'string' || !['owner', 'member'].includes(account.role)) return null
    return { token, accountId, email: account.email, role: account.role, expires }
  }

  async revoke(token) {
    const digest = sessionHash(token)
    if (!digest) return false
    const result = await this.#client.request('rest/v1/rpc/ragam_revoke_session', {
      method: 'POST',
      body: { p_token_hash: digest, p_now: this.#now() },
    })
    return result === true
  }

  async revokeAccount(accountId, exceptToken = null) {
    if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new SupabaseSessionError('supabase_account_id_invalid')
    const exceptHash = exceptToken === null ? null : sessionHash(exceptToken)
    if (exceptToken !== null && !exceptHash) throw new SupabaseSessionError('supabase_session_token_invalid')
    const count = await this.#client.request('rest/v1/rpc/ragam_revoke_sessions', {
      method: 'POST',
      body: { p_account_id: accountId, p_except_hash: exceptHash, p_now: this.#now() },
    })
    if (!Number.isInteger(count) || count < 0) throw new SupabaseSessionError('supabase_session_revoke_result_invalid')
    return count
  }
}
