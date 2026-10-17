// Black Forest Labs (FLUX): asynchronous submit + poll.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.bfl.ai/quick_start/generating_images — `POST {base}/v1/{model}` with
//     `x-key: <key>` and a JSON body; the response carries `id` and a `polling_url`; poll
//     that URL (do not reconstruct it) until `status` is `Ready`, then take
//     `result.sample`; signed sample URLs expire (10 minutes per the quick start, one hour
//     per the FLUX 3 page).
//   https://docs.bfl.ai/flux_models/flux_1_1_pro — `prompt`, `width`, `height`.
//   https://docs.bfl.ai/flux_models/flux_1_1_pro_ultra_raw — `aspect_ratio` for Ultra.
//   https://docs.bfl.ai/api_integration/integration_guidelines — `polling_url` is required
//     on the global and regional endpoints.
//
// Credential handling on the second hop: the sampling URL is on `delivery.*.bfl.ai`, not the
// API origin. It is fetched without `x-key`. Sending the key there would hand it to a
// delivery host for no reason, and the provider's own docs say the signed URL needs no auth.
//
// Model discovery: no list endpoint is documented. The ids are the documented endpoints;
// `models()` returns a curated subset of stable (non-preview) ids.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, downloadMedia, firstUrl, normalisedState,
  pollSchedule, requireSameOrigin, sleep, IMAGE_MAX_BYTES,
} from './media-common.mjs'

export const wire = 'bfl_images'
export const credential = 'api_key'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const ASPECT_FOR_SIZE = Object.freeze({ '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' })
export const MODELS = Object.freeze([
  'flux-2-max', 'flux-2-pro', 'flux-2-flex', 'flux-2-klein-9b',
  'flux-pro-1.1-ultra', 'flux-pro-1.1', 'flux-dev',
])

const headers = (config) => ({ 'x-key': config.apiKey, accept: 'application/json' })
const ULTRA = /-ultra$/

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, size, signal, onProgress, poll = {}, trustedOrigins = [] }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `FLUX image model must be one of ${MODELS.join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const [width, height] = String(size ?? '').split('x').map(Number)
  const body = {
    prompt,
    output_format: 'png',
    ...(ULTRA.test(model)
      ? (size && size !== 'auto' && ASPECT_FOR_SIZE[size] ? { aspect_ratio: ASPECT_FOR_SIZE[size] } : {})
      : (Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {})),
  }
  onProgress?.(5, 'submitting')
  const submitted = await transport(config, `/v1/${encodeURIComponent(model)}`, {
    headers: headers(config),
    signal,
    body,
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const operation = firstUrl(submitted?.polling_url)
  if (!operation) throw failure('invalid_completion', 'FLUX returned no polling URL.', 502)
  const { path } = requireSameOrigin(config, operation, 'polling URL')

  const schedule = pollSchedule({ initialMs: poll.initialMs ?? 500, factor: poll.factor ?? 1.5, maxMs: poll.maxMs ?? 3000, attempts: poll.attempts ?? 120 })
  onProgress?.(10, 'queued')
  for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
    await sleep(schedule.next(), signal, 'FLUX generation was cancelled.')
    const result = await transport(config, path, { headers: headers(config), signal, maxResponseBytes: 2 * 1024 * 1024 })
    const state = normalisedState(result?.status)
    if (state === 'ready') {
      const uri = firstUrl(result?.result?.sample, result?.result?.url, result?.sample)
      if (!uri) throw failure('invalid_completion', 'FLUX reported Ready without a sample URL.', 502)
      onProgress?.(80, 'downloading')
      const file = await downloadMedia(transport, config, uri, {
        signal, kind: 'image', trustedOrigins, maxBytes: IMAGE_MAX_BYTES,
        // A delivery host is not the API origin; the key does not follow it.
        headersFor: () => headers(config),
      })
      onProgress?.(90, 'downloaded')
      return {
        bytes: file.bytes,
        model,
        revisedPrompt: null,
        contentType: file.contentType ?? 'image/png',
        usage: null,
        operation: submitted?.id ?? null,
      }
    }
    if (['error', 'failed', 'content moderated', 'request moderated', 'task not found'].includes(state)) {
      throw failure('provider_error', `FLUX reported ${state}; no image was produced.`, 502)
    }
    // `Pending` and `Processing` carry no measured fraction; progress stays bounded and
    // honest rather than inventing a percentage.
    onProgress?.(Math.min(75, 10 + attempt * 2), state)
  }
  throw failure('provider_timeout', 'The FLUX operation did not finish within the polling budget.', 504)
}
