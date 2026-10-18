// Individually specified OpenRouter API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'openrouter_chat'
export const defaultBaseUrl = 'https://openrouter.ai/api/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'OpenRouter', docsUrl: 'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
