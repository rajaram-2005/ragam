// Media job queue: real lifecycle, progress, cancellation, storage, validation.
//
// Built around the verified FreeLLMAPI video semantics (docs/01-audit.md §3.2):
// the gateway holds one bounded request for minutes and cancels upstream work when
// the caller disconnects. So a "job" here owns an AbortController; cancelling the
// job aborts the fetch, which genuinely stops the provider-side poll.
//
// Nothing is ever reported as complete until its bytes pass validateMedia().

import { mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { validateMedia, assertGenuineVideo, MEDIA_KINDS, extractImageBytes } from './validate.mjs'

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  VALIDATING: 'validating',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
})

const TERMINAL = new Set([JOB_STATES.SUCCEEDED, JOB_STATES.FAILED, JOB_STATES.CANCELLED, JOB_STATES.TIMED_OUT])
const VALID_KINDS = new Set([MEDIA_KINDS.IMAGE, MEDIA_KINDS.VIDEO])

export class MediaJobQueue {
  /**
   * @param {object} options
   * @param {string} options.storageDir    where validated artifacts are written
   * @param {number} [options.concurrency] max simultaneous jobs (video is heavy: default 1)
   * @param {(e:object)=>void} [options.onEvent]
   * @param {object} [options.ledger]      audit ledger
   */
  constructor({ storageDir, concurrency = 1, onEvent = () => {}, ledger = null }) {
    if (!storageDir) throw new TypeError('MediaJobQueue requires a storageDir')
    this.storageDir = resolve(storageDir)
    this.concurrency = Math.max(1, concurrency)
    this.onEvent = onEvent
    this.ledger = ledger
    /** @type {Map<string, object>} */
    this.jobs = new Map()
    /** @type {Map<string, AbortController>} kept off the serialisable job record */
    this.controllers = new Map()
    this.pending = []
    this.active = 0
  }

  /**
   * Enqueue a job.
   * @param {object} spec
   * @param {'image'|'video'} spec.kind
   * @param {(ctx:{signal:AbortSignal, job:object, progress:(p:number,stage?:string)=>void})=>Promise<*>} spec.run
   * @param {object} [spec.params]   echoed into the job record for auditability
   * @param {number} [spec.timeoutMs]
   * @param {string} [spec.subject]  audit subject (e.g. conversation id)
   */
  enqueue({ kind, run, params = {}, timeoutMs = 600_000, subject = null, filenameHint = null }) {
    if (!VALID_KINDS.has(kind)) throw new TypeError(`invalid media kind '${kind}'`)
    if (typeof run !== 'function') throw new TypeError('job requires a run() function')

    const id = randomUUID()
    const controller = new AbortController()
    const job = {
      id,
      kind,
      state: JOB_STATES.QUEUED,
      params,
      subject,
      progress: 0,
      stage: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      timeoutMs,
      error: null,
      errorCode: null,
      retryAfterMs: null,
      artifact: null,
      validation: null,
      history: [{ at: Date.now(), state: JOB_STATES.QUEUED, stage: 'queued', progress: 0 }],
    }
    this.controllers.set(id, controller)
    this.jobs.set(id, job)
    this.pending.push({ id, run, filenameHint })
    this.#audit(`enqueue:${kind}`, 'info', { jobId: id }, subject)
    this.onEvent({ type: 'job_queued', jobId: id, kind })
    this.#pump()
    return this.publicView(job)
  }

