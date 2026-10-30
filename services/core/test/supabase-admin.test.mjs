import test from 'node:test'
import assert from 'node:assert/strict'

import { SupabaseAdminClient, SupabaseAdminError } from '../src/storage/supabase-admin.mjs'

const URL = 'https://project-ref.supabase.co'
const KEY = 'service-role-key-that-is-never-logged-or-exposed'

function response(status, body = '') {
  return new Response(status === 204 || status === 304 ? null : body, { status })
}

test('Supabase admin client requires a bare HTTPS origin and a server-only service key', () => {
  assert.throws(() => new SupabaseAdminClient({ url: '', serviceRoleKey: KEY }), { code: 'supabase_url_missing' })
  for (const url of [
    'not-a-url',
    'http://project-ref.supabase.co',
    `${URL}/path`,
    `${URL}/`,
    `${URL}?query=1`,
    'https://user:pass@project-ref.supabase.co',
  ]) assert.throws(() => new SupabaseAdminClient({ url, serviceRoleKey: KEY }), { code: 'supabase_url_invalid' })
  assert.throws(() => new SupabaseAdminClient({ url: URL, serviceRoleKey: '' }), { code: 'supabase_service_key_missing' })
})

test('requests are limited to the configured host and Supabase data API paths', async () => {
  const calls = []
  const client = new SupabaseAdminClient({
    url: URL,
    serviceRoleKey: KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return response(200, '[{"id":"row-1"}]')
    },
  })
  const rows = await client.request('rest/v1/ragam_accounts', {
    method: 'GET',
    query: 'select=id&limit=1',
    headers: { accept: 'application/json' },
  })
  assert.deepEqual(rows, [{ id: 'row-1' }])
  assert.equal(calls[0].url, `${URL}/rest/v1/ragam_accounts?select=id&limit=1`)
  assert.equal(calls[0].options.headers.get('apikey'), KEY)
  assert.equal(calls[0].options.headers.get('authorization'), `Bearer ${KEY}`)
  assert.equal(client.serviceRoleKey, undefined, 'the server credential must not be an enumerable client property')
  await assert.rejects(client.request('https://attacker.example/steal'), { code: 'supabase_endpoint_invalid' })
  await assert.rejects(client.request('rest/v1/../storage/v1/object'), { code: 'supabase_endpoint_invalid' })
  await assert.rejects(client.request('rest/v1/%2e%2e/storage/v1/object'), { code: 'supabase_endpoint_invalid' })
  await assert.rejects(client.request('auth/v1/admin/users'), { code: 'supabase_endpoint_invalid' })
  await assert.rejects(client.request('rest/v1/accounts', { method: 'OPTIONS' }), { code: 'supabase_method_invalid' })
  await assert.rejects(client.request('rest/v1/accounts', { headers: { cookie: 'session=unsafe' } }), { code: 'supabase_header_invalid' })
})

test('writes encode JSON and never expose upstream error bodies', async () => {
  const calls = []
  const client = new SupabaseAdminClient({
    url: URL,
    serviceRoleKey: KEY,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return response(201, '{"stored":true}')
    },
  })
  assert.deepEqual(await client.request('rest/v1/ragam_state', { method: 'POST', body: { account_id: 'a1' } }), { stored: true })
  assert.equal(calls[0].options.headers.get('content-type'), 'application/json')
  assert.equal(calls[0].options.body, '{"account_id":"a1"}')

  const failing = new SupabaseAdminClient({
    url: URL,
    serviceRoleKey: KEY,
    fetchImpl: async () => response(500, `database error leaked ${KEY}`),
  })
  await assert.rejects(failing.request('rest/v1/ragam_state'), (error) => {
    assert.ok(error instanceof SupabaseAdminError)
    assert.equal(error.code, 'supabase_http_500')
    assert.equal(error.status, 500)
    assert.equal(error.message.includes(KEY), false)
    return true
  })
})

test('no-content responses return null and timeouts have a fixed safe code', async () => {
  const noContent = new SupabaseAdminClient({
    url: URL,
    serviceRoleKey: KEY,
    fetchImpl: async () => response(204),
  })
  assert.equal(await noContent.request('rest/v1/ragam_state', { method: 'DELETE' }), null)

  const slow = new SupabaseAdminClient({
    url: URL,
    serviceRoleKey: KEY,
    timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  await assert.rejects(slow.request('rest/v1/ragam_state'), { code: 'supabase_request_timeout' })
})
