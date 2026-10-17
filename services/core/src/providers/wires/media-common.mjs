// Helpers shared by the online image and video wires.
//
// Media providers agree on almost nothing:
//
//   * some return inline base64 (OpenAI Images, Gemini Images, Recraft with b64_json);
//   * some return a URL that expires in minutes (Ideogram, BFL, fal, Replicate, Luma);
//   * some return the bytes themselves (Stability AI);
//   * some complete a request in one round-trip, others hand back an operation and expect
//     the caller to poll it.
//
// What they DO agree on, and what this module owns, is the part that must not be
// re-implemented per adapter: a generated artifact is only accepted as bytes, the bytes are
// bounded, a provider-supplied URL is never followed with a credential attached unless it is
// on the exact API origin the operator configured, and polling is bounded, cancellable and
// never reports a percentage the provider did not report.
//
// The product's own rule — "never display simulated generation results as real outputs" — is
// enforced downstream by `media/jobs.mjs` and `media/validate.mjs`. This module's job is to
// hand those validators real bytes or a precise failure, never a placeholder.

import { failure } from '../../online/failure.mjs'

export const IMAGE_MAX_BYTES = 24 * 1024 * 1024
export const VIDEO_MAX_BYTES = 96 * 1024 * 1024
export const MAX_PROMPT_CHARS = 4000

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

/** Validate a prompt once, so every adapter refuses the same inputs for the same reason. */
export function assertPrompt(prompt, { max = MAX_PROMPT_CHARS } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('invalid_prompt', 'A prompt is required.', 400)
  if (prompt.length > max) throw failure('invalid_prompt', `This product caps media prompts at ${max} characters.`, 400)
  if (CONTROL_CHARS.test(prompt)) throw failure('invalid_prompt', 'The prompt contains control characters.', 400)
}

/** A model id is a path component in several providers, so it is validated as one. */
export function assertModelId(model) {
  if (typeof model !== 'string' || !MODEL_ID.test(model) || model.includes('..')) {
    throw failure('invalid_model', 'Choose a listed media model.', 400)
  }
}

/** Strip data-URL framing if a provider returned it despite an inline-bytes request. */
export function stripDataUrl(value) {
  return typeof value === 'string' ? value.replace(/^data:[^;,]+;base64,/, '') : value
}

/**
 * Decode base64 strictly.
 *
 * `Buffer.from(value, 'base64')` is permissive: it drops characters it does not recognise,
 * so a JSON body, an error page or a truncated string can decode to non-empty garbage. The
 * re-encode check is what makes this a decode rather than a guess.
 */
export function decodeBase64(value, { maxBytes = IMAGE_MAX_BYTES, label = 'media' } = {}) {
  const compact = String(stripDataUrl(value) ?? '').replace(/\s+/g, '')
  if (!compact) throw failure('invalid_response', `The provider returned no ${label} bytes.`, 502)
  const bytes = Buffer.from(compact, 'base64')
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw failure('invalid_response', `The provider returned data that is not valid base64 ${label}.`, 502)
  }
  if (bytes.length > maxBytes) throw failure('response_too_large', `The generated ${label} exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`, 502)
  return bytes
}

/** Inline image bytes from the shapes the supported providers publish. */
export function inlineImageBytes(payload, { maxBytes = IMAGE_MAX_BYTES } = {}) {
  const candidates = [
    payload?.b64_json,
    payload?.image,
    payload?.data?.[0]?.b64_json,
    payload?.data?.[0]?.image,
    payload?.images?.[0]?.b64_json,
  ]
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0)
  return found ? decodeBase64(found, { maxBytes, label: 'image' }) : null
}

/** The first URL in a provider response, bounded to a sane string length. */
export function firstUrl(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 8 && value.length <= 4096) return value
  }
  return null
}

/**
 * Whether a provider-supplied URL may be fetched with the installation's credential.
 *
 * Only the exact origin of the configured API base qualifies. A CDN or delivery host is
 * public by design and needs no key; sending one there would leak the credential to a host
 * the operator never configured, and following a redirect would do the same thing more
 * quietly (the gateway refuses redirects outright).
 */
export function credentialAllowedFor(config, url) {
  try {
    return new URL(config.baseUrl).origin === url.origin
  } catch {
    return false
  }
}

/**
 * Fetch an artifact the provider described by URL.
 *
 * The transport still owns DNS filtering, redirect refusal, size ceilings and cancellation;
 * this function only decides whether the credential travels with the request. HTTPS is the
 * rule. An HTTP URL is admitted only when its exact origin is on the operator's trusted list
 * — the same allowlist the API endpoint itself needs.
 *
 * @returns {Promise<{bytes: Buffer, contentType: string|null}>}
 */
