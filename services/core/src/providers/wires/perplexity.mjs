// Perplexity Router is a gateway-routed API with its own documented endpoint paths. Models are
// listed from /v1/models; completions use /router/v1/chat/completions (not a guessed /v1 route).
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'perplexity_router'
export const defaultBaseUrl = 'https://api.perplexity.ai'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Perplexity Router',
  docsUrl: 'https://docs.perplexity.ai/api-reference/gateway-chat-completions-post',
  modelPath: '/v1/models', chatPath: '/router/v1/chat/completions',
  modelShapes: ['data'],
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
