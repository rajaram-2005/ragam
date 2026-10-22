// Individually specified Mistral AI API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'mistral_chat'
export const defaultBaseUrl = 'https://api.mistral.ai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Mistral AI', docsUrl: 'https://docs.mistral.ai/api/endpoint/chat/',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data', ''],
  modelShapes: ['data', 'models', ''],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
