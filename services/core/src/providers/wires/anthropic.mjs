// Anthropic Messages: `POST {base}/messages`, `GET {base}/models`.
//
// Verified against the official reference (2026-10-17):
//   https://docs.anthropic.com/en/api/messages          — POST /v1/messages, `x-api-key`,
//       `anthropic-version: 2023-06-01`, body { model, max_tokens, messages, system?, stream? }
//   https://docs.anthropic.com/en/api/models-list       — GET /v1/models -> { data: [{ id, ... }] }
//   https://docs.anthropic.com/en/api/messages-streaming — SSE events message_start,
//       content_block_delta (`delta.type: "text_delta"`), message_delta, message_stop
//
// Differences from the OpenAI wire that are not cosmetic, and are therefore explicit here:
//   * auth is the `x-api-key` header, not `Authorization: Bearer`;
//   * every request needs `anthropic-version`;
//   * `system` is a top-level string, not a message role, and `messages` must start with `user`;
//   * a successful response is a list of content blocks, and only `text` blocks are text;
//   * streaming has no `[DONE]` sentinel — `message_stop` is the completion signal.

import { failure } from '../../online/failure.mjs'
import { conversation, requireUserFirst, tokens, idsFromData } from './common.mjs'

export const wire = 'anthropic_messages'
export const ANTHROPIC_VERSION = '2023-06-01'

const headers = (config) => ({ 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION })

/** The request body, exported so a contract test can assert it without a network call. */
export function bodyFor({ model, messages, maxTokens, temperature, stream = false }) {
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Anthropic')
  return {
    model,
    max_tokens: maxTokens,
    messages: turns,
    ...(system ? { system } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(stream ? { stream: true } : {}),
  }
}

export async function models(transport, config) {
  return idsFromData(await transport(config, '/models', { headers: headers(config) }))
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  if (!onText) {
    const data = await transport(config, '/messages', {
      headers: headers(config), signal,
      body: bodyFor({ model, messages, maxTokens, temperature }),
    })
    const text = textOf(data?.content)
    if (!text) throw failure('invalid_completion', 'Anthropic returned no text block. Tool execution is not automatic.', 502)
    return { text, model: data?.model ?? null, usage: tokens(data?.usage?.input_tokens, data?.usage?.output_tokens) }
  }

  // Streaming. `message_stop` is the completion signal; an HTTP body that simply ends is not,
  // because a truncated response would otherwise be indistinguishable from a finished one.
  let text = ''
  let reported = null
  let promptTokens = null
  let completionTokens = null
  let stopped = false
  const onFrame = (event) => {
    if (event.type === 'message_start') {
      reported = event.message?.model ?? reported
      promptTokens = event.message?.usage?.input_tokens ?? promptTokens
      completionTokens = event.message?.usage?.output_tokens ?? completionTokens
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (typeof delta?.text === 'string' && (delta.type === undefined || delta.type === 'text_delta')) {
        text += delta.text
        onText(delta.text)
      }
    } else if (event.type === 'message_delta') {
      completionTokens = event.usage?.output_tokens ?? completionTokens
    } else if (event.type === 'message_stop') {
      stopped = true
    }
  }
  await transport(config, '/messages', {
    headers: headers(config), signal, onFrame, doneOnEnd: true,
    body: bodyFor({ model, messages, maxTokens, temperature, stream: true }),
  })
  if (!stopped) throw failure('provider_interrupted', 'Anthropic stream ended without message_stop.', 502)
  return { text, model: reported, usage: tokens(promptTokens, completionTokens) }
}

/** Text content blocks only: a response of `tool_use` or `thinking` blocks is not a completion. */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
