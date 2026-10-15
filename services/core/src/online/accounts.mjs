// Traditional account sign-in: an email address and a password, stored on this host.
//
// Why this module exists at all: the online product originally signed its single
// operator in with a token read from `.aetheris-data/online/access-token`. That is a
// fine secret for a machine, and a poor one for a person — it cannot be chosen,
// remembered, rotated by the person using it, or recovered without host access. The
// product now has real sign-in pages, so it needs real accounts, and accounts need
// somewhere to live that survives a restart.
//
// Three properties are load-bearing and are each covered by a test:
//
//   1. NOTHING REVERSIBLE IS STORED. Passwords are hashed with scrypt (N=16384,
//      r=8, p=1) plus a per-password 16-byte salt, and compared in constant time.
//      There is no encrypted-password column, because a key that can decrypt a
//      password can also be used to recover it; a hash cannot.
//   2. THE RESPONSES DO NOT ENUMERATE. "Unknown email" and "wrong password" return
//      the same code, the same status and — because a missing account still pays for
//      one scrypt pass against a dummy hash — approximately the same wall time.
//   3. GUESSING IS BOUNDED. Eight consecutive failures lock that account for fifteen
//      minutes. The counter is per account, so one person's typo storm cannot lock
//      everybody out, and the route layer rate-limits the endpoint as a whole.
//
// Password policy is length-and-denylist, not character-class gymnastics: twelve
// characters minimum, a short common-password denylist, no reuse of the account's own
// email address, and no single repeated character. NIST SP 800-63B argues for exactly
// this shape — length carries the entropy, forced symbols mostly produce `Password1!`.
//
// Zero npm dependencies, like the rest of services/core: node:sqlite for storage and
// node:crypto for scrypt.

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

import { failure } from './gateway.mjs'

/** scrypt work factors. 16 MiB and ~50–100 ms per hash on a laptop CPU. */
export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64, saltBytes: 16 })

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256
export const EMAIL_MAX_LENGTH = 254
export const MAX_FAILED_LOGINS = 8
export const LOCKOUT_MS = 15 * 60_000
export const RESET_CODE_TTL_MS = 15 * 60_000
export const RESET_CODE_BYTES = 24
export const DEFAULT_MAX_ACCOUNTS = 64

export const ROLES = Object.freeze({ OWNER: 'owner', MEMBER: 'member' })

/**
 * A denylist, not a password-strength score. Strength meters teach people to satisfy
 * the meter; refusing the passwords that appear in every breach corpus refuses the
 * ones that actually get guessed. Deliberately short: this is a floor, not a policy
 * engine, and length is doing the real work.
 */
const COMMON_PASSWORDS = Object.freeze([
  'password', 'password1', 'password123', 'passw0rd', 'letmein', 'welcome', 'welcome1',
  'qwerty123', 'qwertyuiop', '123456789', '1234567890', 'iloveyou', 'admin', 'administrator',
  'changeme', 'changeme123', 'aetheris', 'aetheris123', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'batman', 'trustno1', 'whatever', 'pass123', 'test1234',
])

