// Individually specified DeepSeek API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'deepseek_chat'
export const defaultBaseUrl = 'https://api.deepseek.com'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'DeepSeek', docsUrl: 'https://api-docs.deepseek.com/api/list-models/',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
