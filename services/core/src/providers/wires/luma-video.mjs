// Luma AI Dream Machine: asynchronous video generations.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.lumalabs.ai/docs/video-generation — `POST {base}/generations` with
//     `prompt`, `model`, `resolution` (`540p`, `720p`, `1080p`, `4k`) and
//     `duration` (`"5s"`); `GET /generations/{id}` returns a generation whose `state` is
//     `queued`, `dreaming`, `completed` or `failed`, and whose `assets.video` is the clip URL
//     once completed.
//   https://docs.lumalabs.ai/docs/api — bearer token; base
//     `https://api.lumalabs.ai/dream-machine/v1`.
//   https://docs.lumalabs.ai/reference/creategeneration — `model` defaults to `ray-2`.
//
// The clip URL is a CDN URL, not the API origin. It is downloaded without the bearer token.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, downloadMedia, firstUrl, normalisedState,
  pollSchedule, sleep, VIDEO_MAX_BYTES,
} from './media-common.mjs'

export const wire = 'luma_video'
export const credential = 'api_key'
export const modality = 'video'

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16'])
export const RESOLUTIONS = Object.freeze(['720p', '1080p'])
export const MODELS = Object.freeze(['ray-2'])

const headers = (config) => ({ authorization: `Bearer ${config.apiKey}`, accept: 'application/json' })

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, {
  model, prompt, aspectRatio, resolution, signal, onProgress, poll = {}, trustedOrigins = [],
}) {
  assertPrompt(prompt, { max: 5000 })
  if (!MODELS.includes(model)) throw failure('invalid_model', `Luma video model must be one of ${MODELS.join(', ')}.`, 400)
  if (aspectRatio !== undefined && !ASPECT_RATIOS.includes(aspectRatio)) throw failure('invalid_parameters', `Aspect ratio must be one of ${ASPECT_RATIOS.join(', ')}.`, 400)
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) throw failure('invalid_parameters', `Resolution must be one of ${RESOLUTIONS.join(', ')}.`, 400)

  onProgress?.(5, 'submitting')
  const submitted = await transport(config, '/generations', {
    headers: headers(config),
    signal,
    body: {
      prompt,
      model,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
      duration: '5s',
    },
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const generationId = submitted?.id
  if (typeof generationId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(generationId)) {
    throw failure('invalid_completion', 'Luma returned no usable generation id.', 502)
  }
  const path = `/generations/${encodeURIComponent(generationId)}`
  // Luma documents DELETE /generations/{id} to cancel. Best-effort, like every provider-side
  // cancellation here: the local abort already decides that this job stops waiting.
  const onAbort = () => {
    transport(config, path, { headers: headers(config), method: 'DELETE' }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const schedule = pollSchedule({
    initialMs: poll.initialMs ?? 3000,
    factor: poll.factor ?? 1.2,
    maxMs: poll.maxMs ?? 10_000,
    attempts: poll.attempts ?? 180,
  })
  try {
  for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
    await sleep(schedule.next(), signal, 'Luma generation was cancelled.')
    const generation = await transport(config, path, { headers: headers(config), signal, maxResponseBytes: 2 * 1024 * 1024 })
    const state = normalisedState(generation?.state)
    if (state === 'completed') {
      const uri = firstUrl(generation?.assets?.video, generation?.assets?.video_raw)
      if (!uri) throw failure('invalid_completion', 'Luma reported completed without a video URL.', 502)
      onProgress?.(85, 'downloading')
      const file = await downloadMedia(transport, config, uri, {
        signal, kind: 'video', trustedOrigins, maxBytes: VIDEO_MAX_BYTES,
        headersFor: headers,
      })
      return {
        video: file.bytes,
        contentType: file.contentType ?? 'video/mp4',
        model: typeof generation?.model === 'string' ? generation.model : model,
        platform: 'Luma AI',
        aspectRatio: aspectRatio ?? null,
        resolution: resolution ?? null,
        durationSeconds: null,
        usage: null,
        generationId,
      }
    }
    if (state === 'failed') {
      const reason = typeof generation?.failure_reason === 'string' && generation.failure_reason ? `: ${generation.failure_reason.slice(0, 300)}` : ''
      throw failure('provider_error', `Luma generation failed${reason}`, 502)
    }
    onProgress?.(Math.min(75, 10 + attempt * 2), state)
  }
  throw failure('provider_timeout', 'The Luma generation did not finish within the polling budget.', 504)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
