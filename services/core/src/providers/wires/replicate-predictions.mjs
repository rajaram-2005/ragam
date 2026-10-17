// Replicate predictions: submit, poll, then download the output URL.
//
// Verified against the official documentation on 2026-10-17:
//   https://replicate.com/docs/reference/http — `POST /v1/models/{owner}/{name}/predictions`
//     for official models; a prediction carries `id`, `status`, `urls.get`, `output` and
//     `error`; status is `starting`, `processing`, `succeeded`, `failed` or `canceled`;
//     cancellation is `POST /v1/predictions/{id}/cancel`.
//   https://replicate.com/docs/topics/models/official-models — the model/owner path needs no
//     version id.
//   https://replicate.com/docs/topics/predictions/create-a-prediction — polling the
//     prediction URL is the asynchronous mode; `Prefer: wait` is optional.
//
// Replicate output URLs are on `replicate.delivery` (and model-specific CDNs), not the API
// origin. They are fetched without the token.
//
// Model discovery: Replicate has a public `GET /v1/models` list, but it is a general model
// registry with no capability filter. Enumerating it would present text and audio models as
// image/video choices. Each media wire therefore names a short, documented set of official
// models, and the settings screen labels it curated.

import { failure } from '../../online/failure.mjs'
import {
  downloadMedia, firstUrl, normalisedState, pollSchedule,
  requireSameOrigin, sleep,
} from './media-common.mjs'

export const authHeaders = (config) => ({ authorization: `Bearer ${config.apiKey}`, accept: 'application/json' })
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One output URL from the shapes Replicate models return. */
export function outputUrl(output) {
  if (typeof output === 'string') return firstUrl(output)
  const list = Array.isArray(output) ? output : [output]
  for (const entry of list) {
    if (typeof entry === 'string') return firstUrl(entry)
    if (entry && typeof entry === 'object') {
      const found = firstUrl(entry.url, entry.video, entry.image, entry.output)
      if (found) return found
    }
  }
  return null
}

/**
 * Run one prediction.
 *
 * @returns {Promise<object>} the completed prediction object with a provider-supplied output URL
 */
export async function runPrediction(transport, config, { model, input, signal, onProgress, poll = {} }) {
  if (typeof model !== 'string' || !MODEL.test(model) || model.includes('..')) {
    throw failure('invalid_model', 'Choose a listed Replicate model (owner/name).', 400)
  }
  onProgress?.(5, 'submitting')
  const submitted = await transport(config, `/models/${model}/predictions`, {
    headers: authHeaders(config),
    signal,
    body: { input },
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const getUrl = firstUrl(submitted?.urls?.get)
  if (!getUrl) throw failure('invalid_completion', 'Replicate returned no prediction URL.', 502)
  const get = requireSameOrigin(config, getUrl, 'prediction URL')

  const cancelUrl = firstUrl(submitted?.urls?.cancel)
  let cancelPath = null
  try { cancelPath = cancelUrl ? requireSameOrigin(config, cancelUrl, 'cancel URL').path : null } catch { cancelPath = null }
  const onAbort = () => {
    if (!cancelPath) return
    // `POST /v1/predictions/{id}/cancel` is the documented cancellation. `urls.cancel`
    // is the provider-supplied form of the same endpoint; it is used verbatim.
    transport(config, cancelPath, { headers: authHeaders(config) }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const schedule = pollSchedule({
      initialMs: poll.initialMs ?? 1000,
      factor: poll.factor ?? 1.4,
      maxMs: poll.maxMs ?? 5000,
      attempts: poll.attempts ?? 180,
    })
    let prediction = submitted
    for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
      const state = normalisedState(prediction?.status)
      if (state === 'succeeded') return prediction
      if (['failed', 'canceled', 'cancelled'].includes(state)) {
        const reason = typeof prediction?.error === 'string' && prediction.error ? `: ${prediction.error.slice(0, 300)}` : ''
        throw failure(state === 'failed' ? 'provider_error' : 'cancelled', `Replicate prediction ended ${state}${reason}`, state === 'failed' ? 502 : 499)
      }
      await sleep(schedule.next(), signal, 'Replicate generation was cancelled.')
      prediction = await transport(config, get.path, { headers: authHeaders(config), signal, maxResponseBytes: 4 * 1024 * 1024 })
      onProgress?.(Math.min(75, 10 + attempt * 2), normalisedState(prediction?.status))
    }
    throw failure('provider_timeout', 'The Replicate prediction did not finish within the polling budget.', 504)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function downloadOutput(transport, config, uri, { signal, kind, trustedOrigins = [], maxBytes }) {
  return downloadMedia(transport, config, uri, {
    signal, kind, trustedOrigins, maxBytes,
    headersFor: authHeaders,
  })
}
