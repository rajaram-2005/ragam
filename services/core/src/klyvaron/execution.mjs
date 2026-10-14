// A single-slot on-device executor, shared by all first-party providers in a Core.
// Admission precedes load. No prompt queue, parallel model copies or remote fallback.
import { Worker } from 'node:worker_threads'
import { ProviderError } from '../providers/base.mjs'

const failure = (message, code, status = 503) => new ProviderError(message, { code, status })

export class LocalCpuExecutor {
  constructor({ idleTimeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) throw new TypeError('idleTimeoutMs must be nonnegative')
    this.idleTimeoutMs = idleTimeoutMs
    this.worker = null
    this.resident = null
    this.active = null
    this.retiring = Promise.resolve()
    this.closed = false
    this.idleTimer = null
  }

  snapshot() {
    return { backend: 'cpu', scope: 'core_host', state: this.closed ? 'closed' : this.active ? 'running' : this.worker ? 'idle' : 'cold',
      activeModel: this.active?.directory ?? null, residentModel: this.resident?.directory ?? null,
      residentWeightPayloadBytes: this.resident?.bytes ?? 0, capacity: 1, queueDepth: 0 }
  }

  async retire() {
    clearTimeout(this.idleTimer)
    const old = this.worker
    this.worker = null
    this.resident = null
    if (old) this.retiring = old.terminate().catch(() => {})
    await this.retiring
  }

  close() {
    this.closed = true
    this.active?.fail(failure('local executor closed', 'cancelled', 499))
    return this.retire()
  }

  async *events({ directory, expected, generation }, { signal = null, timeoutMs = 120_000 } = {}) {
    if (this.closed) throw failure('local executor is closed', 'executor_closed')
    if (signal?.aborted) throw failure('local generation cancelled before execution', 'cancelled', 499)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw failure('timeoutMs must be positive', 'invalid_request', 400)
    if (this.active) throw new ProviderError('local CPU is busy; keep the task and retry when capacity is free', { code: 'local_busy', status: 503, retryAfterMs: 250 })
    clearTimeout(this.idleTimer)
    const control = new Int32Array(new SharedArrayBuffer(8))
    const queue = []
    let wake = null, error = null, complete = false, worker = null
    const notify = () => { const resolve = wake; wake = null; resolve?.() }
    const fail = (reason) => {
      if (error || complete) return
      error = reason
      Atomics.store(control, 0, 1)
      Atomics.store(control, 1, 1)
      Atomics.notify(control, 1)
      notify()
      // This can interrupt a single long forward pass, not just the next token.
      void this.retire().then(() => { if (this.active === active) this.active = null })
    }
    const active = { directory, fail }
    this.active = active
    const abort = () => fail(failure('local generation cancelled; the task can be retried locally', 'cancelled', 499))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => fail(failure('local generation exceeded its wall-clock deadline', 'timeout', 504)), timeoutMs)
    const onMessage = (event) => {
      if (error || complete) return
      if (event.type === 'error') return fail(failure(event.message, event.code, event.code === 'invalid_request' ? 400 : event.code === 'cancelled' ? 499 : 503))
      if (event.type === 'loaded') this.resident = { directory, expected, bytes: event.residentWeightPayloadBytes }
      queue.push(event)
      notify()
    }
    const onError = (cause) => fail(failure(`local worker failed: ${cause.message}`, 'worker_failed'))
    const onExit = (code) => { if (!complete && !error) fail(failure(`local worker exited before completion (${code})`, 'worker_failed')) }
    try {
      // Recycle on model switch so old weights are actually freed before loading new ones.
      if (this.resident && (this.resident.directory !== directory || JSON.stringify(this.resident.expected) !== JSON.stringify(expected))) await this.retire()
      await this.retiring
      if (error) throw error
      if (!this.worker) {
        const created = new Worker(new URL('./worker.mjs', import.meta.url))
        // An idle worker must not produce an unhandled EventEmitter error.
        created.on('error', () => { if (!this.active && this.worker === created) void this.retire() })
        created.on('exit', () => {
          if (!this.active && this.worker === created) { this.worker = null; this.resident = null }
        })
        this.worker = created
      }
      worker = this.worker
      worker.ref()
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      worker.postMessage({ directory, expected, generation, controlBuffer: control.buffer })
      for (;;) {
        if (error) throw error
        if (!queue.length) { await new Promise((resolve) => { wake = resolve }); continue }
        const event = queue.shift()
        yield event
        if (event.type === 'token') {
          Atomics.store(control, 1, 1)
          Atomics.notify(control, 1)
        }
        if (event.type === 'result') { complete = true; break }
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker?.off('message', onMessage)
      worker?.off('error', onError)
      worker?.off('exit', onExit)
      // A timed-out slow consumer may unwind after another request has started.
      // Its cleanup must never retire that newer request's worker.
      if (this.active === active) {
        if (!complete || error || this.closed || this.idleTimeoutMs === 0) await this.retire()
        else {
          worker?.unref()
          this.idleTimer = setTimeout(() => { void this.retire() }, this.idleTimeoutMs)
          this.idleTimer.unref()
        }
        if (this.active === active) this.active = null
      }
    }
  }
}
