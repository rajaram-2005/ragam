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
import { conversation, geminiParts, requireUserFirst, tokens, unique } from './common.mjs'

export const wire = 'gemini_generate'
export const defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta'
export const chatInputKinds = Object.freeze(['image', 'audio', 'video'])
export const chatNativeSearch = true
export const chatTools = true

const headers = (config) => ({ 'x-goog-api-key': config.apiKey })

/** The model may be saved with or without the `models/` prefix; the path takes it exactly once. */
export const modelId = (model) => String(model ?? '').replace(/^models\//, '')

/** The request body, exported so a contract test can assert it without a network call. */
export function bodyFor({ messages, maxTokens, temperature, tools = [], nativeSearch = false }) {
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Gemini')
  return {
    contents: turns.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: geminiParts(turn.content) })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: maxTokens, ...(Number.isFinite(temperature) ? { temperature } : {}) },
    ...((nativeSearch || tools.length) ? { tools: [
      ...(nativeSearch ? [{ google_search: {} }] : []),
      ...(tools.length ? [{ function_declarations: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) }] : []),
    ] } : {}),
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

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText, maxRequestBytes, tools = [], nativeSearch = false }) {
  const id = modelId(model)
  if (!id) throw failure('invalid_model', 'A Gemini model id is required.', 400)
  const path = `/models/${encodeURIComponent(id)}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  const body = bodyFor({ messages, maxTokens, temperature, tools, nativeSearch })

  if (!onText) {
    const data = await transport(config, path, { headers: headers(config), signal, body, maxRequestBytes })
    const text = textOf(data)
    const toolCalls = toolCallsOf(data)
    if (!text && !toolCalls.length) throw failure('invalid_completion', blockedMessage(data), 502)
    return { text, model: data?.modelVersion ?? null, usage: usageOf(data), toolCalls, grounding: groundingOf(data) }
  }

  let text = ''
  let reported = null
  let usage = null
  let grounding = null
  const toolCalls = new Map()
  let sawCandidate = false
  let finished = false
  const onFrame = (frame) => {
    if (frame?.modelVersion) reported = frame.modelVersion
    if (frame?.usageMetadata) usage = usageOf(frame)
    if (Array.isArray(frame?.candidates) && frame.candidates.length) sawCandidate = true
    if (frame?.candidates?.[0]?.finishReason) finished = true
    grounding = groundingOf(frame) ?? grounding
    for (const call of toolCallsOf(frame)) {
      const key = call.proposalId ?? call.name
      const previous = toolCalls.get(key)
      toolCalls.set(key, previous ? { ...previous, arguments: { ...previous.arguments, ...call.arguments } } : call)
    }
    const delta = textOf(frame)
    if (delta) { text += delta; onText(delta) }
  }
  await transport(config, path, { headers: headers(config), signal, body, onFrame, doneOnEnd: true, maxRequestBytes })
  if (!sawCandidate) throw failure('invalid_completion', 'Gemini returned no candidate. No model was substituted.', 502)
  if (!finished) throw failure('provider_interrupted', 'Gemini stream ended without a finish reason.', 502)
  if (!text && !toolCalls.size) throw failure('invalid_completion', 'Gemini returned neither text nor a tool proposal.', 502)
  return { text, model: reported, usage, toolCalls: [...toolCalls.values()], grounding }
}

export function toolCallsOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return []
  return parts.flatMap((part, index) => {
    const call = part?.functionCall
    if (typeof call?.name !== 'string' || !call.name) return []
    const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {}
    return [{ name: call.name, arguments: args, proposalId: `gemini-${index}` }]
  })
}

export function groundingOf(data) {
  const metadata = data?.candidates?.[0]?.groundingMetadata
  if (!metadata || typeof metadata !== 'object') return null
  const sources = (metadata.groundingChunks ?? []).flatMap((chunk) => {
    const web = chunk?.web
    if (typeof web?.uri !== 'string' || !/^https?:\/\//i.test(web.uri)) return []
    return [{ title: typeof web.title === 'string' ? web.title.slice(0, 500) : '', url: web.uri }]
  })
  const queries = (metadata.webSearchQueries ?? []).filter((query) => typeof query === 'string').slice(0, 10)
  return { sources: sources.slice(0, 30), queries }
}

export function textOf(data) {
  const parts = data?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ''
  return parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('')
}

export function usageOf(data) {
  const meta = data?.usageMetadata
  return tokens(meta?.promptTokenCount, meta?.candidatesTokenCount)
}

/** A blocked prompt is a refusal with a published reason code, and only that code is echoed. */
export function blockedMessage(data) {
  const reason = data?.promptFeedback?.blockReason ?? data?.candidates?.[0]?.finishReason
  const safe = typeof reason === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(reason) ? ` (${reason})` : ''
  return `Gemini returned no text${safe}. No model was substituted.`
}
