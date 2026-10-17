// Replicate-hosted image models.
//
// Verified against the official documentation on 2026-10-17:
//   https://replicate.com/docs/reference/http (prediction contract, see replicate-predictions.mjs)
//   https://replicate.com/black-forest-labs/flux-1.1-pro — official model, `prompt` input.
//   https://replicate.com/black-forest-labs/flux-schnell — official model, `prompt` input.
//   https://replicate.com/stability-ai/stable-diffusion-3.5-large — official model.
//
// No size field is offered here. These models document different, model-specific geometry
// inputs (`aspect_ratio`, `width`/`height`, `megapixels`, …); sending one set to all of them
// would be a guess that fails on half the models. The Image area hides the size control when
// `SIZES` is empty, and the prompt alone is the documented required input.

import { failure } from '../../online/failure.mjs'
import { assertPrompt, IMAGE_MAX_BYTES } from './media-common.mjs'
import { downloadOutput, outputUrl, runPrediction } from './replicate-predictions.mjs'

export const wire = 'replicate_images'
export const credential = 'api_key'
export const modality = 'image'

/** Empty on purpose: no common size input exists across these models. */
export const SIZES = Object.freeze([])
export const MODELS = Object.freeze([
  'black-forest-labs/flux-1.1-pro',
  'black-forest-labs/flux-schnell',
  'stability-ai/stable-diffusion-3.5-large',
])

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, signal, onProgress, poll = {}, trustedOrigins = [] }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Replicate image model must be one of ${MODELS.join(', ')}.`, 400)

  const prediction = await runPrediction(transport, config, {
    model, input: { prompt }, signal, onProgress, poll,
  })
  const uri = outputUrl(prediction?.output)
  if (!uri) throw failure('invalid_completion', 'Replicate returned no image URL.', 502)
  const file = await downloadOutput(transport, config, uri, {
    signal, kind: 'image', trustedOrigins, maxBytes: IMAGE_MAX_BYTES,
  })
  return {
    bytes: file.bytes,
    // The prediction names the exact model version that ran; carry it rather than the alias.
    model: typeof prediction?.model === 'string' ? prediction.model : model,
    revisedPrompt: null,
    contentType: file.contentType,
    usage: null,
  }
}
