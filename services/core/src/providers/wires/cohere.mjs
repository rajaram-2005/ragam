// Cohere Chat (v2): `POST {base}/v2/chat`, `GET {base}/v1/models`.
//
// Verified against the official reference (2026-10-17):
//   https://docs.cohere.com/reference/chat        — POST /v2/chat, `Authorization: Bearer`,
//       body { model, messages, max_tokens, temperature, stream }
//   https://docs.cohere.com/reference/chat-stream — typed SSE events: message-start,
//       content-delta (`delta.message.content.text`), content-end, message-end
//   https://docs.cohere.com/docs/models           — GET /v1/models, paginated with
//       `page_size` / `page_token` and a `next_page_token` in the response
//
// Differences from the OpenAI wire that are not cosmetic:
//   * the chat and model-list endpoints live under different version prefixes (`/v2` and `/v1`),
//     so the saved base URL is the API host, not a `/v1` base;
//   * a response carries `message.content[]` blocks and `usage.tokens`, not `choices`/`usage`;
//   * streaming has no `[DONE]` sentinel — `message-end` is the completion signal;
//   * model discovery is paginated at 20 records by default, so one page is not the list.

import { failure } from '../../online/failure.mjs'
import { conversation, requireUserFirst, tokens, unique } from './common.mjs'

export const wire = 'cohere_chat'
const MODEL_PAGE_SIZE = 100
const MAX_PAGES = 20

const headers = (config) => ({ authorization: `Bearer ${config.apiKey}` })

/** The request body, exported so a contract test can assert it without a network call. */
export function bodyFor({ model, messages, maxTokens, temperature, stream = false }) {
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Cohere')
  return {
    model,
    // Cohere's v2 messages accept a `system` role, so unlike Anthropic and Gemini it is expressed
    // as a message rather than hoisted into a separate field.
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...turns],
    ...(stream ? { stream: true } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(Number.isInteger(maxTokens) ? { max_tokens: maxTokens } : {}),
  }
}

export async function models(transport, config) {
  const names = []
  let token = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `?page_size=${MODEL_PAGE_SIZE}${token ? `&page_token=${encodeURIComponent(token)}` : ''}`
    const data = await transport(config, `/v1/models${query}`, { headers: headers(config) })
    if (!Array.isArray(data?.models)) {
      throw failure('invalid_model_list', 'Cohere returned no model list.', 502)
    }
    names.push(...data.models.map((entry) => entry?.name))
    const next = typeof data.next_page_token === 'string' && data.next_page_token ? data.next_page_token : null
    // A token that does not move is a loop, not a page: refuse rather than fetch forever.
    if (next !== null && next === token) throw failure('invalid_model_list', 'Cohere repeated a page token.', 502)
    token = next
    if (!token) {
      const models = unique(names)
      if (models.length > 500) throw failure('model_list_too_large', 'Cohere listed more than 500 models.', 502)
      return models
    }
  }
  // Still paging after the cap: a partial list would look complete, so refuse it by name.
  throw failure('model_list_too_large', 'Cohere returned more model pages than this build will read.', 502)
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  if (!onText) {
    const data = await transport(config, '/v2/chat', {
      headers: headers(config), signal,
      body: bodyFor({ model, messages, maxTokens, temperature }),
    })
    const text = textOf(data)
    if (!text) throw failure('invalid_completion', 'Cohere returned no text content. Tool execution is not automatic.', 502)
    return { text, model: data?.model ?? null, usage: usageOf(data?.usage) }
  }

  let text = ''
  let reported = null
  let usage = null
  let ended = false
  const onFrame = (event) => {
    if (event.type === 'message-start') {
      reported = event.delta?.message?.model ?? reported
    } else if (event.type === 'content-delta') {
      const delta = event.delta?.message?.content?.text
      if (typeof delta === 'string') { text += delta; onText(delta) }
    } else if (event.type === 'message-end') {
      ended = true
      usage = usageOf(event.delta?.usage ?? event.usage) ?? usage
    }
  }
  await transport(config, '/v2/chat', {
    headers: headers(config), signal, onFrame, doneOnEnd: true,
    body: bodyFor({ model, messages, maxTokens, temperature, stream: true }),
  })
  if (!ended) throw failure('provider_interrupted', 'Cohere stream ended without message-end.', 502)
  return { text, model: reported, usage }
}

function textOf(data) {
  const blocks = data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Cohere reports tokens under `usage.tokens`; null when it reported no counts. */
function usageOf(usage) {
  return tokens(usage?.tokens?.input_tokens, usage?.tokens?.output_tokens)
}
