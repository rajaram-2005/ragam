// Individually specified Novita AI API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'novita_chat'
export const defaultBaseUrl = 'https://api.novita.ai/openai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Novita AI', docsUrl: 'https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
