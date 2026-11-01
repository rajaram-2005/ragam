import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SupabaseSessionError, SupabaseSessionStore } from '../src/storage/supabase-session-store.mjs'

const ACCOUNT_ID = '74007a44-19b0-4ba7-a9a6-a417338b0182'
const ACCOUNT = { id: ACCOUNT_ID, email: 'member@example.test', role: 'member' }
const digest = (token) => createHash('sha256').update(token).digest('hex')

function fakeClient(handler) {
  const calls = []
  return {
    calls,
    async request(endpoint, options) {
      calls.push({ endpoint, options })
      return handler(endpoint, options)
    },
  }
}

test('session tokens are random, only SHA-256 hashes cross the database boundary, and lookups load the account', async () => {
  let now = 1_800_000_000_000
  const records = new Map()
  const client = fakeClient(async (endpoint, options) => {
    if (endpoint.endsWith('/rpc/ragam_create_session')) {
      records.set(options.body.p_token_hash, { account_id: options.body.p_account_id, expires_at: options.body.p_expires_at })
      return { ok: true, expires_at: options.body.p_expires_at }
    }
    if (endpoint.endsWith('/ragam_sessions')) {
      const query = new URLSearchParams(options.query)
      const row = records.get(query.get('token_hash').slice(3))
      return row ? [{ ...row }] : []
    }
    if (endpoint.endsWith('/ragam_accounts')) return [ACCOUNT]
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  })
  const store = new SupabaseSessionStore({ client, now: () => now, ttlMs: 3_600_000 })
  const token = await store.create(ACCOUNT)
  assert.match(token, /^[A-Za-z0-9_-]{40,64}$/)
  const tokenHash = digest(token)
  assert.equal(records.has(tokenHash), true)
  assert.equal(JSON.stringify(client.calls).includes(token), false)
  assert.equal(client.calls[0].endpoint, 'rest/v1/rpc/ragam_create_session')
  assert.equal(client.calls[0].options.body.p_token_hash, tokenHash)
  assert.equal(client.calls[0].options.body.p_expires_at, now + 3_600_000)
  assert.deepEqual(await store.get(token), { token, accountId: ACCOUNT_ID, email: ACCOUNT.email, role: ACCOUNT.role, expires: now + 3_600_000 })
  assert.equal(await store.get('not-a-valid-token'), null)
  now += 3_600_001
  assert.equal(await store.get(token), null, 'expired cookies are rejected even if a backend row lingers')
})

test('session caps and account-wide revocation are delegated to atomic database RPCs', async () => {
  const client = fakeClient(async (endpoint, options) => {
    if (endpoint.endsWith('/rpc/ragam_create_session')) return { ok: false, code: 'session_limit' }
    if (endpoint.endsWith('/rpc/ragam_revoke_sessions')) return 2
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  })
  const store = new SupabaseSessionStore({ client })
  await assert.rejects(store.create(ACCOUNT), (error) => error instanceof SupabaseSessionError && error.code === 'session_limit' && error.status === 429)
  const except = 'y'.repeat(43)
  assert.equal(await store.revokeAccount(ACCOUNT_ID, except), 2)
  const body = client.calls[1].options.body
  assert.equal(body.p_account_id, ACCOUNT_ID)
  assert.equal(body.p_except_hash, digest(except))
  assert.notEqual(body.p_except_hash, except)
  assert.equal(typeof body.p_now, 'number')
})

test('single-session revoke returns the database result and malformed identities fail closed', async () => {
  const client = fakeClient(async (endpoint) => {
    if (endpoint.endsWith('/rpc/ragam_revoke_session')) return true
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  })
  const store = new SupabaseSessionStore({ client })
  assert.equal(await store.revoke('z'.repeat(43)), true)
  assert.equal(await store.revoke('bad'), false)
  await assert.rejects(store.create({ ...ACCOUNT, id: 'not-a-uuid' }), /supabase_account_id_invalid/)
  await assert.rejects(store.revokeAccount('not-a-uuid'), /supabase_account_id_invalid/)
})
