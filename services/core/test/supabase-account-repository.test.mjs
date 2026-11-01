import test from 'node:test'
import assert from 'node:assert/strict'

import { SupabaseAccountRepository, SupabaseRepositoryError } from '../src/storage/supabase-account-repository.mjs'

const ACCOUNT = 'a7f83961-b0cd-4af4-903b-8c2a551fa489'
const OTHER = 'b7f83961-b0cd-4af4-903b-8c2a551fa489'
const ROW = 'c7f83961-b0cd-4af4-903b-8c2a551fa489'

function fakeClient(result) {
  const calls = []
  return {
    calls,
    request: async (endpoint, options) => {
      calls.push({ endpoint, options })
      return typeof result === 'function' ? result(endpoint, options) : result
    },
  }
}

test('reads always constrain account ownership and bound result sizes', async () => {
  const client = fakeClient([{ id: ROW, account_id: ACCOUNT }])
  const repository = new SupabaseAccountRepository(client)
  assert.deepEqual(await repository.list('ragam_memories', ACCOUNT, { limit: 900 }), [{ id: ROW, account_id: ACCOUNT }])
  const listQuery = new URLSearchParams(client.calls[0].options.query)
  assert.equal(listQuery.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(listQuery.get('limit'), '500')
  assert.deepEqual(await repository.get('ragam_memories', ACCOUNT, ROW), { id: ROW, account_id: ACCOUNT })
  const getQuery = new URLSearchParams(client.calls[1].options.query)
  assert.equal(getQuery.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(getQuery.get('id'), `eq.${ROW}`)
})

test('inserts bind the authenticated account and reject ownership spoofing', async () => {
  const client = fakeClient([{ id: ROW, account_id: ACCOUNT }])
  const repository = new SupabaseAccountRepository(client)
  await repository.insert('ragam_memories', ACCOUNT, { id: ROW, text: 'approved' })
  assert.deepEqual(client.calls[0].options.body, { id: ROW, text: 'approved', account_id: ACCOUNT })
  await assert.rejects(repository.insert('ragam_memories', ACCOUNT, { account_id: OTHER }), { code: 'supabase_owner_mismatch' })
  assert.equal(client.calls.length, 1, 'rejected ownership must not make a request')
})

test('updates and deletes include both the account and row identifier', async () => {
  const client = fakeClient([{ id: ROW, account_id: ACCOUNT }])
  const repository = new SupabaseAccountRepository(client)
  assert.deepEqual(await repository.update('ragam_memories', ACCOUNT, ROW, { status: 'archived' }), { id: ROW, account_id: ACCOUNT })
  assert.equal(await repository.delete('ragam_memories', ACCOUNT, ROW), true)
  for (const call of client.calls) {
    const query = new URLSearchParams(call.options.query)
    assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
    assert.equal(query.get('id'), `eq.${ROW}`)
  }
  await assert.rejects(repository.update('ragam_memories', ACCOUNT, ROW, { account_id: OTHER }), { code: 'supabase_identity_immutable' })
  await assert.rejects(repository.update('ragam_memories', ACCOUNT, ROW, { id: OTHER }), { code: 'supabase_identity_immutable' })
})

test('the repository refuses unknown tables and malformed account or row ids', async () => {
  const repository = new SupabaseAccountRepository(fakeClient([]))
  await assert.rejects(repository.list('ragam_provider_connections', ACCOUNT), { code: 'supabase_table_invalid' })
  await assert.rejects(repository.get('ragam_memories', 'not-an-id', ROW), { code: 'supabase_account_id_invalid' })
  await assert.rejects(repository.delete('ragam_memories', ACCOUNT, '../other'), { code: 'supabase_row_id_invalid' })
  assert.throws(() => new SupabaseAccountRepository({}), { code: 'supabase_client_invalid' })
})
