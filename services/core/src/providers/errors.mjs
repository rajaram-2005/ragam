// Provider error normalisation.
//
// Every adapter fails differently and most of them describe the failure in a body that may contain
// the credential that caused it. This module turns whatever arrived into one shape the rest of the
// system can reason about — and it is the place where "do not log API keys" is made structural
// rather than a habit: the normaliser never returns the raw body, and it redacts the message it
// does return.
//
// Retryability is a decision, not a guess:
//
//   429 / 503 / 504   retryable (honouring Retry-After when the vendor sent one)
//   500 / 502         retryable, with jitter added by the caller
//   408 / timeouts    retryable
//   401 / 403         not retryable — the credential or permission is wrong, and retrying spends
//                     the rate limit to learn the same thing
//   400 / 404 / 422   not retryable — the request or model id is wrong
//
// A provider that returns a body saying "insufficient_quota" on a 429 is not rate-limited; it is
// out of credit. Those are separated because they lead to different advice and different backoff.

export const PROVIDER_ERROR_CODES = Object.freeze({
  AUTH_FAILED: 'provider_auth_failed',
  PERMISSION_DENIED: 'provider_permission_denied',
  RATE_LIMITED: 'provider_rate_limited',
  QUOTA_EXHAUSTED: 'provider_quota_exhausted',
  INVALID_REQUEST: 'provider_invalid_request',
  MODEL_NOT_FOUND: 'provider_model_not_found',
  CONTEXT_LENGTH: 'provider_context_length',
  PAYLOAD_TOO_LARGE: 'provider_payload_too_large',
  SERVER_ERROR: 'provider_server_error',
  TIMEOUT: 'provider_timeout',
  NETWORK: 'provider_network',
  CANCELLED: 'cancelled',
  INVALID_RESPONSE: 'provider_invalid_response',
  UNKNOWN: 'provider_unknown',
})

/** Codes a caller may retry without changing the request. */
export const RETRYABLE = Object.freeze(new Set([
  PROVIDER_ERROR_CODES.RATE_LIMITED,
  PROVIDER_ERROR_CODES.SERVER_ERROR,
  PROVIDER_ERROR_CODES.TIMEOUT,
  PROVIDER_ERROR_CODES.NETWORK,
]))

const STATUS_MAP = Object.freeze({
  400: PROVIDER_ERROR_CODES.INVALID_REQUEST,
  401: PROVIDER_ERROR_CODES.AUTH_FAILED,
  402: PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED,
  403: PROVIDER_ERROR_CODES.PERMISSION_DENIED,
  404: PROVIDER_ERROR_CODES.MODEL_NOT_FOUND,
  408: PROVIDER_ERROR_CODES.TIMEOUT,
  413: PROVIDER_ERROR_CODES.PAYLOAD_TOO_LARGE,
  422: PROVIDER_ERROR_CODES.INVALID_REQUEST,
  429: PROVIDER_ERROR_CODES.RATE_LIMITED,
  500: PROVIDER_ERROR_CODES.SERVER_ERROR,
  502: PROVIDER_ERROR_CODES.SERVER_ERROR,
  503: PROVIDER_ERROR_CODES.SERVER_ERROR,
  504: PROVIDER_ERROR_CODES.SERVER_ERROR,
})

/**
 * Patterns that are credentials rather than prose. Redaction is deliberately blunt: a false
 * positive costs a less readable error, and a false negative costs a leaked key in a log.
 */
const SECRET_PATTERNS = Object.freeze([
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,                 // OpenAI-style keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,                 // Authorization headers echoed back
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{6,}/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,                      // AWS access key ids
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,                          // Google API keys
  /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g,                     // Slack tokens
])

export function redact(text) {
  let value = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, '[redacted]')
  return value
}

/** A short, redacted excerpt. The body is never returned whole, even when it looks harmless. */
function excerpt(body, limit = 240) {
  if (body === undefined || body === null) return ''
  let text = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body) } catch { return '' } })()
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Parse `Retry-After` as seconds or an HTTP date. Returns milliseconds or null. */
export function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? null
  if (raw === null || raw === '') return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15 * 60_000)
  const date = Date.parse(raw)
  if (Number.isNaN(date)) return null
  return Math.max(0, Math.min(date - Date.now(), 15 * 60_000))
}

/**
 * Normalise anything an adapter can throw.
 *
 * @param {Error|{status?:number, body?:any, headers?:object, code?:string, message?:string, timeout?:boolean}} error
 * @returns {{code:string, retryable:boolean, status:number|null, retryAfterMs:number|null, message:string, detail:string}}
 */
