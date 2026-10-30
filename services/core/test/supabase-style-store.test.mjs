import test from 'node:test'
import assert from 'node:assert/strict'

import { SupabaseStyleStore, SupabaseStyleStoreError } from '../src/storage/supabase-style-store.mjs'

const ACCOUNT = 'a7f83961-b0cd-4af4-903b-8c2a551fa489'
const OTHER = 'b7f83961-b0cd-4af4-903b-8c2a551fa489'

function clientFor(result) {
  const calls = []
  return {
    calls,
    request: async (endpoint, options) => {
      calls.push({ endpoint, options })
      return typeof result === 'function' ? result(endpoint, options) : result
    },
  }
}

test('missing style rows mean no preference and the read is account-filtered', async () => {
  const client = clientFor([])
  const store = new SupabaseStyleStore({ client })
  assert.deepEqual(await store.get(ACCOUNT), { style: null, explicit: false })
  assert.equal(client.calls[0].endpoint, 'rest/v1/ragam_styles')
  const query = new URLSearchParams(client.calls[0].options.query)
  assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(query.get('limit'), '2')
})

test('a stored null style is distinct from no stored preference', async () => {
  const client = clientFor([{ account_id: ACCOUNT, style: { schema: 1, style: null, explicit: true }, updated_at: 1 }])
  assert.deepEqual(await new SupabaseStyleStore({ client }).get(ACCOUNT), { style: null, explicit: true })
})

test('set validates style ids and upserts only the authenticated account preference', async () => {
  const client = clientFor((endpoint, options) => [{ account_id: ACCOUNT, style: options.body.style }])
  const store = new SupabaseStyleStore({ client, now: () => 1_800_000_000_000 })
  assert.deepEqual(await store.set(ACCOUNT, 'focused'), { style: 'focused', explicit: true })
  const call = client.calls[0]
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.query, 'on_conflict=account_id')
  assert.equal(call.options.headers.prefer, 'resolution=merge-duplicates,return=representation')
  assert.deepEqual(call.options.body, {
    account_id: ACCOUNT,
    style: { schema: 1, style: 'focused', explicit: true },
    updated_at: 1_800_000_000_000,
  })
  await assert.rejects(store.set(ACCOUNT, 'invented'), { code: 'invalid_style' })
  assert.equal(client.calls.length, 1, 'invalid preferences must not reach Supabase')
})

test('the store rejects malformed rows, duplicate results and mismatched owners', async () => {
  for (const rows of [
    [{ account_id: OTHER, style: { style: 'focused' } }],
    [{ account_id: ACCOUNT, style: { style: 'invented' } }],
    [{ account_id: ACCOUNT, style: { style: 'focused' } }, { account_id: ACCOUNT, style: { style: null } }],
    { account_id: ACCOUNT, style: { style: 'focused' } },
  ]) {
    const store = new SupabaseStyleStore({ client: clientFor(rows) })
    await assert.rejects(store.get(ACCOUNT), SupabaseStyleStoreError)
  }
})

test('malformed account ids and client dependencies are refused before requests', async () => {
  assert.throws(() => new SupabaseStyleStore(), { code: 'supabase_client_invalid' })
  const client = clientFor([])
  const store = new SupabaseStyleStore({ client })
  await assert.rejects(store.get('../account'), { code: 'supabase_account_id_invalid' })
  assert.equal(client.calls.length, 0)
})
