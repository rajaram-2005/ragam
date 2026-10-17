// OpenAI Images: `POST {base}/images/generations`, `GET {base}/models`.
//
// Verified against the official reference (2026-10-17):
//   https://developers.openai.com/api/reference/resources/images/methods/generate — the request
//     body names the model, prompt, n and size; GPT image models return `data[].b64_json` by
//     default, while `response_format` is only accepted by models that support it.
//   https://developers.openai.com/api/reference/resources/images — `b64_json` is "returned by
//     default for GPT image models", and DALL·E 2/3 were retired on 2026-05-12.
//
// Why this is a wire and not the chat adapter with a different path: the response is not a
// conversation, the completion is bytes rather than text, and a URL response is deliberately not
// fetched. Following a provider-supplied URL would leave the endpoint the operator configured and
// make an untrusted string the destination of a request; this adapter only accepts inline bytes.

import { failure } from '../../online/failure.mjs'
import { idsFromData } from './common.mjs'

export const wire = 'openai_images'
export const credential = 'api_key'
export const modality = 'image'

const headers = (config) => ({ authorization: `Bearer ${config.apiKey}` })

/** Sizes the current GPT image models document. `auto` is a documented choice, not a guess. */
export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])

const IMAGE_MODEL = /^(gpt-image|chatgpt-image|dall-e)/

/** Image models from the OpenAI-shaped `/models` list. Other model kinds are not image models. */
export async function models(transport, config) {
  const data = await transport(config, '/models', { headers: headers(config) })
  return idsFromData(data).filter((id) => IMAGE_MODEL.test(id))
}

/**
 * Generate one image. Returns raw bytes and provenance; the caller validates the container and
 * stores the artifact. No retry is performed here: a failed generation is reported, not repeated
 * with a different prompt or model.
 */
export async function generate(transport, config, { model, prompt, size, signal }) {
  if (typeof model !== 'string' || !model) throw failure('invalid_model', 'Choose an image model.', 400)
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('invalid_prompt', 'A prompt is required.', 400)
  if (prompt.length > 4000) throw failure('invalid_prompt', 'This product caps image prompts at 4,000 characters.', 400)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) throw failure('invalid_prompt', 'The prompt contains control characters.', 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const body = {
    model,
    prompt,
    n: 1,
    ...(size ? { size } : {}),
    // GPT image models return base64 by default and reject this parameter; older compatible
    // endpoints need it to avoid a URL, which this adapter will not fetch.
    ...(IMAGE_MODEL.test(model) && !/^(gpt-image|chatgpt-image)/.test(model) ? { response_format: 'b64_json' } : {}),
  }
  const data = await transport(config, '/images/generations', {
    headers: headers(config), signal, body,
    // An image is larger than a chat completion by orders of magnitude; the gateway's default cap
    // is for text. The per-call cap is still bounded and the decoded bytes are checked again below.
    maxResponseBytes: 24 * 1024 * 1024,
  })

  const entry = Array.isArray(data?.data) ? data.data[0] : null
  const encoded = entry?.b64_json
  if (typeof encoded !== 'string' || !encoded) {
    throw failure('invalid_completion', 'The image provider returned no inline image. A returned URL is not fetched.', 502)
  }
  const compact = encoded.replace(/\s+/g, '')
  const bytes = Buffer.from(compact, 'base64')
  // Buffer.from is permissive: it drops characters it does not recognise. Re-encoding catches a
  // response that was not base64 at all instead of storing whatever the decode produced.
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw failure('invalid_response', 'The provider returned data that is not a valid base64 image.', 502)
  }
  if (bytes.length > 20 * 1024 * 1024) throw failure('response_too_large', 'The generated image exceeds 20 MB.', 502)
  return {
    bytes,
    model: typeof data?.model === 'string' ? data.model : model,
    revisedPrompt: typeof entry?.revised_prompt === 'string' ? entry.revised_prompt : null,
    usage: data?.usage ?? null,
  }
}