export function normaliseProviderError(error = {}) {
  const status = Number.isInteger(error.status) ? error.status : null
  const headers = error.headers ?? {}
  const detail = redact(excerpt(error.body ?? error.detail ?? '')).slice(0, 240)

  // A caller's cancellation is not a provider failure and must not be retried.
  if (error.code === PROVIDER_ERROR_CODES.CANCELLED || error.code === 'cancelled' || error.name === 'AbortError') {
    return Object.freeze({
      code: PROVIDER_ERROR_CODES.CANCELLED,
      retryable: false,
      status,
      retryAfterMs: null,
      message: 'The request was cancelled.',
      detail: '',
    })
  }

  if (error.timeout === true || error.code === 'ETIMEDOUT' || status === 408) {
    return Object.freeze({
      code: PROVIDER_ERROR_CODES.TIMEOUT,
      retryable: true,
      status,
      retryAfterMs: retryAfterMs(headers),
      message: 'The provider did not answer within the deadline.',
      detail,
    })
  }

  // Vendors disagree about which status means "out of credit". Where the body names it, believe
  // the body over the status: a 429 quota error is not a rate limit and should not back off.
  const quota = /insufficient[_\s-]?quota|exceeded your current quota|billing|credit balance/i.test(detail)
  if (quota && (status === 429 || status === 402 || status === 403)) {
    return Object.freeze({
      code: PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED,
      retryable: false,
      status,
      retryAfterMs: null,
      message: 'The provider account has no remaining quota. Retrying will not help; check billing and limits.',
      detail,
    })
  }

  const context = /context[_\s-]?(?:length|window)|maximum context|too many tokens/i.test(detail)
  if (context) {
    return Object.freeze({
      code: PROVIDER_ERROR_CODES.CONTEXT_LENGTH,
      retryable: false,
      status,
      retryAfterMs: null,
      message: 'The request is longer than the model\'s context window.',
      detail,
    })
  }

  const code = STATUS_MAP[status] ?? (error.code && Object.values(PROVIDER_ERROR_CODES).includes(error.code) ? error.code : null)
  if (code) {
    return Object.freeze({
      code,
      retryable: RETRYABLE.has(code),
      status,
      retryAfterMs: retryAfterMs(headers),
      message: messageFor(code, status),
      detail,
    })
  }

  // No status at all: a socket-level failure. The message is the only evidence, so it is redacted
  // and truncated like everything else.
  if (error.cause || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(String(error.message ?? ''))) {
    return Object.freeze({
      code: PROVIDER_ERROR_CODES.NETWORK,
      retryable: true,
      status,
      retryAfterMs: null,
      message: 'Could not reach the provider.',
      detail,
    })
  }

  return Object.freeze({
    code: PROVIDER_ERROR_CODES.UNKNOWN,
    retryable: false,
    status,
    retryAfterMs: null,
    message: 'The provider returned an unrecognised failure.',
    detail: detail || redact(String(error.message ?? '')).slice(0, 240),
  })
}

function messageFor(code, status) {
  switch (code) {
    case PROVIDER_ERROR_CODES.AUTH_FAILED: return 'The provider rejected the credential.'
    case PROVIDER_ERROR_CODES.PERMISSION_DENIED: return 'The credential is valid but not permitted to use this model or endpoint.'
    case PROVIDER_ERROR_CODES.RATE_LIMITED: return 'The provider is rate-limiting this account.'
    case PROVIDER_ERROR_CODES.INVALID_REQUEST: return 'The provider rejected the request as invalid.'
    case PROVIDER_ERROR_CODES.MODEL_NOT_FOUND: return 'The provider does not know that model id.'
    case PROVIDER_ERROR_CODES.PAYLOAD_TOO_LARGE: return 'The request is larger than the provider accepts.'
    case PROVIDER_ERROR_CODES.SERVER_ERROR: return `The provider failed with HTTP ${status}.`
    default: return 'The provider request failed.'
  }
}

/**
 * What a caller may do next, as advice rather than an action. Kept separate from the code so the
 * UI never has to guess, and never retries something the normaliser called permanent.
 */
export function adviceFor(normalised) {
  if (normalised.retryable) {
    return normalised.retryAfterMs
      ? `Wait ${Math.ceil(normalised.retryAfterMs / 1000)}s, then retry.`
      : 'Retry with backoff.'
  }
  switch (normalised.code) {
    case PROVIDER_ERROR_CODES.AUTH_FAILED: return 'Check the key for this provider; do not reuse another provider\'s key.'
    case PROVIDER_ERROR_CODES.PERMISSION_DENIED: return 'Confirm the key\'s project has access to this model and endpoint.'
    case PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED: return 'Check the account\'s billing and quota; retrying will not help.'
    case PROVIDER_ERROR_CODES.MODEL_NOT_FOUND: return 'Refresh the model list and choose a model the provider reports.'
    case PROVIDER_ERROR_CODES.CONTEXT_LENGTH: return 'Shorten the conversation or choose a model with a larger context window.'
    case PROVIDER_ERROR_CODES.INVALID_REQUEST: return 'Check the parameters against the provider\'s documentation.'
    case PROVIDER_ERROR_CODES.CANCELLED: return 'Nothing to do; the request was cancelled.'
    default: return 'Read the provider\'s error and adjust the request.'
  }
}
