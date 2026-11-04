// OpenAI Chat Completions: `GET {base}/models` and `POST {base}/chat/completions`.
// Explicit native search switches to `POST {base}/responses` with the hosted `web_search` tool; it
// never retries a failed Responses request through Chat Completions.
// Contract reference: https://developers.openai.com/api/docs/guides/tools-web-search
//
// This is the wire the product shipped with; it is now an adapter like the other two, so the app
// has one path and a connection's wire decides which builder runs. The request body, headers and
// SSE frames are unchanged from the version that predates the adapter split — the existing tests
// pin them, which is the point of moving the code rather than rewriting it.

import { failure } from '../../online/failure.mjs'
import { appendOpenAIToolDeltas, finishOpenAIToolDeltas, openAIMessages, openAIToolCalls } from './common.mjs'
import { chat as chatResponses } from './openai-responses.mjs'

export const wire = 'openai_chat'
export const defaultBaseUrl = 'https://api.openai.com/v1'
export const provider = 'OpenAI'
export const compatibility = 'native-vendor'
export const chatInputKinds = Object.freeze(['image'])
export const chatTools = true
export const chatNativeSearch = true

const headers = (config) => (config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})

export async function modelCatalogue(transport, config) {
  const payload = await transport(config, '/models', { headers: headers(config) })
  if (!Array.isArray(payload?.data) || payload.data.length > 500) throw failure('invalid_model_list', 'OpenAI returned an unsupported model catalogue.', 502)
  const rows = new Map()
  for (const row of payload.data) {
    const id = row?.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 240 || /[\x00-\x1f\x7f]/.test(id)) continue
    rows.set(id, { id, name: id, capabilities: { input: ['unknown'], output: ['unknown'], contextTokens: null, maxOutputTokens: null, streaming: 'unknown', tools: 'not_exposed_by_ragam', structuredOutput: 'not_exposed_by_ragam', imageInput: 'unknown', provenance: { source: 'vendor_model_list', provider: 'OpenAI' } } })
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}
export async function models(transport, config) { return (await modelCatalogue(transport, config)).map((row) => row.id) }
export const validateConfig = () => true
export const testConnection = (transport, config) => models(transport, config)
export const getModelCapabilities = (record) => record?.capabilities ?? null
export const cancel = (controller) => controller?.abort()
export const normalizeError = (status, payload) => {
  const code = String(payload?.error?.code ?? payload?.error?.type ?? '').toLowerCase()
  if (status === 401 || status === 403) return { code: 'provider_auth_failed', message: 'OpenAI rejected the saved credentials or model access.' }
  if (status === 402 || (status === 429 && /quota|billing|credit|insufficient/.test(code))) return { code: 'provider_quota_exhausted', message: 'OpenAI reports an exhausted quota or billing balance.' }
  if (status === 429) return { code: 'provider_rate_limited', message: 'OpenAI rate limited the request.' }
  if (status === 404 || /model_not_found|unknown_model/.test(code)) return { code: 'provider_model_not_found', message: 'OpenAI does not expose the selected model to this connection.' }
  if (status === 408) return { code: 'provider_request_timeout', message: 'OpenAI timed out this request.' }
  if (status === 413 || /context_length|maximum_context/.test(code)) return { code: 'provider_context_limit', message: 'OpenAI rejected the request for exceeding a model limit.' }
  if (status >= 500) return { code: 'provider_unavailable', message: 'OpenAI returned a temporary service error.' }
  return { code: 'provider_request_rejected', message: `OpenAI rejected the request (HTTP ${status}). Check the model and request limits.` }
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText, maxRequestBytes, tools = [], nativeSearch = false }) {
  if (nativeSearch) return chatResponses(transport, config, { path: '/responses', headers: headers(config), model, messages, maxTokens, temperature, signal, onText, maxRequestBytes, tools, nativeSearch })
  let reported = null
  let usage = null
  let text = ''
  const toolDeltas = new Map()
  const onFrame = onText
    ? (frame) => {
        if (frame.model) reported = frame.model
        if (frame.usage) usage = frame.usage
        const choice = frame.choices?.[0]
        appendOpenAIToolDeltas(toolDeltas, choice?.delta?.tool_calls)
        const delta = choice?.delta?.content
        if (typeof delta === 'string') { text += delta; onText(delta) }
      }
    : null
  const data = await transport(config, '/chat/completions', {
    headers: headers(config),
    signal,
    body: { model, messages: openAIMessages(messages), max_tokens: maxTokens, temperature, stream: Boolean(onText), ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}) },
    maxRequestBytes,
    onFrame,
  })
  if (onText) return { text, model: reported, usage, toolCalls: finishOpenAIToolDeltas(toolDeltas) }
  const message = data?.choices?.[0]?.message
  const completion = message?.content
  const toolCalls = openAIToolCalls(message?.tool_calls ?? [])
  if (typeof completion !== 'string' && !toolCalls.length) {
    throw failure('invalid_completion', 'This model did not return a text completion. No model was substituted.', 502)
  }
  return { text: typeof completion === 'string' ? completion : '', model: data.model ?? null, usage: data.usage ?? null, toolCalls }
}

export const complete = chat
export const stream = chat
