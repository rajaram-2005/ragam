// Shared OpenAI Responses API web-search path for OpenAI, Azure OpenAI, and
// OpenAI-Responses-compatible endpoints. The endpoint is selected by the wire;
// a failure is surfaced directly and never falls back to Chat Completions.
import { failure } from '../../online/failure.mjs'
import { tokens } from './common.mjs'

function inputContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) throw failure('invalid_messages', 'Message content must be text or supported media parts.', 400)
  return content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'input_text', text: part.text }
    if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      return { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}`, detail: 'auto' }
    }
    throw failure('capability_unavailable', `OpenAI Responses Chat does not accept ${String(part?.type ?? 'unknown')} attachments.`, 409)
  })
}

export function bodyFor({ model, messages, maxTokens, temperature, tools = [], nativeSearch = false, stream = false, searchToolType = 'web_search' }) {
  return {
    model,
    input: (messages ?? []).map(({ role, content }) => ({ role, content: inputContent(content) })),
    max_output_tokens: maxTokens,
    ...(Number.isFinite(temperature) ? { temperature } : {}),
    stream,
    ...(nativeSearch || tools.length ? { tools: [
      ...(nativeSearch ? [{ type: searchToolType }] : []),
      ...tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters, strict: false })),
    ] } : {}),
  }
}

function outputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text
  return (data?.output ?? []).flatMap((item) => item?.content ?? [])
    .filter((part) => ['output_text', 'text'].includes(part?.type) && typeof part.text === 'string')
    .map((part) => part.text).join('')
}

function toolCallsOf(data) {
  return (data?.output ?? []).filter((item) => item?.type === 'function_call').map((item, index) => {
    if (typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string') {
      throw failure('invalid_tool_proposal', 'The provider returned a malformed function proposal.', 502)
    }
    let args
    try { args = JSON.parse(item.arguments) } catch { throw failure('invalid_tool_proposal', 'The provider returned invalid JSON for a function proposal.', 502) }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw failure('invalid_tool_proposal', 'Function proposal arguments must be an object.', 502)
    return { proposalId: String(item.call_id ?? item.id ?? `response-${index}`).slice(0, 128), name: item.name, arguments: args }
  })
}

function groundingOf(data) {
  const sources = []
  const queries = []
  const addSource = (source) => {
    if (typeof source?.url !== 'string' || !/^https?:\/\//i.test(source.url)) return
    if (!sources.some((item) => item.url === source.url)) sources.push({ title: typeof source.title === 'string' ? source.title.slice(0, 500) : '', url: source.url })
  }
  for (const item of data?.output ?? []) {
    if (item?.type === 'web_search_call') {
      const action = item.action ?? {}
      if (typeof action.query === 'string' && queries.length < 10) queries.push(action.query.slice(0, 1000))
      for (const source of action.sources ?? item.results ?? []) addSource(source)
    }
    for (const part of item?.content ?? []) {
      for (const annotation of part?.annotations ?? []) {
        if (annotation?.type === 'url_citation') addSource(annotation)
      }
    }
  }
  return sources.length || queries.length ? { sources: sources.slice(0, 30), queries } : null
}

function normalized(data) {
  const text = outputText(data)
  const toolCalls = toolCallsOf(data)
  if (!text && !toolCalls.length) throw failure('invalid_completion', 'OpenAI Responses returned neither text nor a function proposal. No fallback was attempted.', 502)
  return {
    text,
    model: data?.model ?? null,
    usage: tokens(data?.usage?.input_tokens, data?.usage?.output_tokens),
    toolCalls,
    grounding: groundingOf(data),
  }
}

export async function chat(transport, config, { path, headers, model, messages, maxTokens, temperature, signal, onText, maxRequestBytes, tools = [], nativeSearch = false, searchToolType = 'web_search' }) {
  if (!nativeSearch) throw failure('capability_unavailable', 'The OpenAI Responses path is reserved for explicitly approved native search.', 409)
  if (!model) throw failure('invalid_model', 'Choose a model before searching.', 400)
  const body = bodyFor({ model, messages, maxTokens, temperature, tools, nativeSearch, stream: Boolean(onText), searchToolType })
  if (!onText) {
    const data = await transport(config, path, { headers, signal, body, maxRequestBytes })
    return normalized(data)
  }

  let completed = null
  let failed = false
  let text = ''
  await transport(config, path, {
    headers, signal, body, maxRequestBytes, doneOnEnd: true,
    onFrame: (frame) => {
      if (frame?.type === 'response.output_text.delta' && typeof frame.delta === 'string') {
        text += frame.delta
        onText(frame.delta)
      }
      if (frame?.type === 'response.completed') completed = frame.response ?? null
      if (frame?.type === 'response.failed' || frame?.type === 'error') failed = true
    },
  })
  if (failed) throw failure('provider_request_rejected', 'The Responses API reported a failed search request.', 502)
  if (!completed) throw failure('provider_interrupted', 'The Responses stream ended without a completed response.', 502)
  const result = normalized(completed)
  // A completion event is authoritative for usage, citations and proposals; deltas are only for display.
  if (text && !result.text) result.text = text
  return result
}
