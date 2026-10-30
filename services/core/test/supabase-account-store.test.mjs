import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword } from '../src/online/accounts.mjs'
import { SupabaseAccountError, SupabaseAccountStore } from '../src/storage/supabase-account-store.mjs'

const ACCOUNT_ID = '74007a44-19b0-4ba7-a9a6-a417338b0182'
const PASSWORD = 'long-and-unique-password-42'
const ACCOUNT_ROW = {
  id: ACCOUNT_ID, email: 'owner@example.test', role: 'owner',
  password_hash: hashPassword(PASSWORD), created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
  last_login_at: null, failed_logins: 0, locked_until: null,
}
const publicAccount = (row = ACCOUNT_ROW) => ({
  id: row.id, email: row.email, role: row.role,
  created_at: row.created_at, updated_at: row.updated_at,
  last_login_at: row.last_login_at, locked_until: row.locked_until,
})
function fakeClient(handler) {
  const calls = []
  return {
    calls,
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options })
      return handler(endpoint, options)
    },
  }
}

test('registration normalizes email, scrypt-hashes passwords, and delegates owner/cap decisions atomically', async () => {
  let now = 1_800_000_000_000
  const client = fakeClient(async (endpoint, { body }) => {
    assert.equal(endpoint, 'rest/v1/rpc/ragam_register_account')
    return { ok: true, account: { ...publicAccount(), id: body.p_account_id, email: body.p_email, role: 'owner', created_at: now, updated_at: now } }
  })
  const store = new SupabaseAccountStore({ client, now: () => now, maxAccounts: 17 })
  const account = await store.register({ email: ' Owner@Example.Test ', password: PASSWORD })
  assert.match(account.id, /^[0-9a-f-]{36}$/i)
  assert.deepEqual({ ...account, id: ACCOUNT_ID }, { id: ACCOUNT_ID, email: 'owner@example.test', role: 'owner', createdAt: now, updatedAt: now, lastLoginAt: null, lockedUntil: null })
  const payload = client.calls[0].options.body
  assert.equal(payload.p_email, 'owner@example.test')
  assert.equal(payload.p_max_accounts, 17)
  assert.notEqual(payload.p_password_hash, PASSWORD)
  assert.match(payload.p_password_hash, /^scrypt\$/)
  assert.match(payload.p_account_id, /^[0-9a-f-]{36}$/i)
  now += 1
})

test('login verifies scrypt hashes locally and asks an atomic RPC to persist success or lockout', async () => {
  const attempts = []
  const client = fakeClient(async (endpoint, { body }) => {
    if (endpoint.endsWith('/ragam_accounts')) return [ACCOUNT_ROW]
    if (endpoint.endsWith('/rpc/ragam_record_account_login')) {
      attempts.push(body)
      return body.p_password_valid
        ? { ok: true, account: publicAccount({ ...ACCOUNT_ROW, last_login_at: body.p_now, updated_at: body.p_now }) }
        : { ok: false, code: 'account_locked', locked_until: body.p_now + 900_000 }
    }
    throw new Error(`Unexpected endpoint ${endpoint}`)
  })
  const store = new SupabaseAccountStore({ client, now: () => 1_800_000_000_000 })
  const signedIn = await store.authenticate({ email: 'OWNER@example.test', password: PASSWORD })
  assert.equal(signedIn.id, ACCOUNT_ID)
  assert.equal(attempts[0].p_password_valid, true)
  assert.equal(attempts[0].p_expected_password_hash, ACCOUNT_ROW.password_hash)
  await assert.rejects(store.authenticate({ email: ACCOUNT_ROW.email, password: 'incorrect-password-123' }), (error) => error.code === 'account_locked' && error.status === 423)
  assert.equal(attempts[1].p_password_valid, false)
})

test('password changes verify the current secret and update through an optimistic atomic RPC', async () => {
  let update
  const client = fakeClient(async (endpoint, options) => {
    if (endpoint.endsWith('/ragam_accounts')) return [ACCOUNT_ROW]
    if (endpoint.endsWith('/rpc/ragam_update_account_password')) {
      update = options.body
      return { ok: true, account: publicAccount({ ...ACCOUNT_ROW, updated_at: options.body.p_now }) }
    }
    throw new Error(`Unexpected endpoint ${endpoint}`)
  })
  const store = new SupabaseAccountStore({ client, now: () => 1_800_000_000_000 })
  const updated = await store.changePassword({ accountId: ACCOUNT_ID, currentPassword: PASSWORD, newPassword: 'new-secure-password-with-more-words' })
  assert.equal(updated.id, ACCOUNT_ID)
  assert.equal(update.p_expected_password_hash, ACCOUNT_ROW.password_hash)
  assert.match(update.p_new_password_hash, /^scrypt\$/)
  assert.equal(JSON.stringify(update).includes(PASSWORD), false)
  await assert.rejects(store.changePassword({ accountId: ACCOUNT_ID, currentPassword: 'wrong-current-password', newPassword: 'another-secure-password-long' }), (error) => error.code === 'invalid_credentials' && error.status === 401)
})

