import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { failure, runtimeFor } from './gateway.mjs'

// Server-owned store of provider connections. Several connections, one active at a time.
//
// Why several: a person may have a local Ollama for private work and a cloud key for a model they
// need occasionally. One slot forced them to overwrite one with the other, and overwriting a
// connection discards its key — so adding a second provider meant destroying the first. Each
// connection is a separate record with its own sealed credential; activating one does not touch
// the others.
//
// What did NOT change: the file holds credentials encrypted with AES-256-GCM, `public()` never
// returns one, and there is still exactly one *active* destination for a request. Multiple stored
// connections are not multiple concurrent recipients — a request goes to the active one, and the
// UI says which.
//
// Schema 2 is `{ schema, revision, active, connections: { [id]: record } }`. A schema-1 file was a
// single record `{ kind, baseUrl, key, models, selectedModel, verified, revision }`; it migrates to
// one connection whose id is its kind, and the migration is tested rather than assumed, because
// losing a stored key to a schema change is exactly the kind of failure that only shows up when
// somebody tries to chat.

export const STORE_SCHEMA = 2

/** Ids a connection may carry: a catalogue provider, or a named custom OpenAI-compatible endpoint. */
export const CONNECTION_ID = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)$/

/**
 * Migrate whatever was on disk into schema 2.
 *
 * Exported so the test can feed it a schema-1 record without writing a file first — and so the
 * migration has one implementation rather than one per caller.
 */
export function migrateState(raw) {
  if (raw === null || raw === undefined) {
    return { schema: STORE_SCHEMA, revision: 0, active: null, connections: {} }
  }
  // A schema this build does not know is refused rather than read as schema 1. Reading it as
  // schema 1 would treat a future file as a single connection with no fields and silently drop
  // every key in it — the one failure a credential store must never have.
  if (Number.isInteger(raw.schema) && raw.schema > STORE_SCHEMA) {
    throw failure('store_schema_unsupported', `The provider store uses schema ${raw.schema}; this build understands ${STORE_SCHEMA}.`, 500)
  }
  if (raw.schema === STORE_SCHEMA && raw.connections && typeof raw.connections === 'object') {
    // Only ids the store itself could have written are loaded. That also keeps a key named
    // `__proto__` in the file from reaching an assignment, where it would set a prototype.
    const connections = {}
    for (const [id, record] of Object.entries(raw.connections)) {
      if (CONNECTION_ID.test(id)) connections[id] = normaliseRecord(id, record)
    }
    const active = typeof raw.active === 'string' && Object.hasOwn(connections, raw.active)
      ? raw.active : (Object.keys(connections)[0] ?? null)
    return { schema: STORE_SCHEMA, revision: Number.isInteger(raw.revision) ? raw.revision : 0, active, connections }
  }
  // Schema 1: one connection, whose id was its `kind`.
  const kind = typeof raw.kind === 'string' && CONNECTION_ID.test(raw.kind) ? raw.kind : 'litellm'
  return {
    schema: STORE_SCHEMA,
    revision: Number.isInteger(raw.revision) ? raw.revision : 0,
    active: kind,
    connections: { [kind]: normaliseRecord(kind, raw) },
  }
}

function normaliseRecord(id, record = {}) {
  return {
    id,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    key: record.key ?? null,
    models: Array.isArray(record.models) ? record.models.filter((model) => typeof model === 'string') : [],
    selectedModel: typeof record.selectedModel === 'string' ? record.selectedModel : '',
    verified: record.verified && typeof record.verified === 'object' ? { ...record.verified } : {},
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
  }
}

