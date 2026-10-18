// xAI's current primary text-generation contract is Responses API, not Chat Completions.
// Model discovery uses the documented language-model catalogue for modality metadata.
import { failure } from '../../online/failure.mjs'

export const wire = 'xai_responses'
export const defaultBaseUrl = 'https://api.x.ai/v1'
const headers = (config) => config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && !/[\x00-\x1f\x7f]/.test(id)
export async function modelCatalogue(transport, config) {
  const payload = await transport(config, '/language-models', { headers: headers(config) })
  if (!Array.isArray(payload?.models) || payload.models.length > 500) throw failure('invalid_model_list', 'xAI returned an unsupported model catalogue.', 502)
  return payload.models.filter((item) => validId(item?.id) && (item.output_modalities?.includes('text') ?? true)).map((item) => ({
    id: item.id,
    name: item.name ?? item.id,
    capabilities: {
      input: Array.isArray(item.input_modalities) ? item.input_modalities : ['unknown'],
      output: Array.isArray(item.output_modalities) ? item.output_modalities : ['unknown'],
      contextTokens: Number.isSafeInteger(item.context_length) ? item.context_length : null,
      maxOutputTokens: Number.isSafeInteger(item.max_output_tokens) ? item.max_output_tokens : null,
      streaming: 'unknown', tools: 'not_exposed_by_ragam', structuredOutput: 'not_exposed_by_ragam',
      imageInput: Array.isArray(item.input_modalities) ? (item.input_modalities.includes('image') ? 'documented' : 'not_supported') : 'unknown',
      provenance: { source: 'vendor_model_list', provider: 'xAI', docs: 'https://docs.x.ai/developers/rest-api-reference/inference/models' },
    },
  })).sort((a, b) => a.id.localeCompare(b.id))
}
export async function models(transport, config) { return (await modelCatalogue(transport, config)).map((item) => item.id) }
function textFromResponse(data) {
  if (typeof data?.output_text === 'string') return data.output_text
  return (data?.output ?? []).flatMap((item) => item?.content ?? []).filter((part) => part?.type === 'output_text').map((part) => part.text).join('')
}
export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  const body = { model, input: messages, max_output_tokens: maxTokens, temperature, stream: Boolean(onText) }
  if (!onText) {
    const data = await transport(config, '/responses', { headers: headers(config), body, signal })
    const text = textFromResponse(data)
    if (typeof text !== 'string') throw failure('invalid_completion', 'xAI returned no text completion. No model was substituted.', 502)
    return { text, model: data.model ?? null, usage: data.usage ?? null }
  }
  let text = '', reported = null, usage = null, completed = false, failed = false
  const data = await transport(config, '/responses', {
    headers: headers(config), body, signal, doneOnEnd: true,
    onFrame: (frame) => {
      if (frame.type === 'response.output_text.delta' && typeof frame.delta === 'string') { text += frame.delta; onText(frame.delta) }
      if (frame.type === 'response.completed') { completed = true; reported = frame.response?.model ?? null; usage = frame.response?.usage ?? null }
      if (frame.type === 'response.failed') failed = true
    },
  })
  if (failed) throw failure('provider_request_rejected', 'xAI reported a failed response.', 502)
  if (!completed) throw failure('provider_interrupted', 'xAI stream ended without a completed response event.', 502)
  return { text, model: reported ?? data?.model ?? null, usage }
}
export const complete = chat
export const stream = chat
export const validateConfig = () => true
export const testConnection = (transport, config) => models(transport, config)
export const getModelCapabilities = (model) => model?.capabilities ?? null
export const cancel = (controller) => controller?.abort()
export function normalizeError(status, payload) {
  const code = String(payload?.error?.code ?? payload?.code ?? '').toLowerCase()
  if (status === 401 || status === 403) return { code: 'provider_auth_failed', message: 'xAI rejected the saved credentials or model access.' }
  if (status === 402 || (status === 429 && /quota|billing|credit|insufficient/.test(code))) return { code: 'provider_quota_exhausted', message: 'xAI reports an exhausted quota or billing balance.' }
  if (status === 429) return { code: 'provider_rate_limited', message: 'xAI rate limited the request.' }
  if (status === 404 || /model_not_found|unknown_model/.test(code)) return { code: 'provider_model_not_found', message: 'xAI does not expose the selected model to this connection.' }
  if (status === 408) return { code: 'provider_request_timeout', message: 'xAI timed out this request.' }
  if (status === 413 || /context_length|maximum_context/.test(code)) return { code: 'provider_context_limit', message: 'xAI rejected the request for exceeding a model limit.' }
  if (status >= 500) return { code: 'provider_unavailable', message: 'xAI returned a temporary service error.' }
  return { code: 'provider_request_rejected', message: `xAI rejected the request (HTTP ${status}). Check the model and request limits.` }
}
