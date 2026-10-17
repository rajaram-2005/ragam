// Google Veo through the Gemini API: a long-running operation, not a chat completion.
//
// Verified against the official documentation (2026-10-17):
//   https://ai.google.dev/gemini-api/docs/veo — `POST /v1beta/models/{model}:predictLongRunning`
//     with `{ instances: [{ prompt }], parameters: { sampleCount, aspectRatio, resolution } }`;
//     the operation is read with `GET /v1beta/{operation.name}`; the finished response carries
//     `response.generateVideoResponse.generatedSamples[0].video.uri`; that URI is downloaded with
//     the same `x-goog-api-key` header.
//   https://ai.google.dev/api/models — model listing returns `models[].name` and
//     `supportedGenerationMethods`, and paginates with `nextPageToken`.
//
// Why a new wire rather than the Gemini chat adapter: chat returns a candidate in one response,
// while video returns an operation name, needs bounded polling, and ends in bytes on a file URI.
// The credential is the same API key; the protocol is not.

import { failure } from '../../online/failure.mjs'
import { probeMp4 } from '../../media/validate.mjs'

export const wire = 'gemini_veo'
export const credential = 'api_key'
export const modality = 'video'

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16'])
export const RESOLUTIONS = Object.freeze(['720p', '1080p'])
export const MAX_PROMPT = 4000

const MODEL = /^[a-z0-9][a-z0-9._-]*$/i
const OPERATION = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/
const VEO = /^veo-/

const headers = (config) => ({ 'x-goog-api-key': config.apiKey })
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(failure('cancelled', 'Video generation was cancelled.', 499))
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  const abort = () => { clearTimeout(timer); reject(failure('cancelled', 'Video generation was cancelled.', 499)) }
  signal?.addEventListener('abort', abort, { once: true })
})

/**
 * Models the API itself says can run a long-running prediction. A name is not enough: the
 * `veo-` prefix plus the method list is the documented signal, and a model missing the method is
 * not offered just because its name looks right.
 */
