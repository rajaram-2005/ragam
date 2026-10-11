// FreeLLMAPI online gateway adapter.
//
// Every request/response shape here was read from freellmapi source, not from its
// README — see docs/01-audit.md §3.2 for the file:line citations.
//
//   POST /v1/chat/completions   JSON, streaming SSE, real tool calling
//   POST /v1/embeddings         JSON
//   POST /v1/rerank             JSON (Cohere/Jina style)
//   POST /v1/images/generations JSON  {created, data[], model, provider}
//   POST /v1/videos/generations BINARY mp4 + X-Provider / X-Model headers
//   GET  /v1/models             catalog, supports ?ready=true
//
// Two facts that shape this adapter:
//  1. The video endpoint presents "one bounded request and returns the completed
//     MP4" — providers may queue internally, but the caller sees a single long
//     request. Cancellation is therefore *aborting our own fetch*, which the
//     gateway detects via res.on('close') and stops polling the provider.
//  2. VIDEO_PLATFORMS = {pollinations, huggingface} only, and video is not served
//     on custom endpoints. Chat support does NOT imply video support.
//
// Credentials live only in this server-side process. The key is never returned by
// any method, never logged, and never placed in a response body.

import { BaseProvider, OPERATIONS, ProviderError, readProviderError } from './base.mjs'
import { AVAILABILITY } from '../router/registry.mjs'

const MAX_IMAGE_N = 4 // ImageBody: n int positive max 4
const VIDEO_DURATION_MIN = 1
const VIDEO_DURATION_MAX = 120
const VIDEO_ASPECT_RATIOS = new Set(['16:9', '9:16'])
const VIDEO_SEED_MIN = -1
const VIDEO_SEED_MAX = 2_147_483_647

export class FreellmapiProvider extends BaseProvider {
  static operations = [
    OPERATIONS.CHAT,
    OPERATIONS.CHAT_STREAM,
    OPERATIONS.EMBED,
    OPERATIONS.RERANK,
    OPERATIONS.IMAGE_GENERATE,
    OPERATIONS.VIDEO_GENERATE,
    OPERATIONS.AUDIO_SPEECH,
    OPERATIONS.AUDIO_TRANSCRIBE,
  ]

  /**
   * @param {object} options
   * @param {string} options.baseUrl   e.g. 'https://freellmapi.example.com/v1'
   * @param {string} options.apiKey    server-side only; never serialised
   * @param {object} options.guard     egress guard — decides if this host is reachable at all
   */
  constructor({ baseUrl, apiKey = '', guard, onEvent, timeoutMs = 120_000, videoTimeoutMs = 600_000 }) {
    super({ name: 'freellmapi', guard, onEvent, timeoutMs })
    if (!baseUrl) throw new TypeError('FreellmapiProvider requires a baseUrl')
    this.baseUrl = String(baseUrl).replace(/\/$/, '')
    this.#apiKey = String(apiKey ?? '').trim()
    this.videoTimeoutMs = videoTimeoutMs
  }

  #apiKey

