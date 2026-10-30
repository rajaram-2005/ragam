import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  DEFAULT_MAX_ACCOUNTS, LOCKOUT_MS, MAX_FAILED_LOGINS, PASSWORD_MAX_LENGTH, RESET_CODE_TTL_MS,
  ROLES, hashPassword, normalizeEmail, passwordProblems, verifyPassword,
} from '../online/accounts.mjs'
import { failure } from '../online/failure.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class SupabaseAccountError extends Error {
  constructor(code, status = 500) {
    super(code)
    this.name = 'SupabaseAccountError'
    this.code = code
    this.status = status
  }
}

function rpcResult(value) {
  const result = Array.isArray(value) ? value[0] : value
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SupabaseAccountError('supabase_account_rpc_invalid')
  return result
}

function query(entries) {
  return new URLSearchParams(entries).toString()
}

function accountRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !UUID.test(row.id)
      || typeof row.email !== 'string' || !Object.values(ROLES).includes(row.role)) {
    throw new SupabaseAccountError('supabase_account_result_invalid')
  }
  const createdAt = Number(row.created_at ?? row.createdAt)
  const updatedAt = Number(row.updated_at ?? row.updatedAt)
  const lastLoginAt = row.last_login_at ?? row.lastLoginAt ?? null
  const lockedUntil = row.locked_until ?? row.lockedUntil ?? null
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt)
      || (lastLoginAt !== null && !Number.isSafeInteger(Number(lastLoginAt)))
      || (lockedUntil !== null && !Number.isSafeInteger(Number(lockedUntil)))) {
    throw new SupabaseAccountError('supabase_account_result_invalid')
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt,
    updatedAt,
    lastLoginAt: lastLoginAt === null ? null : Number(lastLoginAt),
    lockedUntil: lockedUntil === null ? null : Number(lockedUntil),
  }
}

function rpcFailure(code) {
  switch (code) {
    case 'account_limit': return failure('account_limit', 'This installation has reached its account limit.', 429)
    case 'email_taken': return failure('email_taken', 'An account on this installation already uses that email address.', 409)
    case 'invalid_credentials': return failure('invalid_credentials', 'That email address and password do not match an account on this installation.', 401)
    case 'account_locked': return failure('account_locked', 'Too many failed sign-ins for this account. Try again later.', 423)
    case 'account_not_found': return failure('account_not_found', 'That account no longer exists.', 404)
    case 'password_changed': return failure('invalid_credentials', 'Your credentials changed. Sign in again.', 401)
    case 'reset_invalid': return failure('invalid_reset_code', 'That reset code is not valid for this email address. Request a new one.', 400)
    case 'password_reused': return failure('weak_password', 'Choose a password this account has not used before.', 400)
    default: return new SupabaseAccountError(/^[a-z0-9_]{1,64}$/.test(String(code)) ? code : 'supabase_account_operation_failed')
  }
}

/** Async account store for hosted Core. Passwords remain scrypt hashes; transactional
 * registration, lockout updates, password changes, and reset consumption run in SQL RPCs. */
export class SupabaseAccountStore {
  #client
  #now
  #onResetCode
  #maxAccounts
  #dummyHash

  constructor({ client, now = () => Date.now(), maxAccounts = DEFAULT_MAX_ACCOUNTS, onResetCode = null } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseAccountError('supabase_client_invalid')
    if (typeof now !== 'function') throw new SupabaseAccountError('supabase_clock_invalid')
    if (onResetCode !== null && typeof onResetCode !== 'function') throw new SupabaseAccountError('supabase_reset_delivery_invalid')
    this.#client = client
    this.#now = now
    this.#onResetCode = onResetCode
    this.#maxAccounts = Number.isInteger(maxAccounts) && maxAccounts > 0 ? maxAccounts : DEFAULT_MAX_ACCOUNTS
    this.#dummyHash = hashPassword(randomBytes(24).toString('base64url'))
  }

  close() {}

