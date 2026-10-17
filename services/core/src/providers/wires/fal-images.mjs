// fal.ai image generation through the Queue API.
//
// Verified against the official documentation on 2026-10-17:
//   https://docs.fal.ai/model-apis/model-endpoints/queue (queue protocol, see fal-queue.mjs)
//   https://fal.ai/models/fal-ai/flux/schnell/api — `prompt` is the required input; the
//     response shape for FLUX image models is `{ images: [{ url, width, height, ... }] }`.
//   https://fal.ai/models/fal-ai/flux/dev/api — same output shape.
//   https://fal.ai/models/fal-ai/nano-banana-2 — current image model, prompt input.
//
// `image_size` is a fal preset string (`square_hd`, `landscape_4_3`, `portrait_4_3`); it is
// sent only when the user chose an explicit size. Model-specific input schemas differ, so a
// model that rejects a preset fails the job with the provider's error rather than being
// retried with invented parameters.

import { failure } from '../../online/failure.mjs'
import { assertPrompt, downloadMedia, firstUrl, IMAGE_MAX_BYTES } from './media-common.mjs'
import { runQueue } from './fal-queue.mjs'

export const wire = 'fal_images'
export const credential = 'api_key'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const PRESET_FOR_SIZE = Object.freeze({
  '1024x1024': 'square_hd',
  '1536x1024': 'landscape_4_3',
  '1024x1536': 'portrait_4_3',
})
export const MODELS = Object.freeze([
  'fal-ai/nano-banana-2',
  'fal-ai/flux-pro/v1.1',
  'fal-ai/flux/dev',
  'fal-ai/flux/schnell',
])

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, size, signal, onProgress, poll = {}, trustedOrigins = [] }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `fal image model must be one of ${MODELS.join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const { result } = await runQueue(transport, config, {
    model,
    input: {
      prompt,
      ...(size && size !== 'auto' ? { image_size: PRESET_FOR_SIZE[size] } : {}),
      num_images: 1,
    },
    signal,
    onProgress,
    poll,
    trustedOrigins,
  })
  const entry = Array.isArray(result?.images) ? result.images[0] : null
  const uri = firstUrl(entry?.url, result?.image?.url, result?.url)
  if (!uri) throw failure('invalid_completion', 'fal returned no image URL.', 502)
  const file = await downloadMedia(transport, config, uri, {
    signal, kind: 'image', trustedOrigins, maxBytes: IMAGE_MAX_BYTES,
  })
  return {
    bytes: file.bytes,
    model,
    revisedPrompt: typeof result?.revised_prompt === 'string' ? result.revised_prompt : null,
    contentType: file.contentType,
    usage: null,
  }
}