export class OnlineStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700)
    this.file = join(dir, 'provider.json')
    const master = join(dir, 'master.key')
    if (!existsSync(master)) writeFileSync(master, randomBytes(32), { mode: 0o600, flag: 'wx' })
    this.key = readFileSync(master)
    if (this.key.length !== 32) throw Error('Invalid provider encryption key')
    const raw = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : null
    this.data = migrateState(raw)
    // A migrated file is written back immediately, so a later read never has to infer the schema
    // from a record that happens to look like both.
    if (raw !== null && raw.schema !== STORE_SCHEMA) this.#persist()
    if (existsSync(this.file)) chmodSync(this.file, 0o600)
  }

  /**
   * The active connection's record, with the store revision alongside it.
   *
   * This is a getter rather than a field so that the rest of the service — written when there was
   * one connection and which reads `store.state.models` — keeps its meaning. A missing connection
   * yields the empty record rather than `undefined`, because every caller treats it as a record.
   */
  get state() {
    const record = this.data.active ? this.data.connections[this.data.active] : null
    return { ...(record ?? emptyRecord()), revision: this.data.revision }
  }

  /** The stored record for an id, or null. `hasOwn`: `connections['__proto__']` is not a record. */
  #record(id) {
    return typeof id === 'string' && Object.hasOwn(this.data.connections, id) ? this.data.connections[id] : null
  }

  get schema() { return this.data.schema }
  get revision() { return this.data.revision }
  get active() { return this.data.active }
  get connections() { return Object.values(this.data.connections) }

  /** The id of the active connection, or null when none is configured. */
  kind() { return this.data.active }

  #persist() {
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' }); renameSync(temp, this.file)
  }

  seal(secret) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
  }

  #open(sealed) {
    const { iv, data, tag } = sealed
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64')); cipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8')
  }

  /**
   * What a request needs for one connection: id, runtime label, endpoint and, where one is stored,
   * the decrypted key. Never returns a sealed value and never returns another connection's key.
   */
  config(id = this.data.active) {
    if (!id) throw failure('provider_not_configured', 'Add your gateway connection in Provider Settings.', 503)
    const runtime = runtimeFor(id)
    const record = this.#record(id)
    if (!record) throw failure('provider_not_configured', `No saved connection for ${runtime.label}. Add it in Provider Settings.`, 503)
    if (!record.baseUrl || (runtime.keyRequired && !record.key)) {
      throw failure('provider_not_configured', `Add your ${runtime.label} connection in Provider Settings.`, 503)
    }
    return { id, kind: id, label: runtime.label, wire: runtime.wire, baseUrl: record.baseUrl, apiKey: record.key ? this.#open(record.key) : null }
  }

  /** Save (create or update) one connection and make it active. */
  saveConnection(id, patch) {
    if (!CONNECTION_ID.test(id)) throw failure('invalid_runtime', 'Connection ids are lower-case words separated by single hyphens.', 400)
    // Refuses an id the catalogue knows to be unimplemented, before anything is stored.
    runtimeFor(id)
    const existing = this.data.connections[id] ?? emptyRecord(id)
    this.data.connections[id] = { ...existing, ...patch, id }
    this.data.active = id
    this.data.revision += 1
    this.#persist()
    return this.public()
  }

  /** Update the active connection in place. Kept for the call sites written when there was one. */
  save(patch) {
    if (!this.data.active) throw failure('provider_not_configured', 'No active connection.', 503)
    return this.saveConnection(this.data.active, patch)
  }

  activate(id) {
    if (!this.#record(id)) throw failure('provider_not_found', 'No such saved connection.', 404)
    runtimeFor(id)
    this.data.active = id
    this.data.revision += 1
    this.#persist()
    return this.public()
  }

  /** Remove a connection and its credential. Any other connection is untouched. */
  removeConnection(id) {
    if (!this.#record(id)) throw failure('provider_not_found', 'No such saved connection.', 404)
    delete this.data.connections[id]
    if (this.data.active === id) this.data.active = Object.keys(this.data.connections)[0] ?? null
    this.data.revision += 1
    this.#persist()
    return this.public()
  }

  /** The public shape. Every field is derived from the active record plus the list of ids. */
  public() {
    // A stored record whose adapter this build no longer admits must not make the whole listing
    // throw: the settings page would break and the user could not delete the offending connection.
    // It is listed with `unsupported` and `configured: false`, and a request through it is refused
    // by `config()` with the catalogue's own code.
    const describe = (id) => {
      try { return { runtime: runtimeFor(id), unsupported: null } }
      catch (error) { return { runtime: null, unsupported: error.code ?? 'invalid_runtime' } }
    }
    const records = this.connections.map((record) => {
      const { runtime, unsupported } = describe(record.id)
      return {
        id: record.id,
        label: runtime?.label ?? record.id,
        wire: runtime?.wire ?? null,
        credential: runtime?.credential ?? null,
        baseUrl: record.baseUrl,
        keyRequired: runtime?.keyRequired ?? true,
        keyConfigured: Boolean(record.key),
        configured: Boolean(runtime) && Boolean(record.baseUrl) && (Boolean(record.key) || !runtime.keyRequired),
        models: record.models,
        selectedModel: record.selectedModel,
        checkedAt: record.checkedAt,
        verified: record.verified,
        ...(unsupported ? { unsupported } : {}),
      }
    })
    const active = this.data.active
    const record = this.#record(active)
    const runtime = active ? describe(active).runtime : null
    const view = record ? records.find((entry) => entry.id === active) : null
    return {
      // `kind` and the record fields are the pre-schema-2 shape, kept so the existing UI and
      // clients keep working. `connections` is the new list; `active` says which one they see.
      kind: active,
      active,
      name: runtime?.label ?? null,
      wire: runtime?.wire ?? null,
      credential: runtime?.credential ?? null,
      baseUrl: record?.baseUrl ?? '',
      keyRequired: runtime?.keyRequired ?? true,
      keyConfigured: Boolean(record?.key),
      configured: Boolean(view?.configured),
      models: record?.models ?? [],
      selectedModel: record?.selectedModel ?? '',
      checkedAt: record?.checkedAt ?? null,
      verified: record?.verified ?? {},
      revision: this.data.revision,
      connections: records,
    }
  }
}

function emptyRecord(id = null) {
  return { id, baseUrl: '', key: null, models: [], selectedModel: '', verified: {}, checkedAt: null }
}
