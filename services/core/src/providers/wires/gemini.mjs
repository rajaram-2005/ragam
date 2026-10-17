// Google Gemini generateContent: `POST {base}/models/{model}:generateContent`, `GET {base}/models`.
//
// Verified against the official reference (2026-10-17):
//   https://ai.google.dev/api/generate-content — generateContent and streamGenerateContent, body
//       { contents: [{ role, parts: [{ text }] }], systemInstruction?, generationConfig? }
//   https://ai.google.dev/api/models            — GET /v1beta/models -> { models: [{ name, ... }] }
//   https://ai.google.dev/gemini-api/docs/generate-content/text-generation — `x-goog-api-key`
//       header, and `?alt=sse` for a streamed response
//
// Differences from the OpenAI wire that are not cosmetic:
//   * the model is in the path, not the body;
//   * auth is `x-goog-api-key`, not a bearer token — an API key is not an OAuth access token, and
//     sending it as one would be a credential sent to the wrong mechanism;
//   * the assistant role is `model`, there is no system role (there is `systemInstruction`), and a
//     request has `contents` rather than `messages`;
//   * a successful response has `candidates`, and a prompt can be blocked before any candidate
//     exists — that is a refusal with a reason, not an empty completion;
//   * a stream has no `[DONE]` sentinel and ends when the response body ends.

import { failure } from '../../online/failure.mjs'
import { conversation, requireUserFirst, tokens, unique } from './common.mjs'

export const wire = 'gemini_generate'

const headers = (config) => ({ 'x-goog-api-key': config.apiKey })

/** The model may be saved with or without the `models/` prefix; the path takes it exactly once. */
export const modelId = (model) => String(model ?? '').replace(/^models\//, '')

/** The request body, exported so a contract test can assert it without a network call. */
export function bodyFor({ messages, maxTokens, temperature }) {
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Gemini')
  return {
    contents: turns.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: maxTokens, ...(Number.isFinite(temperature) ? { temperature } : {}) },
  }
}

export async function models(transport, config) {
  const data = await transport(config, '/models', { headers: headers(config) })
  if (!Array.isArray(data?.models) || data.models.length > 500) {
    throw failure('invalid_model_list', 'Gemini must return at most 500 model records.', 502)
  }
  // Only models that declare generateContent are chat models. A model with no declaration at all
  // is kept — the field is optional in the documented shape, and dropping it would hide a model
  // because of a missing field rather than a stated limitation.
  return unique(data.models
    .filter((model) => !Array.isArray(model?.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent'))
    .map((model) => modelId(model?.name)))
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  const id = modelId(model)
  if (!id) throw failure('invalid_model', 'A Gemini model id is required.', 400)
  const path = `/models/${encodeURIComponent(id)}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  const body = bodyFor({ messages, maxTokens, temperature })

  if (!onText) {
    const data = await transport(config, path, { headers: headers(config), signal, body })
    const text = textOf(data)
    if (!text) throw failure('invalid_completion', blockedMessage(data), 502)
    return { text, model: data?.modelVersion ?? null, usage: usageOf(data) }
  }

  let text = ''
  let reported = null
  let usage = null
  let sawCandidate = false
  const onFrame = (frame) => {
    if (frame?.modelVersion) reported = frame.modelVersion
    if (frame?.usageMetadata) usage = usageOf(frame)
    if (Array.isArray(frame?.candidates) && frame.candidates.length) sawCandidate = true
    const delta = textOf(frame)
    if (delta) { text += delta; onText(delta) }
  }
  await transport(config, path, { headers: headers(config), signal, body, onFrame, doneOnEnd: true })
  if (!sawCandidate) throw failure('invalid_completion', 'Gemini returned no candidate. No model was substituted.', 502)
  return { text, model: reported, usage }
}

function textOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('')
}

function usageOf(data) {
  const meta = data?.usageMetadata
  return tokens(meta?.promptTokenCount, meta?.candidatesTokenCount)
}

/** A blocked prompt is a refusal with a published reason code, and only that code is echoed. */
function blockedMessage(data) {
  const reason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason
  const safe = typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? ` (${reason})` : ''
  return `Gemini returned no text${safe}. No model was substituted.`
}
