// Discovery only. This module has no dependency on the inference router.
import { createHash } from 'node:crypto'

export const CATALOG_SCHEMA = 'aetheris.model-catalog/1'
export const MAX_RECORDS = 500
export const catalogError = (code, message, status = 400) => Object.assign(new Error(message), { code, status })
const text = (value, max = 512) => {
  if (value == null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw catalogError('invalid_catalog', 'invalid catalog string')
  return value
}
const positive = (value) => {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw catalogError('invalid_catalog', 'invalid catalog size or limit')
  return value
}
const list = (value) => {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 32) throw catalogError('invalid_catalog', 'invalid catalog list')
  return [...new Set(value.map((item) => { if (typeof item !== 'string') throw catalogError('invalid_catalog', 'catalog list entries must be strings'); return text(item) }))]
}
function link(value) {
  if (value == null) return null
  const url = new URL(text(value, 2048))
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw catalogError('invalid_catalog', 'model cards must be credential-free HTTPS links')
  return url.href
}
export function normalizeRecord(input, sourceId) {
  const id = text(input?.id)
  if (!id) throw catalogError('invalid_catalog', 'a canonical model id is required')
  const revision = text(input.revision)
  return {
    schema: CATALOG_SCHEMA,
    key: createHash('sha256').update(JSON.stringify([sourceId, id, revision])).digest('hex'),
    sourceId, id, revision, publisher: text(input.publisher), family: text(input.family),
    modelCard: link(input.modelCard), baseModels: list(input.baseModels),
    licence: { id: text(input.licence), review: 'not_reviewed', restrictions: null },
    tasks: list(input.tasks), modalities: list(input.modalities), runtimes: list(input.runtimes),
    contextTokens: positive(input.contextTokens), outputTokens: positive(input.outputTokens),
    toolCalling: typeof input.toolCalling === 'boolean' ? input.toolCalling : null,
    structuredOutput: typeof input.structuredOutput === 'boolean' ? input.structuredOutput : null,
    artifactBytes: positive(input.artifactBytes), quantization: text(input.quantization),
    hardwareRequirements: null, pricing: null, quotas: null, privacy: null, benchmarks: [],
    // A listing is neither a licence approval nor a successful inference probe.
    installation: 'unknown', inferenceReadiness: 'unverified', lastVerifiedAt: null,
    verification: 'catalog_only', executionLocation: ['local', 'online'].includes(input.executionLocation) ? input.executionLocation : null,
  }
}