// Practical address shape. Not RFC 5322 — a full parser would accept quoted strings and
// comments that no sign-in form should accept — but it does require one local part, one
// `@`, and a dotted domain whose last label is at least two letters.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER
);
CREATE TABLE IF NOT EXISTS password_resets (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash    TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER
);
`

/** Normalise and validate an address. Throws the same error for every bad shape. */
export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length === 0) throw failure('invalid_email', 'Enter the email address for this account.', 400)
  if (email.length > EMAIL_MAX_LENGTH) throw failure('invalid_email', 'That email address is too long.', 400)
  if (!EMAIL_PATTERN.test(email)) throw failure('invalid_email', 'Enter a valid email address, like you@example.com.', 400)
  return email
}

/**
 * Reasons a password is unacceptable, as sentences a person can act on. Returns an
 * empty array when the password is fine, so the caller decides how to report it.
 */
export function passwordProblems(password, email = '') {
  if (typeof password !== 'string' || password.length === 0) return ['Enter a password.']
  const problems = []
  if (password.length < PASSWORD_MIN_LENGTH) problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  if (password.length > PASSWORD_MAX_LENGTH) problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) problems.push('That password is too common to use.')
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat one character.')
  if (email) {
    // Exact matches only. A containment rule reads well and misfires constantly: it
    // refuses `dandelion-crusher` for somebody whose address starts `dan@`, which
    // teaches people that the checker is arbitrary and their password is not.
    const local = email.split('@')[0]
    const candidate = password.toLowerCase()
    if (candidate === email.toLowerCase() || (local.length >= 4 && candidate === local)) {
      problems.push('Do not use your email address, or the name part of it, as your password.')
    }
  }
  return problems
}

/** Hash a password into the self-describing stored form. */
export function hashPassword(password, salt = randomBytes(SCRYPT.saltBytes)) {
  const derived = scryptSync(String(password).normalize('NFKC'), salt, SCRYPT.keyLength, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  })
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * Verify against a stored hash in constant time.
 *
 * Returns false rather than throwing for a malformed stored value: a corrupt row must
 * fail the sign-in, not crash the request handler and reveal that the row was corrupt.
 */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, N, r, p, salt, hash] = parts
  const expected = Buffer.from(hash, 'base64')
  if (expected.length === 0) return false
  let derived
  try {
    derived = scryptSync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
    })
  } catch {
    return false
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * Accounts and their password-reset codes for one installation.
 *
 * One database file (`accounts.sqlite`) and one plaintext code file
 * (`password-resets.json`), both mode 0600 inside the mode 0700 online data directory.
 * The reset code file is the only plaintext secret this module writes, and it exists
 * because the product has no mail transport: the code has to reach the person through
 * the host, or it cannot reach them at all. It is single-use, expires in fifteen
 * minutes, and is deleted the moment it is consumed. Anyone who can read the data
 * directory can already read the provider `master.key`, so this widens no boundary
 * that the installation did not already have — but it is stated here rather than left
 * to be discovered.
 */
export class AccountStore {
  /**
   * @param {object} options
   * @param {string} options.dir online data directory
   * @param {number} [options.maxAccounts] hard cap on registered accounts
   * @param {(info: {email: string, code: string, expiresAt: number, file: string}) => void} [options.onResetCode]
   *   host-side delivery hook; `server.mjs` uses it to print a code when the operator asks
   * @param {(info: object) => void} [options.audit] optional audit sink
   */
  constructor({ dir, maxAccounts = DEFAULT_MAX_ACCOUNTS, onResetCode = null, audit = null }) {
    this.dir = dir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'accounts.sqlite')
    this.resetFile = join(dir, 'password-resets.json')
    this.maxAccounts = Number.isInteger(maxAccounts) && maxAccounts > 0 ? maxAccounts : DEFAULT_MAX_ACCOUNTS
    this.onResetCode = onResetCode
    this.audit = audit
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    chmodSync(this.file, 0o600)
    if (existsSync(this.resetFile)) chmodSync(this.resetFile, 0o600)
    // A fixed dummy hash, created once. An unknown email still runs one scrypt pass
    // against it so that "no such account" and "wrong password" cost the same time.
    this.dummyHash = hashPassword(randomBytes(24).toString('base64url'))
  }

  close() { try { this.db.close() } catch { /* already closed */ } }

  #public(row) {
    if (!row) return null
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at ?? null,
      lockedUntil: row.locked_until ?? null,
    }
  }

  count() { return Number(this.db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c) }

  list() { return this.db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all().map((row) => this.#public(row)) }

  get(id) { return this.#public(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(id))) }

  findByEmail(email) { return this.#public(this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(normalizeEmail(email))) }

  /** The first registered account owns the installation's gateway connection. */
  owner() { return this.#public(this.db.prepare("SELECT * FROM accounts WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1").get()) }

  /**
   * Create an account. The first one becomes the owner; every later one is a member.
   *
   * The role is decided by the store and never by the caller: a registration request
   * that could ask for `owner` would let the second person to arrive take the
   * installation's provider settings away from the first.
   */
  register({ email, password }) {
    const address = normalizeEmail(email)
    const problems = passwordProblems(password, address)
    if (problems.length) throw failure('weak_password', problems.join(' '), 400)
    if (this.count() >= this.maxAccounts) {
      throw failure('account_limit', `This installation already has ${this.maxAccounts} accounts. Ask its owner to raise AETHERIS_MAX_ACCOUNTS.`, 429)
    }
    if (this.findByEmail(address)) throw failure('email_taken', 'An account on this installation already uses that email address.', 409)
    const now = Date.now()
    const account = {
      id: randomUUID(),
      email: address,
      passwordHash: hashPassword(password),
      role: this.count() === 0 ? ROLES.OWNER : ROLES.MEMBER,
      createdAt: now,
    }
    this.db.prepare(
      `INSERT INTO accounts (id, email, password_hash, role, created_at, updated_at, last_login_at, failed_logins, locked_until)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
    ).run(account.id, account.email, account.passwordHash, account.role, account.createdAt, account.createdAt)
    this.audit?.({ category: 'auth', action: 'register', outcome: 'success', subject: account.id, detail: { role: account.role } })
    return this.get(account.id)
  }

  /**
   * Verify a password and return the account, or fail with a reason that does not say
   * which half of the pair was wrong.
   */
  authenticate({ email, password }) {
    const address = normalizeEmail(email)
    if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
      // Still pay for a hash so a malformed password is not a fast "no".
      verifyPassword(String(password ?? ''), this.dummyHash)
      throw failure('invalid_credentials', 'That email address and password do not match an account on this installation.', 401)
    }
    const row = this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(address)
    if (!row) {
      verifyPassword(password, this.dummyHash)
      this.audit?.({ category: 'auth', action: 'login', outcome: 'failure', subject: address, detail: { reason: 'unknown_email' } })
      throw failure('invalid_credentials', 'That email address and password do not match an account on this installation.', 401)
    }
    const now = Date.now()
    if (row.locked_until && row.locked_until > now) {
      const minutes = Math.max(1, Math.ceil((row.locked_until - now) / 60_000))
      this.audit?.({ category: 'auth', action: 'login', outcome: 'failure', subject: row.id, detail: { reason: 'locked' } })
      throw failure('account_locked', `Too many failed sign-ins for this account. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 423)
    }
    if (!verifyPassword(password, row.password_hash)) {
      const failed = Number(row.failed_logins) + 1
      const lock = failed >= MAX_FAILED_LOGINS
      this.db.prepare('UPDATE accounts SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = ?')
        .run(lock ? 0 : failed, lock ? now + LOCKOUT_MS : null, now, row.id)
      this.audit?.({ category: 'auth', action: 'login', outcome: 'failure', subject: row.id, detail: { reason: 'wrong_password', failed, locked: lock } })
      throw failure(lock ? 'account_locked' : 'invalid_credentials',
        lock ? `Too many failed sign-ins for this account. Try again in ${Math.round(LOCKOUT_MS / 60_000)} minutes.`
          : 'That email address and password do not match an account on this installation.',
        lock ? 423 : 401)
    }
    this.db.prepare('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, row.id)
    this.audit?.({ category: 'auth', action: 'login', outcome: 'success', subject: row.id, detail: { role: row.role } })
    return this.get(row.id)
  }

  /** Change a password from inside a signed-in session; the current password is required. */
  changePassword({ accountId, currentPassword, newPassword }) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(accountId))
    if (!row) throw failure('account_not_found', 'That account no longer exists.', 404)
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
      throw failure('invalid_credentials', 'Your current password is not correct.', 401)
    }
    return this.#setPassword(row, newPassword)
  }

  /**
   * Ask for a reset code.
   *
   * Returns the same shape whether or not the address exists — `created: false` and no
   * code — so the route can answer identically in both cases. The code itself goes to
   * the host: written to `password-resets.json` and handed to `onResetCode`. It is
   * never returned over HTTP, because the whole point of a reset code is that the
   * person asking for one has not proved who they are.
   */
  requestReset(email, { now = Date.now() } = {}) {
    const address = normalizeEmail(email)
    const row = this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(address)
    const expiresAt = now + RESET_CODE_TTL_MS
    if (!row) {
      this.audit?.({ category: 'auth', action: 'password_reset_request', outcome: 'failure', subject: address, detail: { reason: 'unknown_email' } })
      return { created: false, code: null, expiresAt }
    }
    const code = randomBytes(RESET_CODE_BYTES).toString('base64url')
    // One pending code per account: requesting again replaces the previous one, so an
    // inbox full of stale codes cannot be replayed later.
    this.db.prepare(
      `INSERT INTO password_resets (account_id, code_hash, requested_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, requested_at = excluded.requested_at,
         expires_at = excluded.expires_at, consumed_at = NULL`,
    ).run(row.id, hashPassword(code), now, expiresAt)
    this.#writeResetCodes({ [row.id]: { email: row.email, code, expiresAt, requestedAt: now } })
    this.audit?.({ category: 'auth', action: 'password_reset_request', outcome: 'success', subject: row.id, detail: { expiresAt } })
    this.onResetCode?.({ email: row.email, code, expiresAt, file: this.resetFile })
    return { created: true, code, expiresAt }
  }

  /** Consume a reset code and set a new password. Returns the account. */
  confirmReset({ email, code, password }) {
    const address = normalizeEmail(email)
    const row = this.db.prepare('SELECT * FROM accounts WHERE email = ?').get(address)
    if (!row || typeof code !== 'string' || code.length === 0 || code.length > 256) {
      throw failure('invalid_reset_code', 'That reset code is not valid for this email address. Request a new one.', 400)
    }
    const pending = this.db.prepare('SELECT * FROM password_resets WHERE account_id = ?').get(row.id)
    const now = Date.now()
    if (!pending || pending.consumed_at || pending.expires_at <= now || !verifyPassword(code, pending.code_hash)) {
      this.audit?.({ category: 'auth', action: 'password_reset_confirm', outcome: 'failure', subject: row.id, detail: { reason: pending ? 'bad_code' : 'none_pending' } })
      throw failure('invalid_reset_code', 'That reset code is not valid for this email address. Request a new one.', 400)
    }
    if (verifyPassword(password, row.password_hash)) {
      throw failure('weak_password', 'Choose a password this account has not used before.', 400)
    }
    this.db.prepare('UPDATE password_resets SET consumed_at = ? WHERE account_id = ?').run(now, row.id)
    this.#writeResetCodes({})
    this.audit?.({ category: 'auth', action: 'password_reset_confirm', outcome: 'success', subject: row.id, detail: {} })
    return this.#setPassword(row, password)
  }

  #setPassword(row, password) {
    const problems = passwordProblems(password, row.email)
    if (problems.length) throw failure('weak_password', problems.join(' '), 400)
    const now = Date.now()
    this.db.prepare('UPDATE accounts SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), now, row.id)
    this.audit?.({ category: 'auth', action: 'password_change', outcome: 'success', subject: row.id, detail: {} })
    return this.get(row.id)
  }

  /** Rewrite the host-readable reset code file atomically, at 0600. */
  #writeResetCodes(entries) {
    const temp = `${this.resetFile}.${randomBytes(6).toString('hex')}.tmp`
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.resetFile)
    chmodSync(this.resetFile, 0o600)
    return entries
  }

  /** Pending codes as the host sees them, for a support command; never served by a route. */
  pendingResets() {
    if (!existsSync(this.resetFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.resetFile, 'utf8'))
      const now = Date.now()
      return Object.values(parsed).filter((entry) => entry.expiresAt > now)
    } catch {
      return []
    }
  }
}
