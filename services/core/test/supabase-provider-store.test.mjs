import test from 'node:test'
import assert from 'node:assert/strict'
import { SupabaseProviderStore, SupabaseProviderStoreError } from '../src/storage/supabase-provider-store.mjs'

function clientFixture() {
  let revision = 0
  let payload = null
  const calls = []
  return {
    calls,
    client: {
      async request(endpoint, options = {}) {
        calls.push({ endpoint, options })
        if (endpoint === 'rest/v1/ragam_provider_state') return payload === null ? [] : [{ revision, payload }]
        if (endpoint === 'rest/v1/rpc/ragam_save_provider_snapshot') {
          const { p_payload, p_expected_revision } = options.body
          if (p_expected_revision !== revision) return { ok: false, code: 'provider_state_conflict' }
          revision += 1
          payload = structuredClone(p_payload)
          return { ok: true, revision }
        }
        throw new Error(`unexpected endpoint ${endpoint}`)
      },
    },
    current: () => ({ revision, payload: structuredClone(payload) }),
  }
}

const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')

test('provider state persists encrypted credentials through the revision-checked RPC', async () => {
  const fixture = clientFixture()
  const store = await SupabaseProviderStore.create({ client: fixture.client, encryptionKey: key })
  const secret = store.seal('provider-secret')
  store.saveConnection('litellm', { baseUrl: 'https://gateway.example', key: secret, models: ['model-a'], selectedModel: 'model-a' })
  assert.equal(store.public().keyConfigured, true)
  await store.flush()
  const first = fixture.current()
  assert.equal(first.revision, 1)
  assert.equal(first.payload.connections.litellm.key.data, secret.data)
  assert.notEqual(first.payload.connections.litellm.key.data, 'provider-secret')
  assert.equal(store.config().apiKey, 'provider-secret')

  store.activate('litellm')
  await store.flush()
  assert.equal(fixture.current().revision, 2)
})

test('stale warm instances cannot overwrite newer provider state', async () => {
  const fixture = clientFixture()
  const first = await SupabaseProviderStore.create({ client: fixture.client, encryptionKey: key })
  const stale = await SupabaseProviderStore.create({ client: fixture.client, encryptionKey: key })
  first.saveConnection('litellm', { baseUrl: 'https://one.example', key: null })
  await first.flush()
  stale.saveConnection('litellm', { baseUrl: 'https://two.example', key: null })
  await assert.rejects(stale.flush(), (error) => error.code === 'provider_state_conflict' && error.status === 409)
  assert.equal(fixture.current().payload.connections.litellm.baseUrl, 'https://one.example')
  await stale.refresh()
  assert.equal(stale.connections[0].baseUrl, 'https://one.example', 'the warm instance must rehydrate after a conflict')
  stale.saveConnection('litellm', { baseUrl: 'https://two.example', key: null })
  await stale.flush()
  assert.equal(fixture.current().revision, 2)
  assert.equal(fixture.current().payload.connections.litellm.baseUrl, 'https://two.example')
})

test('provider encryption key must be an exact 32-byte base64 or 64-character hex value', async () => {
  const fixture = clientFixture()
  await assert.rejects(SupabaseProviderStore.create({ client: fixture.client, encryptionKey: 'too-short' }), (error) => error.code === 'provider_encryption_key_invalid')
  await assert.rejects(SupabaseProviderStore.create({ client: fixture.client, encryptionKey: '' }), (error) => error.code === 'provider_encryption_key_missing')
  await assert.rejects(SupabaseProviderStore.create({ client: fixture.client, encryptionKey: 'z'.repeat(64) }), SupabaseProviderStoreError)
})
