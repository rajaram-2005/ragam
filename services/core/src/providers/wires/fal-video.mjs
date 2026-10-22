// fal.ai video generation through the Queue API.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.fal.ai/model-apis/model-endpoints/queue (queue protocol, see fal-queue.mjs)
//   https://fal.ai/models/fal-ai/veo3/api — `prompt`, `aspect_ratio` (`16:9`/`9:16`) and
//     `resolution` (`720p`/`1080p`) inputs; result is `{ video: { url, ... } }`.
//   https://fal.ai/models/fal-ai/kling-video/v2/master/text-to-video — `prompt`,
//     `duration`, `aspect_ratio`; result is `{ video: { url } }`.
//
// Model inputs are not interchangeable. This adapter sends the small intersection that the
// documented video models accept (`prompt`, plus `aspect_ratio` and `resolution` when the
// user chose them), and a model that rejects an option fails the job with the provider's
// reason rather than being retried with a guess.

import { failure } from '../../online/failure.mjs'
import { assertPrompt, firstUrl, VIDEO_MAX_BYTES } from './media-common.mjs'
import { fetchArtifact, runQueue } from './fal-queue.mjs'

export const wire = 'fal_video'
export const credential = 'api_key'
export const modality = 'video'

export const ASPECT_RATIOS = Object.freeze(['16:9', '9:16'])
export const RESOLUTIONS = Object.freeze(['720p', '1080p'])
export const MODELS = Object.freeze([
  'fal-ai/veo3.1',
  'fal-ai/veo3',
  'fal-ai/kling-video/v2/master/text-to-video',
])

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, {
  model, prompt, aspectRatio, resolution, signal, onProgress, poll = {}, trustedOrigins = [],
}) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `fal video model must be one of ${MODELS.join(', ')}.`, 400)
  if (aspectRatio !== undefined && !ASPECT_RATIOS.includes(aspectRatio)) throw failure('invalid_parameters', `Aspect ratio must be one of ${ASPECT_RATIOS.join(', ')}.`, 400)
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) throw failure('invalid_parameters', `Resolution must be one of ${RESOLUTIONS.join(', ')}.`, 400)

  const { result } = await runQueue(transport, config, {
    model,
    input: {
      prompt,
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(resolution ? { resolution } : {}),
    },
    signal,
    onProgress,
    poll,
    trustedOrigins,
  })
  const uri = firstUrl(result?.video?.url, result?.video_url, result?.output?.url, typeof result?.video === 'string' ? result.video : null)
  if (!uri) throw failure('invalid_completion', 'fal returned no video URL.', 502)
  const file = await fetchArtifact(transport, config, uri, {
    signal, kind: 'video', trustedOrigins, maxBytes: VIDEO_MAX_BYTES,
  })
  return {
    video: file.bytes,
    contentType: file.contentType ?? 'video/mp4',
    model,
    platform: 'fal.ai',
    aspectRatio: aspectRatio ?? null,
    resolution: resolution ?? null,
    durationSeconds: Number.isFinite(result?.duration) ? result.duration : null,
    usage: null,
  }
}