  get(id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown media job '${id}'`)
    return this.publicView(job)
  }

  has(id) {
    return this.jobs.has(id)
  }

  list({ kind = null, limit = 50 } = {}) {
    return [...this.jobs.values()]
      .filter((job) => !kind || job.kind === kind)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((job) => this.publicView(job))
  }

  /**
   * Cancel a job. For a running provider call this aborts the HTTP request, which
   * makes FreeLLMAPI stop polling upstream — cancellation has a real effect, it is
   * not a UI-only state change.
   */
  cancel(id, reason = 'cancelled by user') {
    const job = this.jobs.get(id)
    if (!job) throw new Error(`unknown media job '${id}'`)
    if (TERMINAL.has(job.state)) return { cancelled: false, state: job.state, reason: 'job already terminal' }
    this.controllers.get(id)?.abort(new Error(reason))
    this.pending = this.pending.filter((entry) => entry.id !== id)
    this.#transition(job, JOB_STATES.CANCELLED, { stage: 'cancelled', error: reason })
    this.#audit(`cancel:${job.kind}`, 'denied', { jobId: id, reason }, job.subject)
    return { cancelled: true, state: job.state, reason }
  }

  /** Wait until a job reaches a terminal state (bounded). Used by tests and the API. */
  async waitFor(id, { timeoutMs = 60_000, pollMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = this.jobs.get(id)
      if (!job) throw new Error(`unknown media job '${id}'`)
      if (TERMINAL.has(job.state)) return this.publicView(job)
      if (Date.now() > deadline) throw new Error(`timed out waiting for job '${id}' (state=${job.state})`)
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  /** Read a stored artifact back, refusing any path that escapes storageDir. */
  async readArtifact(id) {
    const job = this.jobs.get(id)
    if (!job?.artifact?.path) throw new Error(`job '${id}' has no stored artifact`)
    const full = this.#safePath(job.artifact.path)
    return { bytes: new Uint8Array(await readFile(full)), artifact: this.publicView(job).artifact }
  }

  async deleteArtifact(id) {
    const job = this.jobs.get(id)
    if (!job?.artifact?.path) return { deleted: false }
    const full = this.#safePath(job.artifact.path)
    await unlink(full).catch(() => {})
    const removed = job.artifact.path
    job.artifact = null
    this.#audit('delete_artifact', 'success', { jobId: id, removed }, job.subject)
    return { deleted: true, removed }
  }

  // --- internals ----------------------------------------------------------

  #pump() {
    while (this.active < this.concurrency && this.pending.length) {
      const entry = this.pending.shift()
      this.active += 1
      this.#execute(entry).finally(() => {
        this.active -= 1
        this.#pump()
      })
    }
  }

  async #execute({ id, run, filenameHint }) {
    const job = this.jobs.get(id)
    if (!job || job.state === JOB_STATES.CANCELLED) return
    const controller = this.controllers.get(id)
    this.#transition(job, JOB_STATES.RUNNING, { stage: 'running', startedAt: Date.now() })

    const timer = setTimeout(() => {
      if (!TERMINAL.has(job.state)) {
        controller?.abort(new Error('timeout'))
        this.#transition(job, JOB_STATES.TIMED_OUT, { stage: 'timed_out', error: `exceeded ${job.timeoutMs}ms`, finishedAt: Date.now() })
        this.#audit(`timeout:${job.kind}`, 'failure', { jobId: id }, job.subject)
      }
    }, job.timeoutMs)

    const progress = (value, stage) => {
      job.progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
      if (stage) job.stage = String(stage)
      this.onEvent({ type: 'job_progress', jobId: id, progress: job.progress, stage: job.stage })
    }

    try {
      const result = await run({ signal: controller.signal, job: this.publicView(job), progress })
      clearTimeout(timer)
      if (TERMINAL.has(job.state)) return
      this.#transition(job, JOB_STATES.VALIDATING, { stage: 'validating', progress: 95 })
      await this.#finalize(job, result, filenameHint)
    } catch (error) {
      clearTimeout(timer)
      if (TERMINAL.has(job.state)) return
      const aborted = Boolean(controller?.signal.aborted)
      this.#transition(job, aborted ? JOB_STATES.CANCELLED : JOB_STATES.FAILED, {
        stage: aborted ? 'cancelled' : 'failed',
        error: error?.message ?? String(error),
        errorCode: error?.code ?? null,
        retryAfterMs: error?.retryAfterMs ?? null,
        finishedAt: Date.now(),
      })
      this.#audit(`fail:${job.kind}`, 'failure', { jobId: id, error: error?.message, code: error?.code }, job.subject)
    } finally {
      this.controllers.delete(id)
    }
  }

  async #finalize(job, result, filenameHint) {
    const expectedKind = job.kind === MEDIA_KINDS.VIDEO ? MEDIA_KINDS.VIDEO : MEDIA_KINDS.IMAGE
    const bytes = this.#extractBytes(result, job.kind)

    if (!bytes) {
      this.#transition(job, JOB_STATES.FAILED, { stage: 'failed', error: 'provider returned no media bytes', finishedAt: Date.now() })
      this.#audit(`fail:${job.kind}`, 'failure', { jobId: job.id, error: 'no media bytes' }, job.subject)
      return
    }

    const validation = validateMedia({ bytes, expectedKind, claimedContentType: result?.contentType ?? null })
    if (!validation.valid) {
      this.#transition(job, JOB_STATES.FAILED, {
        stage: 'failed',
        error: `output validation failed: ${validation.reasons.join('; ')}`,
        validation,
        finishedAt: Date.now(),
      })
      this.#audit(`reject:${job.kind}`, 'failure', { jobId: job.id, reasons: validation.reasons }, job.subject)
      return
    }

    if (job.kind === MEDIA_KINDS.VIDEO) {
      const genuine = assertGenuineVideo(validation)
      if (!genuine.genuine) {
        this.#transition(job, JOB_STATES.FAILED, {
          stage: 'failed',
          error: `not a genuine generated video: ${genuine.problems.join('; ')}`,
          validation,
          finishedAt: Date.now(),
        })
        this.#audit(`reject:${job.kind}`, 'failure', { jobId: job.id, reasons: genuine.problems }, job.subject)
        return
      }
    }

    const artifact = await this.#store(job, bytes, validation, filenameHint)
    this.#transition(job, JOB_STATES.SUCCEEDED, { stage: 'complete', progress: 100, artifact, validation, finishedAt: Date.now() })
    this.#audit(
      `succeed:${job.kind}`,
      'success',
      {
        jobId: job.id,
        format: validation.format,
        bytes: validation.byteLength,
        sha256: artifact.sha256,
        platform: result?.platform ?? null,
        modelId: result?.modelId ?? result?.model ?? null,
      },
      job.subject,
    )
    this.onEvent({ type: 'job_succeeded', jobId: job.id, artifact })
  }

  #extractBytes(result, kind) {
    if (!result) return null
    if (kind === MEDIA_KINDS.VIDEO) return result.video ? toUint8(result.video) : null
    if (result.bytes) return toUint8(result.bytes)
    const entries = Array.isArray(result.images) ? result.images : []
    for (const entry of entries) {
      const decoded = extractImageBytes(entry)
      if (decoded) return decoded
    }
    return null
  }

  async #store(job, bytes, validation, filenameHint) {
    const dir = join(this.storageDir, job.kind)
    await mkdir(dir, { recursive: true })
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const ext = extensionFor(validation.format)
    const base = (filenameHint || `${job.kind}-${job.id.slice(0, 8)}`).replace(/[^a-zA-Z0-9._-]/g, '_')
    const filename = `${base}-${sha256.slice(0, 12)}.${ext}`
    const full = join(dir, filename)
    await writeFile(full, bytes)
    const stats = await stat(full)
    return {
      path: `${job.kind}${sep}${filename}`,
      filename,
      format: validation.format,
      mime: validation.mime,
      byteLength: validation.byteLength,
      sizeOnDisk: stats.size,
      sha256,
      storedAt: Date.now(),
    }
  }

  #safePath(relative) {
    const full = resolve(this.storageDir, relative)
    if (full !== this.storageDir && !full.startsWith(this.storageDir + sep)) {
      throw new Error('artifact path escapes the media storage directory')
    }
    return full
  }

  #transition(job, state, extra = {}) {
    job.state = state
    Object.assign(job, extra)
    job.history.push({ at: Date.now(), state, stage: job.stage, progress: job.progress })
    this.onEvent({ type: 'job_state', jobId: job.id, state, stage: job.stage, progress: job.progress })
  }

  #audit(action, outcome, detail, subject) {
    this.ledger?.record({ category: 'media', action, outcome, subject: subject ?? null, detail })
  }

  /** Serialisable view — never exposes the AbortController or absolute paths. */
  publicView(job) {
    return {
      id: job.id,
      kind: job.kind,
      state: job.state,
      params: job.params,
      subject: job.subject,
      progress: job.progress,
      stage: job.stage,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      timeoutMs: job.timeoutMs,
      error: job.error,
      errorCode: job.errorCode,
      retryAfterMs: job.retryAfterMs,
      validation: job.validation,
      artifact: job.artifact,
      terminal: TERMINAL.has(job.state),
      history: job.history.slice(-25),
    }
  }
}

function extensionFor(format) {
  const map = {
    png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp',
    mp4: 'mp4', webm: 'webm', wav: 'wav', mp3: 'mp3', ogg: 'ogg', flac: 'flac',
  }
  return map[format] ?? 'bin'
}

function toUint8(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  return null
}