export class ModelCatalog {
  #sources = new Map()
  #closed = false
  #active = new Set()
  constructor({ now = Date.now, onEvent = () => {} } = {}) { this.now = now; this.onEvent = (event) => { try { onEvent(event) } catch { /* telemetry cannot alter snapshot publication */ } } }
  addSource({ id, kind, load, ttlMs = 86_400_000, network = 'none', endpointOrigin = null }) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || typeof load !== 'function' || !text(kind)
      || !['none', 'loopback', 'external'].includes(network) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 86_400_000) {
      throw catalogError('invalid_source', 'invalid catalog source contract')
    }
    if (this.#sources.has(id) || this.#sources.size >= 16) throw catalogError('invalid_source', 'duplicate source or source limit exceeded')
    this.#sources.set(id, { id, kind, load, ttlMs, network, endpointOrigin, records: [], fetchedAt: null, attemptedAt: null, error: null, refreshing: false, digest: null, coverage: null })
  }
  async refresh(id, { authorizeNetwork = false, signal } = {}) {
    if (this.#closed) throw catalogError('catalog_closed', 'catalog is closed', 503)
    const source = this.#sources.get(id)
    if (!source) throw catalogError('unknown_source', 'catalog source is not configured', 404)
    if (source.refreshing) throw catalogError('catalog_busy', 'this source is already refreshing', 409)
    if (source.network === 'external' && authorizeNetwork !== true) throw catalogError('catalog_consent_required', 'explicit authorization is required to fetch external catalog metadata', 403)
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.#active.add(controller)
    source.refreshing = true
    source.attemptedAt = this.now()
    try {
      if (controller.signal.aborted) throw catalogError('cancelled', 'catalog refresh cancelled', 499)
      const snapshot = await source.load({ signal: controller.signal })
      if (controller.signal.aborted) throw catalogError('cancelled', 'catalog refresh cancelled', 499)
      if (!Array.isArray(snapshot?.records) || snapshot.records.length > MAX_RECORDS) throw catalogError('invalid_catalog', 'catalog response exceeds the record limit')
      const records = snapshot.records.map((record) => normalizeRecord(record, id))
      if (new Set(records.map((record) => record.key)).size !== records.length) throw catalogError('invalid_catalog', 'duplicate model revision in source response')
      // Validate the WHOLE replacement before publishing any part of it.
      const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex')
      source.records = records
      source.digest = digest
      source.fetchedAt = this.now()
      source.error = null
      source.coverage = snapshot.coverage === 'complete_response' ? 'complete_response' : 'bounded_page'
      this.onEvent({ type: 'catalog_refresh', sourceId: id, outcome: 'success', records: records.length, digest })
      return { ...this.sources().find((entry) => entry.id === id), refreshing: false }
    } catch (error) {
      // Never retain arbitrary upstream error text: it can contain credentials/URLs.
      const codes = new Set(['EGRESS_BLOCKED', 'timeout', 'cancelled', 'catalog_http_error', 'catalog_too_large', 'invalid_catalog'])
      source.error = codes.has(error.code) ? error.code : error.name === 'AbortError' ? 'cancelled' : 'catalog_refresh_failed'
      this.onEvent({ type: 'catalog_refresh', sourceId: id, outcome: 'failure', code: source.error })
      throw catalogError(source.error, 'catalog refresh failed; any previous snapshot is retained and marked stale', source.error === 'EGRESS_BLOCKED' ? 403 : source.error === 'cancelled' ? 499 : source.error === 'timeout' ? 504 : 502)
    } finally { source.refreshing = false; this.#active.delete(controller); signal?.removeEventListener('abort', abort) }
  }
  close() { this.#closed = true; for (const controller of this.#active) controller.abort() }
  sources() {
    return [...this.#sources.values()].map((source) => ({
      id: source.id, kind: source.kind, network: source.network, endpointOrigin: source.endpointOrigin, ttlMs: source.ttlMs,
      refreshPolicy: 'manual', fetchedAt: source.fetchedAt, attemptedAt: source.attemptedAt,
      refreshing: source.refreshing, lastError: source.error, recordCount: source.records.length,
      stale: source.fetchedAt === null || Boolean(source.error) || this.now() - source.fetchedAt >= source.ttlMs,
      snapshotSha256: source.digest, coverage: source.coverage,
    }))
  }
  search({ q = '', task = null, sourceId = null, limit = 100, offset = 0 } = {}) {
    if (typeof q !== 'string' || q.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(offset) || offset < 0 || offset > 8000) throw catalogError('invalid_query', 'invalid catalog search or pagination')
    const sources = this.sources()
    const needle = q.toLowerCase()
    const matches = [...this.#sources.values()].flatMap((source) => source.records)
      .filter((record) => (!sourceId || record.sourceId === sourceId) && (!task || record.tasks.includes(task))
        && `${record.id} ${record.publisher ?? ''} ${record.family ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => a.id.localeCompare(b.id) || a.sourceId.localeCompare(b.sourceId) || (a.revision ?? '').localeCompare(b.revision ?? ''))
    return structuredClone({ schema: CATALOG_SCHEMA, sources, total: matches.length, offset, limit,
      records: matches.slice(offset, offset + limit).map((record) => ({ ...record,
        provenance: { sourceId: record.sourceId, fetchedAt: sources.find((s) => s.id === record.sourceId).fetchedAt,
          snapshotSha256: sources.find((s) => s.id === record.sourceId).snapshotSha256 },
        stale: sources.find((s) => s.id === record.sourceId).stale,
      })) })
  }
}