test('auth rate limits use two hashed identities and reject atomically when either shared bucket is exhausted', async () => {
  const client = fakeClient(async (endpoint, { body }) => {
    assert.equal(endpoint, 'rest/v1/rpc/ragam_consume_auth_attempt')
    return body.p_limit === 60 ? { ok: true } : { ok: false, code: 'rate_limited', retry_at: body.p_now + body.p_window_ms }
  })
  const store = new SupabaseAccountStore({ client, now: () => 1_800_000_000_000 })
  await assert.rejects(store.throttleAuth('login', 'Owner@Example.Test'), (error) => error.code === 'rate_limited' && error.status === 429)
  assert.equal(client.calls.length, 2)
  assert.equal(client.calls[0].options.body.p_limit, 60)
  assert.equal(client.calls[1].options.body.p_limit, 12)
  for (const { options } of client.calls) {
    assert.match(options.body.p_identity_hash, /^[0-9a-f]{64}$/)
    assert.equal(JSON.stringify(options.body).includes('owner@example.test'), false)
    assert.equal(options.body.p_window_ms, 60_000)
  }
  assert.notEqual(client.calls[0].options.body.p_identity_hash, client.calls[1].options.body.p_identity_hash)
})

test('password reset is disabled without an explicitly configured delivery function', async () => {
  const client = fakeClient(async () => { throw new Error('must not access database without delivery configured') })
  const store = new SupabaseAccountStore({ client })
  await assert.rejects(store.requestReset('owner@example.test'), (error) => error.code === 'password_reset_unavailable' && error.status === 503)
  assert.equal(client.calls.length, 0)
})

test('reset codes are hashed at rest, delivered only through the configured callback, and consumed atomically', async () => {
  const sent = []
  let savedReset = null
  const calls = []
  const client = fakeClient(async (endpoint, options) => {
    if (endpoint.endsWith('/ragam_accounts')) return [{ id: ACCOUNT_ID, email: ACCOUNT_ROW.email, password_hash: ACCOUNT_ROW.password_hash }]
    if (endpoint.endsWith('/ragam_password_resets') && options.method === 'POST') { calls.push(options); savedReset = options.body; return null }
    if (endpoint.endsWith('/ragam_password_resets')) return savedReset ? [{ ...savedReset }] : []
    if (endpoint.endsWith('/rpc/ragam_reset_account_password')) return { ok: true, account: publicAccount({ ...ACCOUNT_ROW, updated_at: 1_800_000_000_000 }) }
    throw new Error(`Unexpected endpoint ${endpoint}`)
  })
  const store = new SupabaseAccountStore({ client, now: () => 1_800_000_000_000, onResetCode: async (info) => sent.push(info) })
  const requested = await store.requestReset(ACCOUNT_ROW.email)
  assert.equal(requested.created, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].email, ACCOUNT_ROW.email)
  assert.equal(typeof sent[0].code, 'string')
  const insert = calls[0]
  assert.notEqual(insert.body.code_hash, sent[0].code)
  assert.match(insert.body.code_hash, /^scrypt\$/)
  assert.ok(!JSON.stringify(calls).includes(sent[0].code))
  await store.confirmReset({ email: ACCOUNT_ROW.email, code: sent[0].code, password: 'another-long-and-unique-password' })
  const resetCall = client.calls.find(({ endpoint }) => endpoint.endsWith('/rpc/ragam_reset_account_password'))
  assert.equal(resetCall.options.body.p_expected_reset_hash, savedReset.code_hash)
  assert.notEqual(resetCall.options.body.p_new_password_hash, 'another-long-and-unique-password')
  assert.equal(JSON.stringify(resetCall.options.body).includes('random-reset-code'), false)
})

test('invalid RPC payloads fail closed and account lookups never accept duplicate rows', async () => {
  const client = fakeClient(async (endpoint) => endpoint.endsWith('/ragam_accounts') ? [ACCOUNT_ROW, ACCOUNT_ROW] : null)
  const store = new SupabaseAccountStore({ client })
  await assert.rejects(store.findByEmail(ACCOUNT_ROW.email), (error) => error instanceof SupabaseAccountError && error.code === 'supabase_account_rows_invalid')
})
