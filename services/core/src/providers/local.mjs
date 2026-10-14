// Local runtime adapters.
//
// Both speak HTTP to a *locally installed* runtime, so they are reachable under
// strict_offline (loopback) and require no external credentials.
//
//   OllamaProvider            → https://github.com/ollama/ollama   (POST /api/chat, GET /api/tags)
//   OpenAiCompatLocalProvider → llama.cpp `llama-server`, llama-cpp-python,
//                               vLLM, LocalAI, text-generation-webui
//                               (POST /v1/chat/completions, GET /v1/models)
//
// Neither adapter invents a completion. If the runtime is absent, probe() says
// NOT_INSTALLED and the router rejects the candidate with that exact reason.

import { BaseProvider, OPERATIONS, ProviderError, readProviderError } from './base.mjs'
import { AVAILABILITY } from '../router/registry.mjs'

export class OllamaProvider extends BaseProvider {
  static operations = [OPERATIONS.CHAT, OPERATIONS.CHAT_STREAM, OPERATIONS.EMBED]

  constructor({ baseUrl = 'http://127.0.0.1:11434', guard, onEvent, timeoutMs = 180_000 }) {
    super({ name: 'ollama', guard, onEvent, timeoutMs })
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
  }

  async probe() {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, { method: 'GET' }, { timeoutMs: 5_000, operation: 'probe' })
      if (!response.ok) return { availability: AVAILABILITY.UNREACHABLE, detail: `HTTP ${response.status}` }
      const data = await response.json()
      const models = (Array.isArray(data?.models) ? data.models : []).filter((m) => !m.remote_model && !m.remote_host)
      return {
        availability: models.length ? AVAILABILITY.READY : AVAILABILITY.NOT_INSTALLED,
        detail: { runtime: 'ollama', modelsInstalled: models.length, models: models.map((m) => m.name ?? m.model).filter(Boolean) },
      }
    } catch (error) {
      if (error?.code === 'EGRESS_BLOCKED') return { availability: AVAILABILITY.DISABLED, detail: error.message }
      return { availability: AVAILABILITY.NOT_INSTALLED, detail: error.message }
    }
  }

  /** Models actually present in the local runtime, for registry synchronisation. */
  async listLocalModels() {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, { method: 'GET' }, { timeoutMs: 8_000, operation: 'list' })
    if (!response.ok) throw await readProviderError(response, this.name, 'list')
    const data = await response.json()
    return (Array.isArray(data?.models) ? data.models : []).filter((m) => !m.remote_model && !m.remote_host).map((model) => ({
      id: model.name ?? model.model,
      sizeBytes: model.size ?? null,
      family: model.details?.family ?? null,
      parameterSize: model.details?.parameter_size ?? null,
      quantization: model.details?.quantization_level ?? null,
    }))
  }

  /**
   * Non-streaming chat. Returns {text, model, doneReason, usage}.
   * @param {object} request {model, messages, temperature, maxTokens, signal}
   */
  async chat(request) {
    this.assertSupports(OPERATIONS.CHAT)
    const body = {
      model: request.model,
      messages: normalizeMessages(request.messages),
      stream: false,
      options: {
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.maxTokens != null ? { num_predict: request.maxTokens } : {}),
      },
    }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT, timeoutMs: this.timeoutMs },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT)
    const data = await response.json()
    return {
      text: String(data?.message?.content ?? ''),
      model: data?.model ?? request.model,
      doneReason: data?.done_reason ?? (data?.done ? 'stop' : null),
      usage: {
        promptTokens: data?.prompt_eval_count ?? null,
        completionTokens: data?.eval_count ?? null,
        totalDurationNs: data?.total_duration ?? null,
      },
      provider: this.name,
    }
  }

  /**
   * Streaming chat. Yields text deltas as the runtime produces them.
   * Ollama streams newline-delimited JSON.
   */
  async *chatStream(request) {
    this.assertSupports(OPERATIONS.CHAT_STREAM)
    const body = {
      model: request.model,
      messages: normalizeMessages(request.messages),
      stream: true,
      options: {
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.maxTokens != null ? { num_predict: request.maxTokens } : {}),
      },
    }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT_STREAM, timeoutMs: this.timeoutMs },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT_STREAM)
    yield* parseNdjsonStream(response, (chunk) => chunk?.message?.content ?? '')
  }

  async embed({ model, input }) {
    this.assertSupports(OPERATIONS.EMBED)
    const inputs = Array.isArray(input) ? input : [input]
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/embed`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: inputs }) },
      { operation: OPERATIONS.EMBED },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.EMBED)
    const data = await response.json()
    const vectors = Array.isArray(data?.embeddings) ? data.embeddings : []
    if (vectors.length !== inputs.length) {
      throw new ProviderError(`${this.name}: expected ${inputs.length} embeddings, got ${vectors.length}`, { code: 'malformed_response' })
    }
    return { vectors, model: data?.model ?? model, provider: this.name }
  }
}

export class OpenAiCompatLocalProvider extends BaseProvider {
  static operations = [OPERATIONS.CHAT, OPERATIONS.CHAT_STREAM, OPERATIONS.EMBED, OPERATIONS.IMAGE_UNDERSTAND]

  constructor({ baseUrl = 'http://127.0.0.1:8080/v1', runtime = 'llama.cpp', guard, onEvent, timeoutMs = 180_000, apiKey = null }) {
    super({ name: `local:${runtime}`, guard, onEvent, timeoutMs })
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
    this.runtime = runtime
    // A local server key is not a provider credential, but it is still kept
    // server-side and never returned to the browser.
    this.apiKey = apiKey
  }

  #headers(extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async probe() {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/models`, { method: 'GET', headers: this.#headers() }, { timeoutMs: 5_000, operation: 'probe' })
      if (!response.ok) return { availability: AVAILABILITY.UNREACHABLE, detail: `HTTP ${response.status}` }
      const data = await response.json()
      const models = Array.isArray(data?.data) ? data.data : []
      return {
        availability: models.length ? AVAILABILITY.READY : AVAILABILITY.NOT_INSTALLED,
        detail: { runtime: this.runtime, modelsServed: models.length, models: models.map((m) => m.id).filter(Boolean) },
      }
    } catch (error) {
      if (error?.code === 'EGRESS_BLOCKED') return { availability: AVAILABILITY.DISABLED, detail: error.message }
      return { availability: AVAILABILITY.NOT_INSTALLED, detail: error.message }
    }
  }

  async chat(request) {
    this.assertSupports(OPERATIONS.CHAT)
    const body = {
      model: request.model,
      messages: normalizeMessages(request.messages),
      stream: false,
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT)
    const data = await response.json()
    const choice = data?.choices?.[0]
    if (!choice) throw new ProviderError(`${this.name}: response contained no choices`, { code: 'malformed_response' })
    return {
      text: String(choice.message?.content ?? ''),
      toolCalls: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [],
      model: data?.model ?? request.model,
      doneReason: choice.finish_reason ?? null,
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? null,
        completionTokens: data?.usage?.completion_tokens ?? null,
        totalTokens: data?.usage?.total_tokens ?? null,
      },
      provider: this.name,
    }
  }

  /** Streaming via Server-Sent Events (`data: {...}` lines, terminated by `[DONE]`). */
  async *chatStream(request) {
    this.assertSupports(OPERATIONS.CHAT_STREAM)
    const body = {
      model: request.model,
      messages: normalizeMessages(request.messages),
      stream: true,
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.maxTokens != null ? { max_tokens: request.maxTokens } : {}),
    }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT_STREAM },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT_STREAM)
    yield* parseSseStream(response, (chunk) => chunk?.choices?.[0]?.delta?.content ?? '')
  }

  async embed({ model, input }) {
    this.assertSupports(OPERATIONS.EMBED)
    const inputs = Array.isArray(input) ? input : [input]
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/embeddings`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify({ model, input: inputs }) },
      { operation: OPERATIONS.EMBED },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.EMBED)
    const data = await response.json()
    const rows = Array.isArray(data?.data) ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : []
    const vectors = rows.map((row) => row.embedding)
    if (vectors.length !== inputs.length || vectors.some((v) => !Array.isArray(v))) {
      throw new ProviderError(`${this.name}: malformed embeddings response`, { code: 'malformed_response' })
    }
    return { vectors, model: data?.model ?? model, provider: this.name, usage: data?.usage ?? null }
  }
}

// --- shared helpers -------------------------------------------------------

const ALLOWED_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

/** Allow-list roles and coerce content, as the original Aetheris gateway did. */
export function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError('messages must be an array')
  const out = []
  for (const message of messages) {
    if (!message || !ALLOWED_ROLES.has(message.role)) continue
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content })
    } else if (Array.isArray(message.content)) {
      // Multimodal parts (text / image_url). Passed through only when well-formed.
      const parts = message.content.filter(
        (part) => part && typeof part === 'object' && (part.type === 'text' || part.type === 'image_url'),
      )
      if (parts.length) out.push({ role: message.role, content: parts })
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      out[out.length - 1].tool_calls = message.tool_calls
    }
    if (message.role === 'tool' && message.tool_call_id) {
      out[out.length - 1].tool_call_id = message.tool_call_id
    }
  }
  if (!out.length) throw new ProviderError('no valid messages supplied', { code: 'messages_required', status: 400 })
  return out
}

async function* parseNdjsonStream(response, extract) {
  const reader = response.body?.getReader?.()
  if (!reader) throw new ProviderError('provider returned no readable stream', { code: 'malformed_response' })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        let chunk
        try {
          chunk = JSON.parse(line)
        } catch {
          continue // tolerate keep-alive noise
        }
        const text = extract(chunk)
        if (text) yield String(text)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}

async function* parseSseStream(response, extract) {
  const reader = response.body?.getReader?.()
  if (!reader) throw new ProviderError('provider returned no readable stream', { code: 'malformed_response' })
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let chunk
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const text = extract(chunk)
        if (text) yield String(text)
      }
    }
  } finally {
    reader.releaseLock?.()
  }
}
