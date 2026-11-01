import { createHash, randomUUID } from 'node:crypto'
import { assertGenuineVideo, extractImageBytes, validateMedia } from '../media/validate.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])
const EXTENSIONS = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp', mp4: 'mp4', webm: 'webm' }

export class SupabaseMediaQueueError extends Error {
  constructor(code, status = 500) {
    super(code)
    this.name = 'SupabaseMediaQueueError'
    this.code = code
    this.status = status
  }
}

function rows(value, code, max = Infinity) {
  if (!Array.isArray(value) || value.length > max) throw new SupabaseMediaQueueError(code)
  return value
}
function query(pairs) { return new URLSearchParams(pairs).toString() }
function objectPath(path) { return path.split('/').map((part) => encodeURIComponent(part)).join('/') }
function ext(format) { return EXTENSIONS[format] ?? 'bin' }
function bytesFrom(result, kind) {
  if (!result || typeof result !== 'object') return null
  if (kind === 'video') return result.video ?? result.bytes ?? null
  if (result.bytes) return result.bytes
  for (const image of Array.isArray(result.images) ? result.images : []) {
    const value = extractImageBytes(image)
    if (value) return value
  }
  return null
}
function asBytes(value) {
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}
function safeText(value, max = 200) { return typeof value === 'string' && value.length <= max ? value : null }
function safeNumber(value) { return Number.isFinite(value) && value >= 0 ? value : null }

/**
 * Account-scoped media persistence using Postgres metadata and a private Storage bucket.
 * On Vercel, generation runs inside the bounded request rather than being detached as a
 * background job; enqueue resolves only after validation and durable object upload. A later
 * request can then safely poll or download the completed record.
 */
export class SupabaseMediaQueue {
  #client
  #accountId
  #bucket
  #ledger
  #now
  #maxArtifactBytes
  #timeoutMs

