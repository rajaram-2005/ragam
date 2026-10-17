// Gemini image generation: `POST {base}/models/{model}:generateContent`.
//
// Verified against the Gemini API reference (2026-10-17):
//   https://ai.google.dev/gemini-api/docs/image-generation — the request is the ordinary
//   generateContent call with `generationConfig.responseModalities: ["IMAGE"]` (or ["TEXT",
//   "IMAGE"]), and the image arrives as base64 in a part: `candidates[].content.parts[].
//   inlineData.{mimeType,data}`. `imageConfig.aspectRatio` chooses the shape on current image
//   models.
//   https://ai.google.dev/gemini-api/docs/models — image-capable model ids end in `-image`
//   (`gemini-2.5-flash-image` and the newer flash image models). Imagen models use `:predict`
//   with a different body and are deliberately not selected by this wire.
//
// Two choices worth stating:
//   * the size names are the Image product's existing `1024x1024`, `1536x1024`, `1024x1536`, and
//     this wire maps them to aspect ratios. A size that no aspect ratio can express is refused
//     rather than approximated;
//   * only inline bytes are accepted. A returned URL would leave the endpoint the operator
//     configured, which is the same rule the OpenAI Images wire applies.

import { failure } from '../../online/failure.mjs'

export const wire = 'gemini_images'
export const credential = 'api_key'
export const modality = 'image'

const headers = (config) => ({ 'x-goog-api-key': config.apiKey })

/** The three shapes the Image area offers, plus `auto` for the model's own default. */
export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])

/** Size name to aspect ratio. `auto` sends no imageConfig at all. */
export const ASPECT_FOR_SIZE = Object.freeze({
  '1024x1024': '1:1',
  '1536x1024': '4:3',
  '1024x1536': '3:4',
})

const IMAGE_MODEL = /-image(?:-|$)|image-preview|flash-image/

/**
 * Image models from the Gemini model list.
 *
 * The list is the same `GET /models` the chat wire uses; `supportedGenerationMethods` is
 * advisory, so the filter is by id shape and excludes Imagen's `:predict` family explicitly.
 */
export async function models(transport, config) {
  const data = await transport(config, '/models?pageSize=1000', { headers: headers(config) })
  const entries = Array.isArray(data?.models) ? data.models : []
  return entries
    .map((entry) => String(entry?.name ?? '').replace(/^models\//, ''))
    .filter((id) => id && !id.startsWith('imagen') && IMAGE_MODEL.test(id))
}

/**
 * Generate one image and return its bytes. No retry, no URL fetch, no silent model change.
 *
 * The response can be large; the per-call byte cap is raised for this call only, and the decoded
 * image is checked against its own smaller limit before it reaches the job store.
 */
export async function generate(transport, config, { model, prompt, size, signal }) {
  if (typeof model !== 'string' || !model) throw failure('invalid_model', 'Choose an image model.', 400)
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('invalid_prompt', 'A prompt is required.', 400)
  if (prompt.length > 4000) throw failure('invalid_prompt', 'This product caps image prompts at 4,000 characters.', 400)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) throw failure('invalid_prompt', 'The prompt contains control characters.', 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(size && size !== 'auto' ? { imageConfig: { aspectRatio: ASPECT_FOR_SIZE[size] } } : {}),
    },
  }
  const data = await transport(config, `/models/${model}:generateContent`, {
    headers: headers(config), signal, body,
    // Inline base64 inflates the image by roughly a third; 24 MB admits a 16 MB image.
    maxResponseBytes: 24 * 1024 * 1024,
  })

  const parts = Array.isArray(data?.candidates) ? data.candidates.flatMap((candidate) => candidate?.content?.parts ?? []) : []
  const part = parts.find((entry) => typeof entry?.inlineData?.data === 'string' && entry.inlineData.data)
  if (!part) {
    const block = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason ?? null
    throw failure('invalid_completion', block
      ? `The provider returned no image (${block}).`
      : 'The image provider returned no inline image. A returned URL is not fetched.', 502)
  }
  const mimeType = String(part.inlineData.mimeType ?? '').toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw failure('invalid_response', `The provider returned an unsupported image type (${mimeType || 'unknown'}).`, 502)
  }
  const compact = part.inlineData.data.replace(/\s+/g, '')
  const bytes = Buffer.from(compact, 'base64')
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw failure('invalid_response', 'The provider returned data that is not a valid base64 image.', 502)
  }
  if (bytes.length > 20 * 1024 * 1024) throw failure('response_too_large', 'The generated image exceeds 20 MB.', 502)
  return {
    bytes,
    model,
    revisedPrompt: null,
    // Gemini reports token counts, not an image count; carried through as the provider reported it.
    usage: data?.usageMetadata ?? null,
  }
}
