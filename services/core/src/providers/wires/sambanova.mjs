// Individually specified SambaNova API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'sambanova_chat'
export const defaultBaseUrl = 'https://api.sambanova.ai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'SambaNova', docsUrl: 'https://docs.sambanova.ai/docs/api-reference/chat-completions/create-chat-based-completion',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
