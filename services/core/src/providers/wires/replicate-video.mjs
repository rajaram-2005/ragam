// Replicate-hosted video models.
//
// Verified against the official documentation on 2026-10-17:
//   https://replicate.com/docs/reference/http (prediction contract, see replicate-predictions.mjs)
//   https://replicate.com/google/veo-3 — official model, `prompt` input, video output URL.
//   https://replicate.com/minimax/video-01 — official model, `prompt` input.
//
// As with the image wire, no common aspect-ratio or resolution input exists across these
// models. The Video area hides those controls when the lists are empty; the documented
// required input (`prompt`) is sent and the provider's own defaults decide the geometry.

import { failure } from '../../online/failure.mjs'
import { assertPrompt, VIDEO_MAX_BYTES } from './media-common.mjs'
import { downloadOutput, outputUrl, runPrediction } from './replicate-predictions.mjs'

export const wire = 'replicate_video'
export const credential = 'api_key'
export const modality = 'video'

export const ASPECT_RATIOS = Object.freeze([])
export const RESOLUTIONS = Object.freeze([])
export const MODELS = Object.freeze([
  'google/veo-3',
  'google/veo-3-fast',
  'minimax/video-01',
])

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, signal, onProgress, poll = {}, trustedOrigins = [] }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Replicate video model must be one of ${MODELS.join(', ')}.`, 400)

  const prediction = await runPrediction(transport, config, {
    model, input: { prompt }, signal, onProgress, poll,
  })
  const uri = outputUrl(prediction?.output)
  if (!uri) throw failure('invalid_completion', 'Replicate returned no video URL.', 502)
  const file = await downloadOutput(transport, config, uri, {
    signal, kind: 'video', trustedOrigins, maxBytes: VIDEO_MAX_BYTES,
  })
  return {
    video: file.bytes,
    contentType: file.contentType ?? 'video/mp4',
    model: typeof prediction?.model === 'string' ? prediction.model : model,
    platform: 'Replicate',
    aspectRatio: null,
    resolution: null,
    durationSeconds: null,
    usage: null,
  }
}
