// Ideogram v2: `POST {base}/v2/image/generate/{model}`.
//
// Verified against the official documentation on 2026-10-17:
//   https://developer.ideogram.ai/ideogram-api/api-overview — every v2 endpoint is
//     `POST /v2/{content}/{action}/{model}`; the model id is part of the path.
//   https://developer.ideogram.ai/v2/api-reference/images/generate/ideogram-4-5.md —
//     authentication is the `Api-Key` header; the body is `multipart/form-data` with
//     `prompt` and an optional exact `size` (`WIDTHxHEIGHT`, a supported 1K/2K preset,
//     or `auto`); the synchronous response carries `data[]` objects with a `url`.
//   https://developer.ideogram.ai/v2/api-reference/generations/get-generation — an
//     asynchronous request returns `generation_id` and is polled; this adapter uses the
//     synchronous mode because the product's job queue already owns asynchronous work.
//
// Ideogram URLs expire and are served from Ideogram's own delivery hosts. They are fetched
// without the API key, which is sent only to the configured API origin.
//
// Model discovery: the current docs show model ids in the path but no list endpoint. The
// ids below are the documented text-to-image models; `models()` returns them as curated.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, downloadMedia, firstUrl, multipartBody,
  normalisedState, pollSchedule, sleep,
} from './media-common.mjs'

export const wire = 'ideogram_images'
export const credential = 'api_key'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const MODELS = Object.freeze(['ideogram-4-5', 'ideogram-4', 'ideogram-3'])

const headers = (config) => ({ 'Api-Key': config.apiKey })

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, size, signal, onProgress, trustedOrigins = [], poll = {} }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Ideogram image model must be one of ${MODELS.join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  // `auto` is a documented value. Omitting the field is equivalent, and is used when the UI
  // has no explicit size so that the provider applies its own default.
  const form = multipartBody({
    prompt,
    ...(size && size !== 'auto' ? { size } : {}),
  })
  const data = await transport(config, `/v2/image/generate/${encodeURIComponent(model)}`, {
    headers: headers(config),
    body: form.body,
    contentType: form.contentType,
    signal,
    maxResponseBytes: 4 * 1024 * 1024,
  })

  let entry = Array.isArray(data?.data) ? data.data[0] : null
  let usage = null
  // The same endpoint can answer synchronously or with a `generation_id`, depending on
  // model and deployment. Both documented shapes are handled here rather than assuming
  // the first one; a request that is accepted asynchronously is polled to completion.
  if (!entry && data?.generation_id) {
    const generationId = data.generation_id
    if (typeof generationId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(generationId)) {
      throw failure('invalid_completion', 'Ideogram returned an unusable generation id.', 502)
    }
    const schedule = pollSchedule({
      initialMs: poll.initialMs ?? 1000,
      factor: poll.factor ?? 1.5,
      maxMs: poll.maxMs ?? 5000,
      attempts: poll.attempts ?? 120,
    })
    onProgress?.(10, 'queued')
    for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
      await sleep(schedule.next(), signal, 'Ideogram generation was cancelled.')
      const current = await transport(config, `/v2/generations/${encodeURIComponent(generationId)}`, {
        headers: headers(config),
        signal,
        maxResponseBytes: 4 * 1024 * 1024,
      })
      const state = normalisedState(current?.status)
      if (state === 'completed') {
        entry = Array.isArray(current?.data) ? current.data[0] : null
        usage = Number.isFinite(current?.usage_cost_usd_micros) ? { usdMicros: current.usage_cost_usd_micros } : null
        break
      }
      if (state === 'failed') {
        const reason = typeof current?.failure_reason === 'string' ? `: ${current.failure_reason.slice(0, 200)}` : ''
        throw failure('provider_error', `Ideogram generation failed${reason}`, 502)
      }
      onProgress?.(Math.min(75, 10 + attempt * 2), state)
    }
    if (!entry) throw failure('provider_timeout', 'The Ideogram generation did not finish within the polling budget.', 504)
  }
  if (!entry) throw failure('invalid_completion', 'Ideogram returned no generated image.', 502)
  const uri = firstUrl(entry.url, entry.image_url)
  if (!uri) throw failure('invalid_completion', 'Ideogram returned no image URL.', 502)
  onProgress?.(85, 'downloading')
  const file = await downloadMedia(transport, config, uri, { signal, kind: 'image', trustedOrigins })
  return {
    bytes: file.bytes,
    model,
    revisedPrompt: typeof entry.prompt === 'string' ? entry.prompt : null,
    contentType: file.contentType,
    usage,
  }
}