  constructor({ client, accountId, bucket = 'ragam-media', ledger = null, now = () => Date.now(), maxArtifactBytes = 24 * 1024 * 1024, timeoutMs = 45_000 } = {}) {
    if (!client || typeof client.request !== 'function') throw new SupabaseMediaQueueError('supabase_client_invalid')
    if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new SupabaseMediaQueueError('supabase_account_id_invalid')
    if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket)) throw new SupabaseMediaQueueError('supabase_storage_bucket_invalid')
    this.#client = client
    this.#accountId = accountId
    this.#bucket = bucket
    this.#ledger = ledger
    this.#now = now
    this.#maxArtifactBytes = Math.max(1024, Math.min(64 * 1024 * 1024, Number(maxArtifactBytes) || 24 * 1024 * 1024))
    this.#timeoutMs = Math.max(1_000, Math.min(50_000, Number(timeoutMs) || 45_000))
  }

  close() {}

  async enqueue({ kind, run, params = {}, subject = null, filenameHint = null, timeoutMs = this.#timeoutMs, signal = null } = {}) {
    if (!['image', 'video'].includes(kind)) throw new SupabaseMediaQueueError('media_kind_unsupported', 409)
    if (typeof run !== 'function') throw new TypeError('media job requires a run() function')
    const id = randomUUID()
    const createdAt = this.#now()
    const initialHistory = [{ at: createdAt, state: 'queued', stage: 'queued', progress: 0 }]
    const inserted = rows(await this.#client.request('rest/v1/ragam_media_jobs', {
      method: 'POST',
      query: 'select=id,account_id,kind,state,progress,stage,params,history,artifact_id,error_code,created_at,started_at,finished_at,updated_at',
      headers: { prefer: 'return=representation' },
      body: {
        id, account_id: this.#accountId, kind, state: 'queued', progress: 0, stage: 'queued',
        params, history: initialHistory, artifact_id: null, error_code: null,
        created_at: createdAt, started_at: null, finished_at: null, updated_at: createdAt,
      },
    }), 'media_job_insert_invalid', 1)
    if (inserted.length !== 1 || inserted[0]?.id !== id || inserted[0]?.account_id !== this.#accountId) {
      throw new SupabaseMediaQueueError('media_job_insert_invalid')
    }

    const controller = new AbortController()
    const startedAt = this.#now()
    let history = [...initialHistory, { at: startedAt, state: 'running', stage: 'running', progress: 0 }]
    await this.#patch(id, { state: 'running', stage: 'running', started_at: startedAt, history, updated_at: startedAt })
    const abortFromRequest = () => controller.abort(signal?.reason ?? new Error('request closed'))
    if (signal?.aborted) abortFromRequest()
    else signal?.addEventListener('abort', abortFromRequest, { once: true })
    const deadline = Math.max(1_000, Math.min(this.#timeoutMs, Number(timeoutMs) || this.#timeoutMs))
    let timer
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('media function time limit reached'))
          reject(new SupabaseMediaQueueError('media_function_timeout', 504))
        }, deadline)
      })
      const result = await Promise.race([Promise.resolve().then(() => run({ signal: controller.signal, job: { id, kind }, progress: () => {} })), timeout])
      clearTimeout(timer)
      if (controller.signal.aborted) throw new SupabaseMediaQueueError('media_request_aborted', 499)
      const rawBytes = asBytes(bytesFrom(result, kind))
      if (!rawBytes || rawBytes.byteLength === 0) return await this.#fail(id, history, 'media_output_missing', 'provider returned no media bytes')
      if (rawBytes.byteLength > this.#maxArtifactBytes) return await this.#fail(id, history, 'media_output_too_large', 'generated output exceeds the hosted artifact size limit')
      const validation = validateMedia({ bytes: rawBytes, expectedKind: kind, claimedContentType: result?.contentType ?? result?.mime ?? null, maxBytes: this.#maxArtifactBytes })
      if (!validation.valid) return await this.#fail(id, history, 'media_validation_failed', validation.reasons.join('; '))
      if (kind === 'video') {
        const genuine = assertGenuineVideo(validation)
        if (!genuine.genuine) return await this.#fail(id, history, 'media_validation_failed', genuine.problems.join('; '))
      }
      const sha256 = createHash('sha256').update(rawBytes).digest('hex')
      const fileName = `${(filenameHint || `${kind}-${id.slice(0, 8)}`).replace(/[^a-zA-Z0-9._-]/g, '_')}-${sha256.slice(0, 12)}.${ext(validation.format)}`
      const key = `${this.#accountId}/${id}/${fileName}`
      await this.#client.request(`storage/v1/object/${this.#bucket}/${objectPath(key)}`, {
        method: 'POST',
        headers: { 'content-type': validation.mime, 'x-upsert': 'false', 'cache-control': '3600' },
        body: rawBytes,
      })
      let artifactId = randomUUID()
      try {
        const artifactRows = rows(await this.#client.request('rest/v1/ragam_media_artifacts', {
          method: 'POST',
          query: 'select=id,account_id,job_id,object_key,sha256,content_type,size_bytes,created_at',
          headers: { prefer: 'return=representation' },
          body: { id: artifactId, account_id: this.#accountId, job_id: id, object_key: key, sha256, content_type: validation.mime, size_bytes: rawBytes.byteLength, created_at: this.#now() },
        }), 'media_artifact_insert_invalid', 1)
        if (artifactRows.length !== 1 || artifactRows[0]?.account_id !== this.#accountId || artifactRows[0]?.job_id !== id) {
          throw new SupabaseMediaQueueError('media_artifact_insert_invalid')
        }
        const finishedAt = this.#now()
        history = [...history, { at: finishedAt, state: 'succeeded', stage: 'complete', progress: 100 }]
        await this.#patch(id, {
          state: 'succeeded', stage: 'complete', progress: 1, artifact_id: artifactId,
          error_code: null, finished_at: finishedAt, updated_at: finishedAt, history,
        })
      } catch (error) {
        await this.#deleteObject(key).catch(() => {})
        throw error
      }
      this.#ledger?.record({ category: 'media', action: `succeed:${kind}`, outcome: 'success', subject: subject ?? this.#accountId, detail: { jobId: id, format: validation.format, bytes: rawBytes.byteLength, sha256 } })
      return await this.get(id)
    } catch (error) {
      clearTimeout(timer)
      const code = error?.code === 'media_function_timeout' ? 'media_function_timeout'
        : signal?.aborted ? 'media_request_aborted' : 'provider_failed'
      return await this.#fail(id, history, code, code === 'media_function_timeout'
        ? 'generation exceeded the Function request deadline'
        : code === 'media_request_aborted' ? 'generation stopped because the request closed' : 'generation could not be completed')
    } finally {
      signal?.removeEventListener('abort', abortFromRequest)
    }
  }

  async has(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return false
    const found = rows(await this.#client.request('rest/v1/ragam_media_jobs', {
      method: 'GET', query: query([['select', 'id'], ['id', `eq.${id}`], ['account_id', `eq.${this.#accountId}`], ['limit', '2']]),
    }), 'media_job_rows_invalid', 1)
    return found.length === 1
  }

  async get(id) {
    const record = await this.#getRow(id)
    const artifacts = record.artifact_id ? await this.#loadArtifacts([record.artifact_id]) : new Map()
    return this.#public(record, artifacts)
  }

  async list({ kind = null, limit = 50 } = {}) {
    const capped = Math.max(1, Math.min(100, Number(limit) || 50))
    const pairs = [['select', 'id,account_id,kind,state,progress,stage,params,history,artifact_id,error_code,created_at,started_at,finished_at,updated_at'], ['account_id', `eq.${this.#accountId}`], ['order', 'created_at.desc'], ['limit', String(capped)]]
    if (kind !== null) {
      if (!['image', 'video'].includes(kind)) return []
      pairs.push(['kind', `eq.${kind}`])
    }
    const records = rows(await this.#client.request('rest/v1/ragam_media_jobs', { method: 'GET', query: query(pairs) }), 'media_job_rows_invalid', capped)
    const artifacts = await this.#loadArtifacts(records.map((row) => row.artifact_id).filter(Boolean))
    return records.map((row) => this.#public(row, artifacts))
  }

  async cancel(id) {
    const record = await this.#getRow(id)
    if (TERMINAL.has(record.state)) return { cancelled: false, state: record.state, reason: 'job already terminal' }
    return { cancelled: false, state: record.state, reason: 'job execution is owned by its active bounded Function request' }
  }

  async readArtifact(id) {
    const record = await this.#getRow(id)
    if (!record.artifact_id) throw new SupabaseMediaQueueError('media_artifact_not_found', 404)
    const artifactRows = await this.#loadArtifacts([record.artifact_id])
    const artifact = artifactRows.get(record.artifact_id)
    if (!artifact || artifact.account_id !== this.#accountId || artifact.job_id !== id) throw new SupabaseMediaQueueError('media_artifact_not_found', 404)
    const bytes = await this.#client.request(`storage/v1/object/${this.#bucket}/${objectPath(artifact.object_key)}`, { method: 'GET', responseType: 'bytes' })
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Number(artifact.size_bytes)) throw new SupabaseMediaQueueError('media_artifact_corrupt')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== artifact.sha256) throw new SupabaseMediaQueueError('media_artifact_corrupt')
    return { bytes, artifact: this.#artifactView(artifact) }
  }

  async remove(id) {
    const record = await this.#getRow(id)
    if (!TERMINAL.has(record.state)) throw new SupabaseMediaQueueError('media_job_running', 409)
    const artifacts = record.artifact_id ? await this.#loadArtifacts([record.artifact_id]) : new Map()
    const artifact = artifacts.get(record.artifact_id)
    if (artifact) {
      await this.#patch(id, { artifact_id: null, updated_at: this.#now() })
      await this.#deleteObject(artifact.object_key)
      await this.#client.request('rest/v1/ragam_media_artifacts', {
        method: 'DELETE', query: query([['id', `eq.${artifact.id}`], ['account_id', `eq.${this.#accountId}`]]),
      })
    }
    await this.#client.request('rest/v1/ragam_media_jobs', {
      method: 'DELETE', query: query([['id', `eq.${id}`], ['account_id', `eq.${this.#accountId}`]]),
    })
    return { removed: true, id }
  }

  async #fail(id, history, code, message) {
    const finishedAt = this.#now()
    const state = code === 'media_function_timeout' ? 'timed_out' : code === 'media_request_aborted' ? 'cancelled' : 'failed'
    const nextHistory = [...history, { at: finishedAt, state, stage: state, progress: 0 }]
    await this.#patch(id, { state, stage: state, error_code: code, finished_at: finishedAt, updated_at: finishedAt, history: nextHistory })
    this.#ledger?.record({ category: 'media', action: `fail:${code}`, outcome: 'failure', subject: this.#accountId, detail: { jobId: id } })
    const job = await this.get(id)
    job.error = message
    return job
  }

  async #getRow(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new SupabaseMediaQueueError('media_job_not_found', 404)
    const found = rows(await this.#client.request('rest/v1/ragam_media_jobs', {
      method: 'GET', query: query([['select', 'id,account_id,kind,state,progress,stage,params,history,artifact_id,error_code,created_at,started_at,finished_at,updated_at'], ['id', `eq.${id}`], ['account_id', `eq.${this.#accountId}`], ['limit', '2']]),
    }), 'media_job_rows_invalid', 1)
    if (found.length !== 1 || found[0]?.account_id !== this.#accountId) throw new SupabaseMediaQueueError('media_job_not_found', 404)
    const row = found[0]
    if (row.state === 'running' && this.#now() - Number(row.updated_at) > this.#timeoutMs + 15_000) {
      const finishedAt = this.#now()
      const history = [...(Array.isArray(row.history) ? row.history : []), { at: finishedAt, state: 'timed_out', stage: 'timed_out', progress: Number(row.progress ?? 0) * 100 }].slice(-25)
      const stale = await this.#patch(id, { state: 'timed_out', stage: 'timed_out', error_code: 'media_function_interrupted', finished_at: finishedAt, updated_at: finishedAt, history })
      this.#ledger?.record({ category: 'media', action: 'interrupted:job', outcome: 'failure', subject: this.#accountId, detail: { jobId: id } })
      return stale
    }
    return row
  }

  async #patch(id, patch) {
    const changed = rows(await this.#client.request('rest/v1/ragam_media_jobs', {
      method: 'PATCH',
      query: query([['id', `eq.${id}`], ['account_id', `eq.${this.#accountId}`]]),
      headers: { prefer: 'return=representation' },
      body: patch,
    }), 'media_job_update_invalid', 1)
    if (changed.length !== 1 || changed[0]?.id !== id || changed[0]?.account_id !== this.#accountId) throw new SupabaseMediaQueueError('media_job_update_invalid')
    return changed[0]
  }

  async #loadArtifacts(ids) {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && UUID.test(id))
    if (unique.length === 0) return new Map()
    const filter = `in.(${unique.join(',')})`
    const found = rows(await this.#client.request('rest/v1/ragam_media_artifacts', {
      method: 'GET', query: query([['select', 'id,account_id,job_id,object_key,sha256,content_type,size_bytes,created_at'], ['id', filter], ['account_id', `eq.${this.#accountId}`], ['limit', String(unique.length + 1)]]),
    }), 'media_artifact_rows_invalid', unique.length)
    return new Map(found.map((row) => [row.id, row]))
  }

  #public(row, artifacts) {
    const artifact = row.artifact_id ? artifacts.get(row.artifact_id) : null
    const value = {
      id: row.id, kind: row.kind, state: row.state, params: row.params, subject: this.#accountId,
      progress: Math.round(Number(row.progress ?? 0) * 100), stage: row.stage,
      createdAt: Number(row.created_at), startedAt: row.started_at === null ? null : Number(row.started_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at), timeoutMs: this.#timeoutMs,
      error: row.error_code ? 'The media operation did not complete.' : null, errorCode: row.error_code,
      retryAfterMs: null, validation: null, artifact: artifact ? this.#artifactView(artifact) : null,
      result: null, terminal: TERMINAL.has(row.state), history: Array.isArray(row.history) ? row.history.slice(-25) : [],
    }
    return value
  }

  #artifactView(row) {
    const filename = row.object_key.split('/').at(-1)
    return {
      id: row.id, filename, format: filename.split('.').at(-1), mime: row.content_type,
      byteLength: Number(row.size_bytes), sizeOnDisk: Number(row.size_bytes), sha256: row.sha256,
      storedAt: Number(row.created_at),
    }
  }

  async #deleteObject(key) {
    return this.#client.request(`storage/v1/object/${this.#bucket}`, {
      method: 'DELETE', body: { prefixes: [key] },
    })
  }
}