  async throttleAuth(action, email, { perAddress = 12, perInstallation = 60, windowMs = 60_000 } = {}) {
    const address = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : 'unknown'
    if (typeof action !== 'string' || !/^[a-z0-9_]{1,48}$/.test(action)) throw new SupabaseAccountError('supabase_auth_action_invalid')
    // Check the installation bucket first: once it is exhausted, attacker-chosen email
    // addresses must not create an unbounded number of per-address rows.
    const identities = [[String(action), perInstallation], [`${action}:${address}`, perAddress]]
    for (const [identity, limit] of identities) {
      const identityHash = createHash('sha256').update(identity, 'utf8').digest('hex')
      const result = rpcResult(await this.#client.request('rest/v1/rpc/ragam_consume_auth_attempt', {
        method: 'POST', body: { p_identity_hash: identityHash, p_now: this.#now(), p_limit: limit, p_window_ms: windowMs },
      }))
      if (result.ok !== true) throw failure('rate_limited', 'Too many attempts. Wait a minute and try again.', 429)
    }
  }

  // A synchronous readiness report must not start an un-awaited PostgREST request.
  countForReadiness() { return null }

  async count() {
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id'], ['limit', String(this.#maxAccounts + 1)]]),
    })
    if (!Array.isArray(rows)) throw new SupabaseAccountError('supabase_account_rows_invalid')
    return rows.length
  }

  async list() {
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,role,created_at,updated_at,last_login_at,locked_until'], ['order', 'created_at.asc']]),
    })
    if (!Array.isArray(rows)) throw new SupabaseAccountError('supabase_account_rows_invalid')
    return rows.map(accountRecord)
  }

  async get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,role,created_at,updated_at,last_login_at,locked_until'], ['id', `eq.${id}`], ['limit', '2']]),
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseAccountError('supabase_account_rows_invalid')
    return rows[0] ? accountRecord(rows[0]) : null
  }

  async findByEmail(email) {
    const address = normalizeEmail(email)
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,role,created_at,updated_at,last_login_at,locked_until'], ['email', `eq.${address}`], ['limit', '2']]),
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseAccountError('supabase_account_rows_invalid')
    return rows[0] ? accountRecord(rows[0]) : null
  }

  async owner() {
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,role,created_at,updated_at,last_login_at,locked_until'], ['role', 'eq.owner'], ['order', 'created_at.asc'], ['limit', '1']]),
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseAccountError('supabase_account_rows_invalid')
    return rows[0] ? accountRecord(rows[0]) : null
  }

  async register({ email, password }) {
    const address = normalizeEmail(email)
    const problems = passwordProblems(password, address)
    if (problems.length) throw failure('weak_password', problems.join(' '), 400)
    const id = randomUUID()
    const now = this.#now()
    const result = rpcResult(await this.#client.request('rest/v1/rpc/ragam_register_account', {
      method: 'POST', body: {
        p_account_id: id, p_email: address, p_password_hash: hashPassword(password),
        p_now: now, p_max_accounts: this.#maxAccounts,
      },
    }))
    if (result.ok !== true) throw rpcFailure(result.code)
    return accountRecord(result.account)
  }

  async authenticate({ email, password }) {
    const address = normalizeEmail(email)
    if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
      verifyPassword(String(password ?? ''), this.#dummyHash)
      throw failure('invalid_credentials', 'That email address and password do not match an account on this installation.', 401)
    }
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,password_hash,role,created_at,updated_at,last_login_at,failed_logins,locked_until'], ['email', `eq.${address}`], ['limit', '2']]),
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseAccountError('supabase_account_rows_invalid')
    const row = rows[0]
    if (!row) {
      verifyPassword(password, this.#dummyHash)
      throw failure('invalid_credentials', 'That email address and password do not match an account on this installation.', 401)
    }
    const now = this.#now()
    if (row.locked_until && Number(row.locked_until) > now) {
      const minutes = Math.max(1, Math.ceil((Number(row.locked_until) - now) / 60_000))
      throw failure('account_locked', `Too many failed sign-ins for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 423)
    }
    const valid = verifyPassword(password, row.password_hash)
    const result = rpcResult(await this.#client.request('rest/v1/rpc/ragam_record_account_login', {
      method: 'POST', body: {
        p_account_id: row.id, p_expected_password_hash: row.password_hash,
        p_password_valid: valid, p_now: now, p_max_failed: MAX_FAILED_LOGINS, p_lockout_ms: LOCKOUT_MS,
      },
    }))
    if (result.ok !== true) {
      if (result.code === 'account_locked' && result.locked_until) {
        const minutes = Math.max(1, Math.ceil((Number(result.locked_until) - now) / 60_000))
        throw failure('account_locked', `Too many failed sign-ins for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 423)
      }
      throw rpcFailure(result.code)
    }
    return accountRecord(result.account)
  }

  async changePassword({ accountId, currentPassword, newPassword }) {
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,password_hash'], ['id', `eq.${accountId}`], ['limit', '1']]),
    })
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) throw failure('account_not_found', 'That account no longer exists.', 404)
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw failure('invalid_credentials', 'Your current password is not correct.', 401)
    const problems = passwordProblems(newPassword, row.email)
    if (problems.length) throw failure('weak_password', problems.join(' '), 400)
    if (verifyPassword(newPassword, row.password_hash)) throw failure('weak_password', 'Choose a password this account has not used before.', 400)
    const result = rpcResult(await this.#client.request('rest/v1/rpc/ragam_update_account_password', {
      method: 'POST', body: {
        p_account_id: row.id, p_expected_password_hash: row.password_hash,
        p_new_password_hash: hashPassword(newPassword), p_now: this.#now(),
      },
    }))
    if (result.ok !== true) throw rpcFailure(result.code)
    return accountRecord(result.account)
  }

  async requestReset(email, { now = this.#now() } = {}) {
    const address = normalizeEmail(email)
    if (!this.#onResetCode) throw failure('password_reset_unavailable', 'Password reset delivery is not configured for this hosted installation.', 503)
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email'], ['email', `eq.${address}`], ['limit', '1']]),
    })
    const account = Array.isArray(rows) ? rows[0] : null
    const expiresAt = now + RESET_CODE_TTL_MS
    if (!account) return { created: false, code: null, expiresAt }
    const code = randomBytes(24).toString('base64url')
    const codeHash = hashPassword(code)
    await this.#client.request('rest/v1/ragam_password_resets', {
      method: 'POST', query: query([['on_conflict', 'account_id']]),
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { account_id: account.id, code_hash: codeHash, requested_at: now, expires_at: expiresAt, consumed_at: null },
    })
    try { await this.#onResetCode({ email: account.email, code, expiresAt }) } catch {
      throw failure('password_reset_delivery_failed', 'The password reset could not be delivered. Request a new code or contact the installation owner.', 503)
    }
    return { created: true, code: null, expiresAt }
  }

  async confirmReset({ email, code, password }) {
    const address = normalizeEmail(email)
    const rows = await this.#client.request('rest/v1/ragam_accounts', {
      method: 'GET', query: query([['select', 'id,email,password_hash'], ['email', `eq.${address}`], ['limit', '1']]),
    })
    const account = Array.isArray(rows) ? rows[0] : null
    if (!account || typeof code !== 'string' || code.length === 0 || code.length > 256) {
      throw failure('invalid_reset_code', 'That reset code is not valid for this email address. Request a new one.', 400)
    }
    const resets = await this.#client.request('rest/v1/ragam_password_resets', {
      method: 'GET', query: query([['select', 'code_hash,expires_at,consumed_at'], ['account_id', `eq.${account.id}`], ['limit', '1']]),
    })
    const pending = Array.isArray(resets) ? resets[0] : null
    const now = this.#now()
    if (!pending || pending.consumed_at !== null || Number(pending.expires_at) <= now || !verifyPassword(code, pending.code_hash)) {
      throw failure('invalid_reset_code', 'That reset code is not valid for this email address. Request a new one.', 400)
    }
    const problems = passwordProblems(password, account.email)
    if (problems.length) throw failure('weak_password', problems.join(' '), 400)
    if (verifyPassword(password, account.password_hash)) throw failure('weak_password', 'Choose a password this account has not used before.', 400)
    const result = rpcResult(await this.#client.request('rest/v1/rpc/ragam_reset_account_password', {
      method: 'POST', body: {
        p_account_id: account.id, p_expected_password_hash: account.password_hash,
        p_expected_reset_hash: pending.code_hash, p_new_password_hash: hashPassword(password), p_now: now,
      },
    }))
    if (result.ok !== true) throw rpcFailure(result.code)
    return accountRecord(result.account)
  }
}
