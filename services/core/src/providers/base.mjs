// Provider interface + honest readiness probing.
//
// Directive §9: "Each model adapter must declare what it actually supports. Test
// every advertised operation against the connected provider or locally installed
// runtime." A provider that is not installed reports NOT_INSTALLED; one that is
// installed but unreachable reports UNREACHABLE. Neither is ever presented as
// ready, and neither produces fabricated output.

import { AVAILABILITY } from '../router/registry.mjs'

export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', status = null, retryAfterMs = null, cause = null } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
    if (cause) this.cause = cause
  }
}

/** Thrown when a caller asks a provider for an operation it does not implement. */
export class CapabilityUnsupportedError extends ProviderError {
  constructor(provider, operation) {
    super(`provider '${provider}' does not support operation '${operation}'`, { code: 'capability_unsupported' })
    this.name = 'CapabilityUnsupportedError'
    this.provider = provider
    this.operation = operation
  }
}

export const OPERATIONS = Object.freeze({
  CHAT: 'chat',
  CHAT_STREAM: 'chat_stream',
  EMBED: 'embed',
  RERANK: 'rerank',
  IMAGE_GENERATE: 'image_generate',
  IMAGE_UNDERSTAND: 'image_understand',
  IMAGE_EDIT: 'image_edit',
  VIDEO_GENERATE: 'video_generate',
  VIDEO_UNDERSTAND: 'video_understand',
  AUDIO_SPEECH: 'audio_speech',
  AUDIO_TRANSCRIBE: 'audio_transcribe',
})

export class BaseProvider {
  /**
   * @param {object} options
   * @param {string} options.name
   * @param {object} options.guard  egress guard; every request MUST go through guard.fetch
   * @param {(e:object)=>void} [options.onEvent]
   */
  constructor({ name, guard, onEvent = () => {}, timeoutMs = 120_000 }) {
    if (!name) throw new TypeError('provider requires a name')
    if (!guard?.fetch) throw new TypeError('provider requires an egress guard with a fetch()')
    this.name = name
    this.guard = guard
    this.onEvent = onEvent
    this.timeoutMs = timeoutMs
  }

  /** Operations this adapter actually implements. Subclasses override. */
  static operations = []

  supports(operation) {
    return this.constructor.operations.includes(operation)
  }

  /**
   * Assert support before doing work, so an unsupported operation fails loudly
   * instead of returning an empty or placeholder result.
   */
  assertSupports(operation) {
    if (!this.supports(operation)) throw new CapabilityUnsupportedError(this.name, operation)
  }

  /**
   * Measure availability. Must not throw: it returns a status instead.
   * @returns {Promise<{availability:string, detail:*}>}
   */
  async probe() {
    return { availability: AVAILABILITY.NOT_INSTALLED, detail: 'probe not implemented' }
  }

  /** guard.fetch with a bounded timeout, mapping aborts to a 504-style error. */
  async fetchWithTimeout(url, init = {}, { timeoutMs = this.timeoutMs, operation = 'request' } = {}) {
    const controller = new AbortController()
    const external = init.signal
    if (external) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', () => controller.abort(external.reason), { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const started = Date.now()
    try {
      const response = await this.guard.fetch(url, { ...init, signal: controller.signal })
      this.onEvent({ type: 'provider_request', provider: this.name, operation, status: response.status, ms: Date.now() - started })
      return response
    } catch (error) {
      const ms = Date.now() - started
      if (controller.signal.aborted && (!external || !external.aborted)) {
        this.onEvent({ type: 'provider_timeout', provider: this.name, operation, ms })
        throw new ProviderError(`${this.name}: ${operation} timed out after ${timeoutMs}ms`, { code: 'timeout', status: 504, cause: error })
      }
      if (error?.code === 'EGRESS_BLOCKED') throw error
      this.onEvent({ type: 'provider_error', provider: this.name, operation, ms, message: error?.message })
      throw new ProviderError(`${this.name}: ${operation} failed — ${error?.message ?? 'unknown'}`, { code: 'unreachable', status: 502, cause: error })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Parse the uniform error contract documented in docs/01-audit.md §3.2:
 * `{error:{message,type,code?}}` plus an optional `Retry-After` header.
 */
export async function readProviderError(response, providerName, operation) {
  let payload = null
  let text = ''
  try {
    text = await response.text()
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  const err = payload?.error ?? {}
  const retryHeader = response.headers?.get?.('retry-after')
  const retryAfterMs = retryHeader ? Math.max(0, Number(retryHeader) * 1000) : null
  const message = err.message || text.slice(0, 300) || `${operation} failed with HTTP ${response.status}`
  return new ProviderError(`${providerName}: ${message}`, {
    code: err.code || err.type || 'http_error',
    status: response.status,
    retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
  })
}

/** True for statuses worth retrying once (429/5xx), honouring Retry-After. */
export function isRetryable(error) {
  if (!error) return false
  if (error.code === 'timeout' || error.code === 'unreachable') return true
  return error.status === 429 || (error.status >= 500 && error.status <= 599)
}