  get configured() {
    return Boolean(this.#apiKey)
  }

  /** Redacted for health responses. Returns the endpoint shape, never the key. */
  safeDescriptor() {
    let endpoint = null
    try {
      const url = new URL(this.baseUrl)
      endpoint = `${url.protocol}//${url.host}${url.pathname}`
    } catch {
      endpoint = '[configured endpoint]'
    }
    return { provider: this.name, endpoint, keyConfigured: this.configured, keyTransport: 'server environment', browserKeyExposure: false }
  }

  #headers(extra = {}) {
    if (!this.#apiKey) {
      throw new ProviderError('freellmapi API key is not configured on the server', { code: 'needs_credentials', status: 503 })
    }
    return { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json', ...extra }
  }

  async probe() {
    if (!this.configured) return { availability: AVAILABILITY.NEEDS_CREDENTIALS, detail: 'API key not configured server-side' }
    try {
      // The guard decides reachability first: under strict_offline this throws
      // EGRESS_BLOCKED and the provider reports DISABLED rather than pretending.
      this.guard.assertReachable(`${this.baseUrl}/models`)
    } catch (error) {
      return { availability: AVAILABILITY.DISABLED, detail: error.message }
    }
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/models?ready=true`, { method: 'GET', headers: this.#headers() }, { timeoutMs: 8_000, operation: 'probe' })
      if (response.status === 401) return { availability: AVAILABILITY.NEEDS_CREDENTIALS, detail: 'gateway rejected the API key (401)' }
      if (!response.ok) return { availability: AVAILABILITY.UNREACHABLE, detail: `HTTP ${response.status}` }
      const data = await response.json()
      const models = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
      return { availability: AVAILABILITY.READY, detail: { readyModels: models.length, sample: models.slice(0, 10).map((m) => m?.id ?? m) } }
    } catch (error) {
      return { availability: AVAILABILITY.UNREACHABLE, detail: error.message }
    }
  }

  async listModels({ readyOnly = true } = {}) {
    const query = readyOnly ? '?ready=true' : ''
    const response = await this.fetchWithTimeout(`${this.baseUrl}/models${query}`, { method: 'GET', headers: this.#headers() }, { operation: 'list_models' })
    if (!response.ok) throw await readProviderError(response, this.name, 'list_models')
    const data = await response.json()
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
    return rows.map((row) => ({ id: row?.id ?? row, ownedBy: row?.owned_by ?? null, ready: row?.ready ?? null }))
  }

  async chat(request) {
    this.assertSupports(OPERATIONS.CHAT)
    const body = buildChatBody(request)
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT)
    const data = await response.json()
    const choice = data?.choices?.[0]
    if (!choice) throw new ProviderError('gateway returned no choices', { code: 'malformed_response', status: 502 })
    return {
      text: String(choice.message?.content ?? ''),
      toolCalls: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [],
      model: data?.model ?? request.model ?? null,
      doneReason: choice.finish_reason ?? null,
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? null,
        completionTokens: data?.usage?.completion_tokens ?? null,
        totalTokens: data?.usage?.total_tokens ?? null,
      },
      provider: this.name,
      platform: data?.provider ?? null,
    }
  }

  async *chatStream(request) {
    this.assertSupports(OPERATIONS.CHAT_STREAM)
    const body = { ...buildChatBody(request), stream: true }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.CHAT_STREAM },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.CHAT_STREAM)
    const reader = response.body?.getReader?.()
    if (!reader) throw new ProviderError('gateway returned no readable stream', { code: 'malformed_response' })
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
          const delta = chunk?.choices?.[0]?.delta?.content
          if (delta) yield String(delta)
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  async embed({ model, input, dimensions }) {
    this.assertSupports(OPERATIONS.EMBED)
    const inputs = Array.isArray(input) ? input : [input]
    const body = { ...(model ? { model } : {}), input: inputs, ...(dimensions ? { dimensions } : {}) }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/embeddings`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) },
      { operation: OPERATIONS.EMBED },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.EMBED)
    const data = await response.json()
    const rows = Array.isArray(data?.data) ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : []
    const vectors = rows.map((row) => row.embedding)
    if (vectors.length !== inputs.length || vectors.some((v) => !Array.isArray(v))) {
      throw new ProviderError('gateway returned malformed embeddings', { code: 'malformed_response', status: 502 })
    }
    return { vectors, model: data?.model ?? model ?? null, provider: this.name, platform: data?.provider ?? null, usage: data?.usage ?? null }
  }

  async rerank({ model, query, documents, topN }) {
    this.assertSupports(OPERATIONS.RERANK)
    if (!query) throw new ProviderError('rerank requires a query', { code: 'invalid_request', status: 400 })
    if (!Array.isArray(documents) || !documents.length) {
      throw new ProviderError('rerank requires a non-empty documents array', { code: 'invalid_request', status: 400 })
    }
    const body = { ...(model ? { model } : {}), query, documents, ...(topN ? { top_n: topN } : {}) }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/rerank`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body) },
      { operation: OPERATIONS.RERANK },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.RERANK)
    const data = await response.json()
    return { results: Array.isArray(data?.results) ? data.results : [], provider: this.name, raw: data }
  }

  /**
   * Image generation. Client-side validation mirrors the gateway's ImageBody so
   * we fail fast with a clear message instead of a 400 from the provider.
   * @returns {Promise<{images:Array, model:string, provider:string, created:number}>}
   */
  async generateImage(request) {
    this.assertSupports(OPERATIONS.IMAGE_GENERATE)
    const prompt = String(request.prompt ?? '').trim()
    if (!prompt) throw new ProviderError('image generation requires a non-empty prompt', { code: 'invalid_request', status: 400 })
    const n = request.n ?? undefined
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_IMAGE_N)) {
      throw new ProviderError(`n must be an integer in 1..${MAX_IMAGE_N}`, { code: 'invalid_request', status: 400 })
    }
    const body = { prompt, ...(request.model ? { model: request.model } : {}), ...(n ? { n } : {}), ...(request.size ? { size: request.size } : {}) }
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/images/generations`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.IMAGE_GENERATE, timeoutMs: request.timeoutMs ?? 300_000 },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.IMAGE_GENERATE)
    const data = await response.json()
    const images = Array.isArray(data?.data) ? data.data : []
    if (!images.length) throw new ProviderError('gateway returned an empty image list', { code: 'malformed_response', status: 502 })
    return { images, model: data?.model ?? null, platform: data?.provider ?? null, created: data?.created ?? null, provider: this.name }
  }

  /**
   * Video generation. Returns the raw MP4 bytes plus routing headers.
   *
   * IMPORTANT: pass `signal` to cancel. Aborting our fetch makes the gateway stop
   * polling the upstream provider (freellmapi routes/proxy.ts:812), so cancellation
   * is real and does not leave a charged job running.
   *
   * @returns {Promise<{video:Uint8Array, contentType:string, platform:string, modelId:string}>}
   */
  async generateVideo(request) {
    this.assertSupports(OPERATIONS.VIDEO_GENERATE)
    const prompt = String(request.prompt ?? '').trim()
    if (!prompt) throw new ProviderError('video generation requires a non-empty prompt', { code: 'invalid_request', status: 400 })

    const body = { prompt }
    if (request.model) body.model = request.model
    if (request.duration !== undefined) {
      if (!Number.isInteger(request.duration) || request.duration < VIDEO_DURATION_MIN || request.duration > VIDEO_DURATION_MAX) {
        throw new ProviderError(`duration must be an integer in ${VIDEO_DURATION_MIN}..${VIDEO_DURATION_MAX} seconds`, { code: 'invalid_request', status: 400 })
      }
      body.duration = request.duration
    }
    if (request.aspectRatio !== undefined) {
      if (!VIDEO_ASPECT_RATIOS.has(request.aspectRatio)) {
        throw new ProviderError(`aspect_ratio must be one of ${[...VIDEO_ASPECT_RATIOS].join(', ')}`, { code: 'invalid_request', status: 400 })
      }
      body.aspect_ratio = request.aspectRatio
    }
    if (request.image !== undefined) {
      let parsed
      try {
        parsed = new URL(request.image)
      } catch {
        throw new ProviderError('image must be an absolute URL', { code: 'invalid_request', status: 400 })
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ProviderError('image URL must be http(s)', { code: 'invalid_request', status: 400 })
      }
      body.image = parsed.toString()
    }
    if (request.seed !== undefined) {
      if (!Number.isInteger(request.seed) || request.seed < VIDEO_SEED_MIN || request.seed > VIDEO_SEED_MAX) {
        throw new ProviderError(`seed must be an integer in ${VIDEO_SEED_MIN}..${VIDEO_SEED_MAX}`, { code: 'invalid_request', status: 400 })
      }
      body.seed = request.seed
    }
    if (request.audio !== undefined) body.audio = Boolean(request.audio)

    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/videos/generations`,
      { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), signal: request.signal },
      { operation: OPERATIONS.VIDEO_GENERATE, timeoutMs: request.timeoutMs ?? this.videoTimeoutMs },
    )
    if (!response.ok) throw await readProviderError(response, this.name, OPERATIONS.VIDEO_GENERATE)

    const contentType = response.headers.get('content-type') ?? 'video/mp4'
    const buffer = Buffer.from(await response.arrayBuffer())
    return {
      video: new Uint8Array(buffer),
      byteLength: buffer.byteLength,
      contentType,
      platform: response.headers.get('x-provider') ?? null,
      modelId: response.headers.get('x-model') ?? null,
      provider: this.name,
    }
  }
}

/** Build the chat body, clamping to the ranges the gateway actually validates. */
export function buildChatBody(request) {
  const body = { messages: request.messages }
  if (request.model) body.model = request.model
  if (request.temperature != null) body.temperature = clamp(Number(request.temperature), 0, 2)
  if (request.topP != null) body.top_p = clamp(Number(request.topP), 0, 1)
  if (request.maxTokens != null) body.max_tokens = Math.max(1, Math.trunc(Number(request.maxTokens)))
  if (Array.isArray(request.stop) || typeof request.stop === 'string') body.stop = request.stop
  if (Array.isArray(request.tools) && request.tools.length) body.tools = request.tools
  if (request.toolChoice != null) body.tool_choice = request.toolChoice
  if (request.parallelToolCalls != null) body.parallel_tool_calls = Boolean(request.parallelToolCalls)
  if (request.responseFormat) body.response_format = request.responseFormat
  return body
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
