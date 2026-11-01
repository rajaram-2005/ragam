import { OnlineStore } from '../online/store.mjs'

export class SupabaseProviderStoreError extends Error {
  constructor(code, status = 500) {
    super(code)
    this.name = 'SupabaseProviderStoreError'
    this.code = code
    this.status = status
  }
}

function decodeEncryptionKey(value) {
  if (typeof value !== 'string' || !value) throw new SupabaseProviderStoreError('provider_encryption_key_missing', 500)
  let key
  if (/^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, 'hex')
  else {
    try { key = Buffer.from(value, 'base64') } catch { key = Buffer.alloc(0) }
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      throw new SupabaseProviderStoreError('provider_encryption_key_invalid', 500)
    }
  }
  if (key.length !== 32) throw new SupabaseProviderStoreError('provider_encryption_key_invalid', 500)
  return key
}

function rpcResult(value) {
  const result = Array.isArray(value) ? value[0] : value
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SupabaseProviderStoreError('provider_state_rpc_invalid')
  return result
}

/**
 * Provider state adapter for OnlineApp's synchronous provider-store contract. Reads are
 * hydrated before the app is exposed; mutations are serialized through a revision-checked
 * SQL RPC and must be awaited with flush() before the HTTP response is completed.
 */
export class SupabaseProviderStore {
  #store
  #client
  #revisionState

  constructor({ store, client, revisionState }) {
    this.#store = store
    this.#client = client
    this.#revisionState = revisionState
  }

  static async create({ client, encryptionKey = process.env.AETHERIS_PROVIDER_ENCRYPTION_KEY } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseProviderStoreError('supabase_client_invalid')
    const rows = await client.request('rest/v1/ragam_provider_state', {
      method: 'GET',
      query: 'select=revision,payload&singleton=eq.true&limit=2',
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseProviderStoreError('provider_state_rows_invalid')
    const row = rows[0] ?? null
    const remoteRevision = row ? Number(row.revision) : 0
    if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 0) throw new SupabaseProviderStoreError('provider_state_revision_invalid')
    if (row && (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload))) {
      throw new SupabaseProviderStoreError('provider_state_payload_invalid')
    }
    const revisionState = { value: remoteRevision }
    const key = decodeEncryptionKey(encryptionKey)
    const store = new OnlineStore(null, {
      initialState: row?.payload ?? null,
      encryptionKey: key,
      onPersist: async (snapshot) => {
        const expectedRevision = revisionState.value
        const result = rpcResult(await client.request('rest/v1/rpc/ragam_save_provider_snapshot', {
          method: 'POST',
          body: { p_payload: snapshot, p_expected_revision: expectedRevision, p_now: Date.now() },
        }))
        if (result.ok !== true) {
          const code = typeof result.code === 'string' && /^[a-z0-9_]{1,64}$/.test(result.code) ? result.code : 'provider_state_write_failed'
          throw new SupabaseProviderStoreError(code, code === 'provider_state_conflict' ? 409 : 500)
        }
        const nextRevision = Number(result.revision)
        if (!Number.isSafeInteger(nextRevision) || nextRevision !== expectedRevision + 1) {
          throw new SupabaseProviderStoreError('provider_state_revision_invalid')
        }
        revisionState.value = nextRevision
      },
    })
    return new SupabaseProviderStore({ store, client, revisionState })
  }

  async refresh() {
    let previousWriteFailed = false
    try { await this.#store.flush() } catch { previousWriteFailed = true }
    const rows = await this.#client.request('rest/v1/ragam_provider_state', {
      method: 'GET', query: 'select=revision,payload&singleton=eq.true&limit=2',
    })
    if (!Array.isArray(rows) || rows.length > 1) throw new SupabaseProviderStoreError('provider_state_rows_invalid')
    const row = rows[0] ?? null
    const revision = row ? Number(row.revision) : 0
    if (!Number.isSafeInteger(revision) || revision < 0) throw new SupabaseProviderStoreError('provider_state_revision_invalid')
    if (row && (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload))) throw new SupabaseProviderStoreError('provider_state_payload_invalid')
    if (previousWriteFailed || revision !== this.#revisionState.value) this.#store.replaceState(row?.payload ?? null)
    this.#revisionState.value = revision
    if (previousWriteFailed) this.#store.recoverPersistence()
    return this.public()
  }

  get state() { return this.#store.state }
  get schema() { return this.#store.schema }
  get revision() { return this.#store.revision }
  get active() { return this.#store.active }
  get connections() { return this.#store.connections }
  get selectedNativeModel() { return this.#store.selectedNativeModel }
  kind(...args) { return this.#store.kind(...args) }
  config(...args) { return this.#store.config(...args) }
  seal(...args) { return this.#store.seal(...args) }
  klyvaronPreset(...args) { return this.#store.klyvaronPreset(...args) }
  selectNativeModel(...args) { return this.#store.selectNativeModel(...args) }
  saveKlyvaronPreset(...args) { return this.#store.saveKlyvaronPreset(...args) }
  removeKlyvaronPreset(...args) { return this.#store.removeKlyvaronPreset(...args) }
  saveConnection(...args) { return this.#store.saveConnection(...args) }
  save(...args) { return this.#store.save(...args) }
  activate(...args) { return this.#store.activate(...args) }
  removeConnection(...args) { return this.#store.removeConnection(...args) }
  public(...args) { return this.#store.public(...args) }
  flush() { return this.#store.flush() }
  close() { return this.#store.close() }
}
