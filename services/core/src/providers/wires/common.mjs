// Helpers shared by the three wire adapters.
//
// Each provider's API represents a conversation differently. This module translates the small
// internal Chat content vocabulary into vendor request shapes; it never performs network work.

import { failure } from '../../online/failure.mjs'

/** Split system turns out of the message list and merge adjacent turns without flattening media. */
export function conversation(messages) {
  const system = []
  const turns = []
  for (const message of messages ?? []) {
    if (message.role === 'system') system.push(message.content)
    else turns.push({ role: message.role, content: message.content })
  }
  return { system: system.length ? system.join('\n\n') : null, turns: merged(turns) }
}

function merged(turns) {
  const out = []
  for (const turn of turns) {
    const last = out.at(-1)
    if (!last || last.role !== turn.role) { out.push({ ...turn }); continue }
    if (Array.isArray(last.content) || Array.isArray(turn.content)) {
      const toParts = (content) => Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
      last.content = [...toParts(last.content), ...toParts(turn.content)]
    } else last.content = `${last.content}\n\n${turn.content}`
  }
  return out
}

/**
 * Anthropic and Gemini both require a conversation to begin with the user. The product's own
 * contract already requires the last message to be from the user; a list that begins with the
 * assistant is refused rather than reordered.
 */
export function requireUserFirst(turns, label) {
  if (turns.length && turns[0].role !== 'user') {
    throw failure('invalid_messages', `${label} requires a conversation that starts with a user message.`, 400)
  }
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const GEMINI_MEDIA_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac', 'audio/webm', 'video/mp4', 'video/webm'])
function validInline(part, allowed) {
  if (!part || typeof part !== 'object' || typeof part.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data) || !allowed.has(part.mimeType)) {
    throw failure('invalid_messages', 'The attached media is malformed or has an unsupported media type.', 400)
  }
  return part
}

/** OpenAI Chat Completions content-part form, including in OpenAI-compatible wires. */
export function openAIContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw failure('invalid_messages', 'Message content must be text or supported media parts.', 400)
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part?.type === 'image') {
      const image = validInline(part, IMAGE_MIMES)
      return { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } }
    }
    throw failure('capability_unavailable', `This provider wire cannot send ${String(part?.type ?? 'unknown')} media in Chat.`, 409)
  })
}
export function openAIMessages(messages) {
  return (messages ?? []).map((message) => ({ ...message, content: openAIContent(message.content) }))
}

/** Anthropic Messages image block form. */
export function anthropicContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw failure('invalid_messages', 'Message content must be text or supported media parts.', 400)
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part?.type === 'image') {
      const image = validInline(part, IMAGE_MIMES)
      return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }
    }
    throw failure('capability_unavailable', `Anthropic Chat does not accept ${String(part?.type ?? 'unknown')} attachments on this wire.`, 409)
  })
}

/** Gemini generateContent `parts` supports inline image, audio and short video bytes. */
export function geminiParts(content) {
  if (typeof content === 'string') return [{ text: content }]
  if (!Array.isArray(content)) throw failure('invalid_messages', 'Message content must be text or supported media parts.', 400)
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { text: part.text }
    if (['image', 'audio', 'video'].includes(part?.type)) {
      const media = validInline(part, GEMINI_MEDIA_MIMES)
      return { inline_data: { mime_type: media.mimeType, data: media.data } }
    }
    throw failure('capability_unavailable', `Gemini Chat does not accept ${String(part?.type ?? 'unknown')} attachments.`, 409)
  })
}

/** Parse a provider function-call proposal without executing it. */
export function openAIToolCalls(calls = []) {
  if (!Array.isArray(calls)) return []
  return calls.map((call, index) => {
    const name = call?.function?.name
    const raw = call?.function?.arguments
    if (typeof name !== 'string' || typeof raw !== 'string') throw failure('invalid_tool_proposal', 'The provider returned a malformed function proposal.', 502)
    let args
    try { args = JSON.parse(raw) } catch { throw failure('invalid_tool_proposal', 'The provider returned invalid JSON for a function proposal.', 502) }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('invalid_tool_proposal', 'Function proposal arguments must be a JSON object.', 502)
    return { proposalId: String(call.id ?? `openai-${index}`).slice(0, 128), name, arguments: args }
  })
}

/** Accumulate OpenAI-compatible SSE fragments; each call remains a proposal, never an action. */
export function appendOpenAIToolDeltas(calls, fragments = []) {
  if (!Array.isArray(fragments)) return
  for (const fragment of fragments) {
    const key = String(fragment?.index ?? calls.size)
    const previous = calls.get(key) ?? { proposalId: '', name: '', argumentsJson: '' }
    calls.set(key, {
      proposalId: fragment?.id ?? previous.proposalId,
      name: previous.name + (fragment?.function?.name ?? ''),
      argumentsJson: previous.argumentsJson + (fragment?.function?.arguments ?? ''),
    })
  }
}

export function finishOpenAIToolDeltas(calls) {
  return [...calls.values()].map((call, index) => openAIToolCalls([{ id: call.proposalId || `openai-${index}`, function: { name: call.name, arguments: call.argumentsJson } }])[0])
}

/** A token count is reported only when the provider actually reported it. */
export function tokens(prompt, completion) {
  const has = Number.isInteger(prompt) || Number.isInteger(completion)
  if (!has) return null
  const p = Number.isInteger(prompt) ? prompt : null
  const c = Number.isInteger(completion) ? completion : null
  return { prompt_tokens: p, completion_tokens: c, total_tokens: (p ?? 0) + (c ?? 0) }
}

/** Model ids from an OpenAI-shaped list (`{ data: [{ id }] }`), bounded and sanitised. */
export function idsFromData(data) {
  if (!Array.isArray(data?.data) || data.data.length > 500) {
    throw failure('invalid_model_list', 'The provider must return at most 500 model records.', 502)
  }
  return unique(data.data.map((entry) => entry?.id))
}

export function unique(values) {
  return [...new Set(values.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && !/[\x00-\x1f\x7f]/.test(id)))].sort()
}
