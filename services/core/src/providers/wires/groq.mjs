// Individually specified Groq API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'groq_chat'
export const defaultBaseUrl = 'https://api.groq.com/openai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Groq', docsUrl: 'https://console.groq.com/docs/api-reference',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