export async function downloadMedia(transport, config, uri, {
  signal = null,
  kind = 'image',
  headersFor = null,
  trustedOrigins = [],
  maxBytes = kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES,
} = {}) {
  let url
  try { url = new URL(uri) } catch { throw failure('invalid_completion', 'The provider returned an invalid artifact URL.', 502) }
  if (url.username || url.password) throw failure('invalid_completion', 'The provider artifact URL carries credentials, which this build refuses.', 502)
  const trustedHttp = url.protocol === 'http:' && trustedOrigins.includes(url.origin)
  if (url.protocol !== 'https:' && !trustedHttp) {
    throw failure('invalid_completion', 'The provider artifact URL must use HTTPS or an operator-trusted origin.', 502)
  }
  const path = `${url.pathname}${url.search}`
  if (!path || path.length > 8192) throw failure('invalid_completion', 'The provider artifact URL path is unusable.', 502)
  const sameOrigin = credentialAllowedFor(config, url)
  const headers = sameOrigin && typeof headersFor === 'function' ? headersFor(config) : {}
  const response = await transport({ ...config, baseUrl: url.origin }, path, {
    headers,
    signal,
    binary: true,
    maxResponseBytes: maxBytes,
  })
  const bytes = response?.bytes
  if (!bytes?.length) throw failure('invalid_completion', `The provider returned no ${kind} bytes.`, 502)
  if (bytes.length > maxBytes) throw failure('response_too_large', `The generated ${kind} exceeds the byte ceiling.`, 502)
  return { bytes, contentType: response?.contentType ?? null }
}

/** Sleep that rejects on cancellation rather than sleeping through it. */
export function sleep(ms, signal, message = 'Generation was cancelled.') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('cancelled', message, 499))
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, Math.max(1, ms))
    const abort = () => { clearTimeout(timer); reject(failure('cancelled', message, 499)) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Bounded polling schedule.
 *
 * Each provider documents a different cadence; the schedule starts at the documented value
 * and backs off to a ceiling. Attempts × maxMs is the wall-clock budget, and the caller's
 * job timeout is the second bound, so a provider that never finishes cannot hold a job open
 * indefinitely.
 */
export function pollSchedule({ initialMs = 1000, factor = 1.5, maxMs = 10_000, attempts = 120 } = {}) {
  let delay = Math.max(1, Number(initialMs) || 1)
  const ceiling = Math.max(delay, Number(maxMs) || delay)
  const mult = Math.max(1, Number(factor) || 1)
  const limit = Math.max(1, Math.min(600, Number(attempts) || 120))
  return {
    attempts: limit,
    next() { const current = delay; delay = Math.min(ceiling, Math.round(delay * mult)); return current },
  }
}

/** A status string from an arbitrary provider, normalised for a job record. */
export function normalisedState(value) {
  return String(value ?? 'unknown').toLowerCase().slice(0, 64)
}

/**
 * Validate a provider-supplied polling URL before it is used with a credential.
 *
 * Providers that hand back a `polling_url` / `status_url` (BFL, fal, Replicate) do so on
 * their own API origin. A URL elsewhere is either a provider mistake or an attempt to move
 * the request, and neither is followed with the key attached. The caller gets an explicit
 * refusal instead of a silent no-op.
 */
export function requireSameOrigin(config, value, label = 'polling URL') {
  let url
  try { url = new URL(value) } catch { throw failure('invalid_completion', `The provider returned an invalid ${label}.`, 502) }
  if (url.username || url.password) throw failure('invalid_completion', `The provider ${label} carries credentials.`, 502)
  if (!credentialAllowedFor(config, url)) {
    throw failure('invalid_completion', `The provider ${label} is not on the configured API origin, so the credential will not be sent to it.`, 502)
  }
  return { path: `${url.pathname}${url.search}`, url }
}

/**
 * A multipart/form-data body for providers that document it (Stability AI, Ideogram v2).
 *
 * Built by hand rather than with `FormData` because the transport sends a string body and a
 * content type it can also sign; a streaming FormData would change what the gateway's body
 * ceiling measures and make the same request unrepresentable as a signed string.
 */
export function multipartBody(fields) {
  const boundary = `----ragam${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`)
  }
  return { body: `${parts.join('')}--${boundary}--\r\n`, contentType: `multipart/form-data; boundary=${boundary}` }
}

/** Detect the common image containers without trusting the declared content type. */
export function sniffImage(bytes) {
  if (!bytes?.length) return null
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 12 && bytes.slice(0, 4).toString('latin1') === 'RIFF' && bytes.slice(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return null
}

/** Number of a documented value, or null. Keeps provider metadata out of typed fields. */
export function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null
}
