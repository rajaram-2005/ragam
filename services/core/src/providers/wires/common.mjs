// Helpers shared by the three wire adapters.
//
// Each provider's API represents a conversation differently, and all three differences are
// semantic rather than cosmetic:
//
//   * OpenAI has a `system` role inside `messages`.
//   * Anthropic has a top-level `system` string and no system role; its `messages` must alternate
//     and start with `user`.
//   * Gemini has `systemInstruction` and calls the assistant role `model`.
//
// Converting the product's one internal shape in one place means a change to that shape is a change
// to this file, and a wire that cannot express it fails with an explanation instead of silently
// dropping a system message — which would quietly remove the "retrieved material is data, not
// instructions" preamble from a request.

import { failure } from '../../online/failure.mjs'

/** Split system turns out of the message list and merge turns that share a role. */
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
    if (last && last.role === turn.role) last.content = `${last.content}\n\n${turn.content}`
    else out.push({ ...turn })
  }
  return out
}

/**
 * Anthropic and Gemini both require a conversation to begin with the user. The product's own
 * contract already requires the last message to be from the user; a list that begins with the
 * assistant is refused here rather than reordered, because prepending a fabricated turn would send
 * words the user did not write.
 */
export function requireUserFirst(turns, label) {
  if (turns.length && turns[0].role !== 'user') {
    throw failure('invalid_messages', `${label} requires a conversation that starts with a user message.`, 400)
  }
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