export async function models(transport, config) {
  const found = []
  let token = null
  for (let page = 0; page < 5; page += 1) {
    const query = `?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const data = await transport(config, `/models${query}`, { headers: headers(config), maxResponseBytes: 4 * 1024 * 1024 })
    const list = Array.isArray(data?.models) ? data.models : []
    if (list.length > 1000) throw failure('model_list_too_large', 'The model list page is larger than this build will read.', 502)
    for (const model of list) {
      const name = typeof model?.name === 'string' ? model.name.replace(/^models\//, '') : ''
      if (!VEO.test(name)) continue
      const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : null
      if (methods && !methods.includes('predictLongRunning')) continue
      if (!found.includes(name)) found.push(name)
    }
    token = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null
    if (!token) return found.sort()
  }
  throw failure('model_list_too_large', 'The model list needs more than five pages; refusing to show a partial list.', 502)
}

/**
 * Start a video generation and wait for its operation to finish.
 *
 * Polling is bounded and cancellable; `poll` is a test seam, and the defaults are the interval
 * Google's own examples use (10 s). A cancelled job aborts the sleep and every request, so the
 * job's cancellation has a real effect rather than only changing a local record.
 */
export async function generate(transport, config, { model, prompt, aspectRatio, resolution, signal, onProgress, poll = {}, trustedOrigins = [] }) {
  if (typeof model !== 'string' || !MODEL.test(model)) throw failure('invalid_model', 'Choose a listed video model.', 400)
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('invalid_prompt', 'A prompt is required.', 400)
  if (prompt.length > MAX_PROMPT) throw failure('invalid_prompt', `This product caps video prompts at ${MAX_PROMPT} characters.`, 400)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) throw failure('invalid_prompt', 'The prompt contains control characters.', 400)
  if (aspectRatio !== undefined && !ASPECT_RATIOS.includes(aspectRatio)) throw failure('invalid_parameters', `Aspect ratio must be one of ${ASPECT_RATIOS.join(', ')}.`, 400)
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) throw failure('invalid_parameters', `Resolution must be one of ${RESOLUTIONS.join(', ')}.`, 400)

  onProgress?.(5, 'submitting')
  const started = await transport(config, `/models/${encodeURIComponent(model)}:predictLongRunning`, {
    headers: headers(config),
    signal,
    body: {
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        ...(aspectRatio ? { aspectRatio } : {}),
        ...(resolution ? { resolution } : {}),
      },
    },
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const operation = started?.name
  if (typeof operation !== 'string' || !OPERATION.test(operation) || operation.includes('..')) {
    throw failure('invalid_completion', 'The provider did not return a usable operation name.', 502)
  }

  const initial = Number(poll.initialMs ?? 10_000)
  const factor = Number(poll.factor ?? 1.4)
  const max = Number(poll.maxMs ?? 15_000)
  let delay = Math.max(1, initial)
  onProgress?.(10, 'queued')
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await sleep(delay, signal)
    const op = await transport(config, `/${operation}`, { headers: headers(config), signal, maxResponseBytes: 4 * 1024 * 1024 })
    if (op?.error) throw failure('provider_error', 'The video provider reported an error while rendering.', 502)
    if (op?.done !== true) {
      // No percentage is invented: the operation reports a state, not a measured fraction.
      onProgress?.(Math.min(70, 10 + attempt * 2), String(op?.metadata?.state ?? 'rendering').toLowerCase())
      delay = Math.min(max, Math.max(1, Math.round(delay * factor)))
      continue
    }
    const response = op?.response ?? null
    const filtered = response?.generateVideoResponse?.raiMediaFilteredReasons
    if (Array.isArray(filtered) && filtered.length) {
      throw failure('content_filtered', 'The provider filtered this generation; no video was produced.', 422)
    }
    const samples = response?.generateVideoResponse?.generatedSamples
    const generated = response?.generatedVideos
    const uri = samples?.[0]?.video?.uri ?? generated?.[0]?.video?.uri
    if (typeof uri !== 'string' || !uri) throw failure('invalid_completion', 'The completed operation carried no video URI.', 502)
    onProgress?.(80, 'downloading')
    const file = await downloadVideo(transport, { ...config, trustedOrigins }, uri, signal)
    const measured = probeMp4(file.bytes)
    onProgress?.(90, 'downloaded')
    return {
      video: file.bytes,
      contentType: file.contentType || 'video/mp4',
      model,
      platform: 'Google Veo',
      aspectRatio: aspectRatio ?? null,
      resolution: resolution ?? null,
      durationSeconds: measured?.durationSeconds ?? null,
      usage: null,
      operation,
    }
  }
  throw failure('provider_timeout', 'The video operation did not finish within the polling budget.', 504)
}

/**
 * Download the generated file.
 *
 * The API key is sent only to the configured API origin. A file URI on another public HTTPS host
 * is fetched without the credential — a CDN does not need it, and a credential must never follow
 * an untrusted redirect or a provider-supplied host. Redirects are refused by the gateway.
 */
async function downloadVideo(transport, config, uri, signal) {
  let url
  try { url = new URL(uri) } catch { throw failure('invalid_completion', 'The provider returned an invalid video URI.', 502) }
  const base = new URL(config.baseUrl)
  const sameOrigin = url.origin === base.origin
  // HTTPS is the rule. The only exception is an exact development origin the operator has
  // already trusted for the API itself (`trustedOrigins`), which is the same allowlist the
  // transport applies. A provider-supplied host never inherits trust by being loopback.
  const trustedHttp = url.protocol === 'http:' && (config.trustedOrigins ?? []).includes(url.origin)
  if (url.protocol !== 'https:' && !trustedHttp) {
    throw failure('invalid_completion', 'The video URI must use HTTPS or an operator-trusted origin.', 502)
  }
  const path = `${url.pathname}${url.search}`
  if (!path || path.length > 4096) throw failure('invalid_completion', 'The video URI path is unusable.', 502)
  const headers = sameOrigin ? { 'x-goog-api-key': config.apiKey } : {}
  const response = await transport({ ...config, baseUrl: url.origin }, path, {
    headers,
    signal,
    binary: true,
    maxResponseBytes: 64 * 1024 * 1024,
  })
  if (!response?.bytes?.length) throw failure('invalid_completion', 'The provider returned no video bytes.', 502)
  return { bytes: response.bytes, contentType: response.contentType ?? null }
}
