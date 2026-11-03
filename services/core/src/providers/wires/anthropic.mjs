// Anthropic Messages: `POST {base}/messages`, `GET {base}/models`.
//
// Verified against the official reference (2026-10-17):
//   https://docs.anthropic.com/en/api/messages          — POST /v1/messages, `x-api-key`,
//       `anthropic-version: 2023-06-01`, body { model, max_tokens, messages, system?, stream? }
//   https://docs.anthropic.com/en/api/models-list       — GET /v1/models -> { data: [{ id, ... }] }
//   https://docs.anthropic.com/en/api/messages-streaming — SSE events message_start,
//       content_block_delta (`delta.type: "text_delta"`), message_delta, message_stop
//   https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool — explicit search
//       uses the server-side `web_search_20250305` tool; this requires per-request user consent.
//
// Differences from the OpenAI wire that are not cosmetic, and are therefore explicit here:
//   * auth is the `x-api-key` header, not `Authorization: Bearer`;
//   * every request needs `anthropic-version`;
//   * `system` is a top-level string, not a message role, and `messages` must start with `user`;
//   * a successful response is a list of content blocks, and only `text` blocks are text;
//   * streaming has no `[DONE]` sentinel — `message_stop` is the completion signal.

import { failure } from '../../online/failure.mjs'
import { anthropicContent, conversation, requireUserFirst, tokens, idsFromData } from './common.mjs'

export const wire = 'anthropic_messages'
export const defaultBaseUrl = 'https://api.anthropic.com/v1'
export const ANTHROPIC_VERSION = '2023-06-01'
export const chatInputKinds = Object.freeze(['image'])
export const chatTools = true
export const chatNativeSearch = true

const headers = (config) => ({ 'x-api-key': config.apiKey, 'anthropic-version': ANTHROPIC_VERSION })

/** The request body, exported so a contract test can assert it without a network call. */
export function bodyFor({ model, messages, maxTokens, temperature, stream = false, tools = [], nativeSearch = false }) {
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Anthropic')
  return {
    model,
    max_tokens: maxTokens,
    messages: turns.map((turn) => ({ ...turn, content: anthropicContent(turn.content) })),
    ...(system ? { system } : {}),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    ...(stream ? { stream: true } : {}),
    ...(nativeSearch || tools.length ? { tools: [
      ...(nativeSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : []),
      ...tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
    ] } : {}),
    ...(tools.length ? { tool_choice: { type: 'auto' } } : {}),
  }
}

export async function models(transport, config) {
  return idsFromData(await transport(config, '/models', { headers: headers(config) }))
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText, maxRequestBytes, tools = [], nativeSearch = false }) {
  if (!onText) {
    const data = await transport(config, '/messages', {
      headers: headers(config), signal,
      body: bodyFor({ model, messages, maxTokens, temperature, tools, nativeSearch }),
      maxRequestBytes,
    })
    const text = textOf(data?.content)
    const toolCalls = toolCallsOf(data?.content)
    if (!text && !toolCalls.length) throw failure('invalid_completion', 'Anthropic returned no text or function proposal. Tool execution is not automatic.', 502)
    return { text, model: data?.model ?? null, usage: tokens(data?.usage?.input_tokens, data?.usage?.output_tokens), toolCalls, grounding: nativeSearch ? groundingOf(data?.content) : null }
  }

  // Streaming. `message_stop` is the completion signal; an HTTP body that simply ends is not,
  // because a truncated response would otherwise be indistinguishable from a finished one.
  let text = ''
  let reported = null
  let promptTokens = null
  let completionTokens = null
  let stopped = false
  const toolBlocks = new Map()
  const searchBlocks = []
  const onFrame = (event) => {
    if (event.type === 'message_start') {
      reported = event.message?.model ?? reported
      promptTokens = event.message?.usage?.input_tokens ?? promptTokens
      completionTokens = event.message?.usage?.output_tokens ?? completionTokens
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, inputJson: '' })
    } else if (event.type === 'content_block_start' && ['server_tool_use', 'web_search_tool_result', 'text'].includes(event.content_block?.type)) {
      searchBlocks.push(event.content_block)
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'input_json_delta' && toolBlocks.has(event.index)) toolBlocks.get(event.index).inputJson += delta.partial_json ?? ''
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
    body: bodyFor({ model, messages, maxTokens, temperature, stream: true, tools, nativeSearch }),
    maxRequestBytes,
  })
  if (!stopped) throw failure('provider_interrupted', 'Anthropic stream ended without message_stop.', 502)
  const toolCalls = [...toolBlocks.values()].map((block, index) => parseToolCall(block.id ?? `anthropic-${index}`, block.name, block.inputJson))
  if (!text && !toolCalls.length) throw failure('invalid_completion', 'Anthropic returned neither text nor a function proposal.', 502)
  return { text, model: reported, usage: tokens(promptTokens, completionTokens), toolCalls, grounding: nativeSearch ? groundingOf(searchBlocks) : null }
}

/** Extract only provider-returned search queries and HTTP(S) source references. */
export function groundingOf(blocks) {
  if (!Array.isArray(blocks)) return null
  const sources = []
  const queries = []
  const addSource = (source) => {
    if (typeof source?.url !== 'string' || !(source.url.startsWith('https://') || source.url.startsWith('http://'))) return
    if (!sources.some((item) => item.url === source.url)) sources.push({ title: typeof source.title === 'string' ? source.title.slice(0, 500) : '', url: source.url })
  }
  for (const block of blocks) {
    if (block?.type === 'server_tool_use' && block.name === 'web_search' && typeof block.input?.query === 'string' && queries.length < 10) {
      queries.push(block.input.query.slice(0, 1000))
    }
    if (block?.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const result of block.content) addSource(result)
    }
    for (const citation of block?.citations ?? []) addSource(citation)
  }
  return sources.length || queries.length ? { sources: sources.slice(0, 30), queries } : null
}

/** Text content blocks only: a response of `tool_use` or `thinking` blocks is not a completion. */
function parseToolCall(id, name, raw) {
  if (typeof name !== 'string' || !name || typeof raw !== 'string') throw failure('invalid_tool_proposal', 'Anthropic returned a malformed function proposal.', 502)
  let args
  try { args = JSON.parse(raw) } catch { throw failure('invalid_tool_proposal', 'Anthropic returned invalid JSON for a function proposal.', 502) }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('invalid_tool_proposal', 'Function proposal arguments must be an object.', 502)
  return { proposalId: String(id).slice(0, 128), name, arguments: args }
}

function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool_use').map((block, index) => {
    const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {}
    return { proposalId: String(block.id ?? `anthropic-${index}`).slice(0, 128), name: block.name, arguments: input }
  })
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
