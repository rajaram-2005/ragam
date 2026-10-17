// Stability AI: `POST {base}/v2beta/stable-image/generate/{core|ultra|sd3}`.
//
// Verified against the official documentation on 2026-10-17:
//   https://platform.stability.ai/docs/api-reference#tag/Generate/paths/~1v2beta~1stable-image~1generate~1core/post
//   https://platform.stability.ai/docs/api-reference — authentication is
//     `Authorization: Bearer <key>`; the request body is `multipart/form-data`; the
//     response is the image itself when `Accept: image/*` is sent (`image/png` and
//     `image/jpeg` are the documented examples, and `Finish-Reason` reports
//     `SUCCESS`/`CONTENT_FILTERED`/`ERROR` in a header).
//   Stability's own knowledge base confirms the Core and Ultra endpoints and the
//     `prompt` + `output_format` + `aspect_ratio` fields.
//
// Why this wire returns bytes directly instead of JSON: Stability's documented contract has
// no required JSON envelope. Asking for `application/json` and parsing a second shape that
// some deployments do not return would add a branch for no gain. The bytes go to the same
// container validator every other image takes.
//
// Model discovery: Stability has no public model-list endpoint on v2beta. The identifiers
// below are the documented generation endpoints, not an invented catalogue; `models()`
// returns them as a curated list and the UI labels the list as curated.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, inlineImageBytes, multipartBody, sniffImage, IMAGE_MAX_BYTES,
} from './media-common.mjs'

export const wire = 'stability_images'
export const credential = 'api_key'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const ASPECT_FOR_SIZE = Object.freeze({ '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' })

/** Documented v2beta generation endpoints. `sd3` takes the concrete model in the form body. */
export const MODELS = Object.freeze([
  Object.freeze({ id: 'core', endpoint: '/v2beta/stable-image/generate/core', label: 'Stable Image Core' }),
  Object.freeze({ id: 'ultra', endpoint: '/v2beta/stable-image/generate/ultra', label: 'Stable Image Ultra' }),
  Object.freeze({ id: 'sd3.5-large', endpoint: '/v2beta/stable-image/generate/sd3', formModel: 'sd3.5-large', label: 'SD 3.5 Large' }),
  Object.freeze({ id: 'sd3.5-medium', endpoint: '/v2beta/stable-image/generate/sd3', formModel: 'sd3.5-medium', label: 'SD 3.5 Medium' }),
])

const headers = (config) => ({ authorization: `Bearer ${config.apiKey}`, accept: 'image/*' })

export async function models() {
  // Curated, not discovered. The provider offers no list endpoint, and naming an endpoint
  // the operator can call is more useful than refusing with `not_implemented`.
  return MODELS.map((model) => model.id)
}


export async function generate(transport, config, { model, prompt, size, signal }) {
  assertPrompt(prompt)
  const entry = MODELS.find((candidate) => candidate.id === model)
  if (!entry) throw failure('invalid_model', `Stability image model must be one of ${MODELS.map((m) => m.id).join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const form = multipartBody({
    prompt,
    output_format: 'png',
    ...(entry.formModel ? { model: entry.formModel } : {}),
    ...(size && size !== 'auto' ? { aspect_ratio: ASPECT_FOR_SIZE[size] } : {}),
  })
  const response = await transport(config, entry.endpoint, {
    headers: headers(config),
    body: form.body,
    contentType: form.contentType,
    signal,
    binary: true,
    maxResponseBytes: IMAGE_MAX_BYTES,
  })
  let bytes = response?.bytes
  if (!bytes?.length) throw failure('invalid_completion', 'Stability returned no image bytes.', 502)
  // `Accept: image/*` is the documented binary path. Stability also documents a JSON envelope
  // carrying `image: <base64>`; a deployment or compatibility layer that returns it is decoded
  // rather than stored as a corrupt PNG.
  if (!sniffImage(bytes)) {
    try { bytes = inlineImageBytes(JSON.parse(bytes.toString('utf8')), { maxBytes: IMAGE_MAX_BYTES }) ?? bytes } catch { /* not JSON; the container check below refuses it */ }
  }
  if (!sniffImage(bytes)) throw failure('invalid_response', 'Stability returned bytes that are not a supported image container.', 502)
  if (bytes.length > IMAGE_MAX_BYTES) throw failure('response_too_large', 'The generated image exceeds 24 MB.', 502)
  return {
    bytes,
    model,
    revisedPrompt: null,
    contentType: response.contentType ?? 'image/png',
    usage: null,
  }
}
