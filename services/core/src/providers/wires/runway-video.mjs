// Runway: asynchronous video tasks.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.dev.runwayml.com/ — base `https://api.dev.runwayml.com`; every request
//     needs `Authorization: Bearer <secret>` and `X-Runway-Version: 2024-11-06`.
//   https://docs.dev.runwayml.com/api-details/sdks/ — generation returns a task `id`; poll
//     `GET /v1/tasks/{id}` until `SUCCEEDED`, `FAILED` or `CANCELLED`.
//   https://docs.dev.runwayml.com/assets/outputs/ — a succeeded task carries an `output`
//     array of signed URLs.
//   https://docs.dev.runwayml.com/api-details/api_changelog/ — current models include
//     `gen4.5`, `gen4_turbo`, `veo3.1` and `veo3.1_fast` on `/v1/text_to_video`.
//
// Ratios are the provider's colon form, not the product's `16:9` label. Duration is sent only
// to the gen4 family, whose documented range is 2–10 s; the Veo models have their own fixed
// durations and are not given a value they do not document.
//
// No resolution control is offered: this endpoint's resolution follows the model and ratio.
// The Video area hides the control when `RESOLUTIONS` is empty.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, downloadMedia, firstUrl, normalisedState,
  pollSchedule, requireSameOrigin, sleep, VIDEO_MAX_BYTES,
} from './media-common.mjs'

export const wire = 'runway_video'
export const credential = 'api_key'
export const modality = 'video'

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16'])
export const RESOLUTIONS = Object.freeze([])
export const RATIO_FOR_ASPECT = Object.freeze({ '16:9': '1280:720', '9:16': '720:1280' })
export const MODELS = Object.freeze(['gen4.5', 'gen4_turbo', 'veo3.1', 'veo3.1_fast'])
export const API_VERSION = '2024-11-06'

const headers = (config) => ({
  authorization: `Bearer ${config.apiKey}`,
  'x-runway-version': API_VERSION,
  accept: 'application/json',
})

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, {
  model, prompt, aspectRatio, signal, onProgress, poll = {}, trustedOrigins = [],
}) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Runway model must be one of ${MODELS.join(', ')}.`, 400)
  if (aspectRatio !== undefined && !ASPECT_RATIOS.includes(aspectRatio)) throw failure('invalid_parameters', `Aspect ratio must be one of ${ASPECT_RATIOS.join(', ')}.`, 400)

  onProgress?.(5, 'submitting')
  const submitted = await transport(config, '/v1/text_to_video', {
    headers: headers(config),
    signal,
    body: {
      model,
      promptText: prompt,
      ...(aspectRatio ? { ratio: RATIO_FOR_ASPECT[aspectRatio] } : {}),
      ...(/^gen4/.test(model) ? { duration: 5 } : {}),
    },
    maxResponseBytes: 2 * 1024 * 1024,
  })
  const taskId = submitted?.id
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(taskId) || taskId.includes('..')) {
    throw failure('invalid_completion', 'Runway returned no usable task id.', 502)
  }
  const taskPath = `/v1/tasks/${encodeURIComponent(taskId)}`

  // Cancellation is a documented DELETE on the same task. It is best-effort because the
  // local abort already stops the product from waiting, and a failed cancel must not turn a
  // deliberate cancellation into an error.
  const onAbort = () => {
    transport({ ...config }, taskPath, { headers: headers(config), method: 'DELETE' }).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const schedule = pollSchedule({
      initialMs: poll.initialMs ?? 5000,
      factor: poll.factor ?? 1.2,
      maxMs: poll.maxMs ?? 10_000,
      attempts: poll.attempts ?? 180,
    })
    for (let attempt = 0; attempt < schedule.attempts; attempt += 1) {
      await sleep(schedule.next(), signal, 'Runway generation was cancelled.')
      const task = await transport(config, taskPath, { headers: headers(config), signal, maxResponseBytes: 2 * 1024 * 1024 })
      const state = normalisedState(task?.status)
      if (state === 'succeeded') {
        const outputs = Array.isArray(task?.output) ? task.output : [task?.output]
        const uri = firstUrl(...outputs)
        if (!uri) throw failure('invalid_completion', 'Runway reported SUCCEEDED without an output URL.', 502)
        onProgress?.(85, 'downloading')
        const file = await downloadMedia(transport, config, uri, {
          signal, kind: 'video', trustedOrigins, maxBytes: VIDEO_MAX_BYTES,
          headersFor: headers,
        })
        return {
          video: file.bytes,
          contentType: file.contentType ?? 'video/mp4',
          model,
          platform: 'Runway',
          aspectRatio: aspectRatio ?? null,
          // The provider did not report a resolution; null is not 720p.
          resolution: null,
          durationSeconds: null,
          usage: null,
          taskId,
        }
      }
      if (['failed', 'cancelled', 'canceled'].includes(state)) {
        const reason = typeof task?.failure === 'string' && task.failure ? `: ${task.failure.slice(0, 300)}` : ''
        throw failure(state === 'failed' ? 'provider_error' : 'cancelled', `Runway task ended ${state}${reason}`, state === 'failed' ? 502 : 499)
      }
      // RUNNING carries a progress fraction in some responses; use it only when it is a
      // finite number. PENDING/THROTTLED carry none.
      const reported = Number(task?.progress)
      onProgress?.(Number.isFinite(reported) ? Math.max(10, Math.min(80, Math.round(reported * 100))) : Math.min(75, 10 + attempt * 2), state)
    }
    throw failure('provider_timeout', 'The Runway task did not finish within the polling budget.', 504)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
