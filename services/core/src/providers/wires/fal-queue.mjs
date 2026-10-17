// fal.ai Queue API: submit, poll status, fetch the result, cancel on abort.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.fal.ai/model-apis/model-endpoints/queue — `POST https://queue.fal.run/{model}`
//     with `Authorization: Key <key>`; the response carries `request_id`, `status_url`,
//     `response_url` and `cancel_url`; status is `IN_QUEUE`, `IN_PROGRESS` or `COMPLETED`;
//     the result is fetched from `response_url`; cancellation is a PUT/POST to `cancel_url`.
//   https://fal.ai/docs/model-endpoints/queue — the status/result URLs are per-model
//     `/requests/{request_id}` paths and the result is a model-specific JSON object.
//   https://fal.ai/docs/documentation/setting-up/authentication — the header is
//     `Authorization: Key <FAL_KEY>`, not Bearer.
//
// The model-specific part is deliberately outside this module: it only knows how to run a
// queue request. `fal-images.mjs` and `fal-video.mjs` supply inputs and extract the artifact.

import { failure } from '../../online/failure.mjs'
import {
  assertModelId, downloadMedia, firstUrl, normalisedState,
  pollSchedule, requireSameOrigin, sleep,
} from './media-common.mjs'

export const authHeaders = (config) => ({ authorization: `Key ${config.apiKey}`, accept: 'application/json' })
export const MODEL_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,200}$/

/**
 * Submit one model request and wait for its artifact URL.
 *
 * @returns {Promise<{result: object, responseUrl: string|null, modelId: string}>}
 */
export async function runQueue(transport, config, {
  model, input, signal, onProgress, poll = {}, trustedOrigins = [],
}) {
  assertModelId(model)
  if (!MODEL_PATH.test(model) || model.includes('..') || model.includes('//')) {
    throw failure('invalid_model', 'Choose a listed fal model.', 400)
  }
  onProgress?.(5, 'submitting')
  const submitted = await transport(config, `/${model}`, {
    headers: authHeaders(config),
    signal,
    body: input,
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const requestId = submitted?.request_id
  const statusUrl = firstUrl(submitted?.status_url)
  const responseUrl = firstUrl(submitted?.response_url)
  if (typeof requestId !== 'string' || !requestId || !statusUrl || !responseUrl) {
    throw failure('invalid_completion', 'fal returned no request id, status URL or response URL.', 502)
  }
  const status = requireSameOrigin(config, statusUrl, 'status URL')
  const resultPath = requireSameOrigin(config, responseUrl, 'result URL')

  // Cancellation is a real provider-side operation, not only a local state. The queue's
  // cancel endpoint is called once, best-effort: the local abort is already the authority on
  // whether this job continues, and a failed cancel request must not turn a user's
  // cancellation into an error page.
  const cancelUrl = firstUrl(submitted?.cancel_url)
  let cancelPath = null
  try { cancelPath = cancelUrl ? requireSameOrigin(config, cancelUrl, 'cancel URL').path : null } catch { cancelPath = null }
  const onAbort = () => {
    if (!cancelPath) return
    // fal documents cancellation as `PUT {cancel_url}`. The request is best-effort and
    // keyed, but it carries no body; a JSON body here would make the transport send POST.
    transport(config, cancelPath, { headers: authHeaders(config), method: 'PUT' }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const schedule = pollSchedule({
      initialMs: poll.initialMs ?? 1000,
      factor: poll.factor ?? 1.5,
      maxMs: poll.maxMs ?? 5000,
      attempts: poll.attempts ?? 180,
    })
    for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
      await sleep(schedule.next(), signal, 'fal generation was cancelled.')
      const state = await transport(config, status.path, { headers: authHeaders(config), signal, maxResponseBytes: 2 * 1024 * 1024 })
      const value = normalisedState(state?.status)
      if (value === 'completed') {
        onProgress?.(85, 'fetching result')
        const result = await transport(config, resultPath.path, { headers: authHeaders(config), signal, maxResponseBytes: 4 * 1024 * 1024 })
        return { result, responseUrl: responseUrl ?? null, modelId: model }
      }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(value)) {
        throw failure('provider_error', `fal reported ${value}; no artifact was produced.`, 502)
      }
      const position = Number.isInteger(state?.queue_position) ? `queue ${state.queue_position}` : value
      onProgress?.(Math.min(75, 10 + attempt * 2), position)
    }
    throw failure('provider_timeout', 'The fal queue request did not complete within the polling budget.', 504)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Download a provider result URL without the fal key (the CDN is a different origin). */
export async function fetchArtifact(transport, config, uri, { signal, kind, trustedOrigins = [], maxBytes }) {
  return downloadMedia(transport, config, uri, {
    signal, kind, trustedOrigins, maxBytes,
    // Not the API origin, so `downloadMedia` sends no auth header regardless; passing the
    // function documents that a same-origin result would still be authenticated.
    headersFor: authHeaders,
  })
}
