// Contract adapter factory for providers whose documented Chat Completions API accepts the
// OpenAI request/response envelope. Provider modules supply endpoint paths, model-list shape and
// explicitly documented request differences; no adapter probes or falls back to another vendor.
import { failure } from '../../online/failure.mjs'

const safeId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && !/[\x00-\x1f\x7f]/.test(id)
const arrayFor = (payload, shape) => {
  for (const key of shape) {
    const found = key ? key.split('.').reduce((value, part) => value?.[part], payload) : payload
    if (Array.isArray(found)) return found
  }
  throw failure('invalid_model_list', 'Provider returned an unsupported model-list shape.', 502)
}

function capabilities(record, provider) {
  const input = record.input_modalities ?? record.architecture?.input_modalities ?? record.modalities ?? (typeof record.supportsImageInput === 'boolean' ? (record.supportsImageInput ? ['text', 'image'] : ['text']) : undefined)
  const output = record.output_modalities ?? record.architecture?.output_modalities ?? (record.supportsTextOutput === true ? ['text'] : undefined)
  const state = (value) => value === true ? 'documented' : value === false ? 'not_supported' : 'unknown'
  return {
    input: Array.isArray(input) ? [...new Set(input.filter((x) => typeof x === 'string'))] : ['unknown'],
    output: Array.isArray(output) ? [...new Set(output.filter((x) => typeof x === 'string'))] : ['unknown'],
    contextTokens: Number.isSafeInteger(record.context_window) ? record.context_window
      : Number.isSafeInteger(record.context_length) ? record.context_length
        : Number.isSafeInteger(record.contextLength) ? record.contextLength : null,
    maxOutputTokens: Number.isSafeInteger(record.max_output_tokens) ? record.max_output_tokens : null,
    streaming: state(record.capabilities?.streaming ?? record.streaming),
    tools: 'not_exposed_by_ragam',
    structuredOutput: 'not_exposed_by_ragam',
    imageInput: Array.isArray(input) ? (input.includes('image') ? 'documented' : 'not_supported') : 'unknown',
    provenance: record._evidence ?? { source: 'provider_model_list', provider },
  }
}

export function createOpenAICompatibleAdapter(spec) {
  const headers = (config) => ({
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...(spec.headers?.(config) ?? {}),
  })
  const modelPath = (config) => typeof spec.modelPath === 'function' ? spec.modelPath(config) : spec.modelPath
  const parseRecords = (payload) => arrayFor(payload, spec.modelShapes ?? ['data', 'models', '']).slice(0, 500)
  const recordId = (record) => typeof record === 'string' ? record : (record?.id ?? record?.name ?? record?.model)
  const modelCatalogue = async (transport, config) => {
    const payload = spec.fetchModelList
      ? await spec.fetchModelList(transport, config, headers(config))
      : await transport(config, modelPath(config), { headers: headers(config) })
    const records = parseRecords(payload)
    if (records.length >= 500 && arrayFor(payload, spec.modelShapes ?? ['data', 'models', '']).length > 500) {
      throw failure('invalid_model_list', 'The provider returned too many model records.', 502)
    }
    const unique = new Map()
    for (const raw of records) {
      const id = recordId(raw)
      if (!safeId(id) || (spec.includeModel && !spec.includeModel(raw))) continue
      unique.set(id, {
        id,
        name: typeof raw === 'object' ? (raw.name ?? raw.display_name ?? raw.displayName ?? raw.title ?? id) : id,
        capabilities: capabilities(typeof raw === 'object' ? raw : {}, spec.provider),
      })
    }
    return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
  const models = async (transport, config) => (await modelCatalogue(transport, config)).map((item) => item.id)

  async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
    let reported = null, usage = null, text = ''
    const onFrame = onText ? (frame) => {
      if (frame.model) reported = frame.model
      if (frame.usage) usage = frame.usage
      const delta = frame.choices?.[0]?.delta?.content
      if (typeof delta === 'string') { text += delta; onText(delta) }
    } : null
    const body = {
      model,
      messages,
      ...(spec.maxTokensField ? { [spec.maxTokensField]: maxTokens } : { max_tokens: maxTokens }),
      temperature,
      stream: Boolean(onText),
      ...(onText && spec.streamUsage ? { stream_options: { include_usage: true } } : {}),
    }
    if (spec.buildRequest) Object.assign(body, spec.buildRequest({ model, messages, maxTokens, temperature, streaming: Boolean(onText), config }))
    const data = await transport(config, spec.chatPath, { headers: headers(config), signal, body, onFrame })
    if (onText) return { text, model: reported, usage }
    const completion = spec.getText ? spec.getText(data) : data?.choices?.[0]?.message?.content
    if (typeof completion !== 'string') throw failure('invalid_completion', `${spec.provider} returned no text completion. No model was substituted.`, 502)
    return { text: completion, model: data?.model ?? null, usage: data?.usage ?? null }
  }
  return Object.freeze({
    wire: spec.wire,
    provider: spec.provider,
    compatibility: 'openai-compatible',
    docsUrl: spec.docsUrl,
    models,
    modelCatalogue,
    chat,
    complete: chat,
    stream: chat,
    validateConfig(config) {
      if (spec.validateConfig) spec.validateConfig(config)
      return true
    },
    testConnection: (transport, config) => models(transport, config),
    getModelCapabilities: (record) => record?.capabilities ?? capabilities({}, spec.provider),
    cancel: (controller) => controller?.abort(),
    normalizeError(status, payload) {
      const rawCode = String(payload?.error?.code ?? payload?.code ?? payload?.error?.type ?? '').toLowerCase()
      if (status === 401 || status === 403) return { code: 'provider_auth_failed', message: `${spec.provider} rejected the saved credentials or model access.` }
      if (status === 402 || (status === 429 && /quota|billing|credit|insufficient/.test(rawCode))) return { code: 'provider_quota_exhausted', message: `${spec.provider} reports an exhausted quota or billing balance.` }
      if (status === 429) return { code: 'provider_rate_limited', message: `${spec.provider} rate limited the request.` }
      if (status === 404 || /model_not_found|unknown_model/.test(rawCode)) return { code: 'provider_model_not_found', message: `${spec.provider} does not expose the selected model to this connection.` }
      if (status === 408) return { code: 'provider_request_timeout', message: `${spec.provider} timed out this request.` }
      if (status === 413 || /context_length|maximum_context/.test(rawCode)) return { code: 'provider_context_limit', message: `${spec.provider} rejected the request for exceeding a model limit.` }
      if (status >= 500) return { code: 'provider_unavailable', message: `${spec.provider} returned a temporary service error.` }
      return { code: 'provider_request_rejected', message: `${spec.provider} rejected the request (HTTP ${status}). Check model id and request limits.` }
    },
  })
}
