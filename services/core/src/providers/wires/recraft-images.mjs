// Recraft: `POST {base}/images/generations`.
//
// Verified against the official documentation on 2026-10-17:
//   https://www.recraft.ai/docs/api-reference/endpoints — `Authorization: Bearer <token>`;
//     JSON body with `prompt`, `model`, `size` (`WxH`), `n`, and
//     `response_format` = `url` | `b64_json` | `multipart`;
//     `image_format` = `webp` (default) | `png`.
//   https://www.recraft.ai/docs/api-reference/models/overview — the current model ids are
//     `recraftv4_1`, `recraftv4_1_pro`, `recraftv4`, and the V3/V4 vector variants.
//
// This adapter asks for `b64_json` on purpose. The default is a download URL, and a URL
// would mean a second request to a host this build did not configure. Inline bytes keep the
// credential on exactly one origin.
//
// Model discovery: the API has a style list and a user endpoint, but no model-list endpoint.
// The ids below are from the published model overview; `models()` returns them as curated.

import { failure } from '../../online/failure.mjs'
import { assertPrompt, decodeBase64, IMAGE_MAX_BYTES } from './media-common.mjs'

export const wire = 'recraft_images'
export const credential = 'api_key'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const MODELS = Object.freeze(['recraftv4_1', 'recraftv4_1_pro', 'recraftv4', 'recraftv3'])

const headers = (config) => ({ authorization: `Bearer ${config.apiKey}` })

export async function models() {
  return [...MODELS]
}

export async function generate(transport, config, { model, prompt, size, signal }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Recraft image model must be one of ${MODELS.join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const data = await transport(config, '/images/generations', {
    headers: headers(config),
    signal,
    body: {
      prompt,
      model,
      n: 1,
      // Both fields are documented. `b64_json` is what keeps the credential from travelling
      // to a delivery host; `png` is the container this product's validator expects.
      response_format: 'b64_json',
      image_format: 'png',
      ...(size && size !== 'auto' ? { size } : {}),
    },
    maxResponseBytes: IMAGE_MAX_BYTES,
  })

  const entry = Array.isArray(data?.data) ? data.data[0] : null
  if (!entry?.b64_json) {
    throw failure('invalid_completion', 'Recraft returned no inline image. A returned URL is not fetched by this adapter.', 502)
  }
  const bytes = decodeBase64(entry.b64_json, { maxBytes: IMAGE_MAX_BYTES, label: 'image' })
  return {
    bytes,
    model: typeof data?.model === 'string' ? data.model : model,
    revisedPrompt: null,
    usage: data?.credits ?? null,
  }
}
