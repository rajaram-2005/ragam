// Individually specified Together AI API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'together_chat'
export const defaultBaseUrl = 'https://api.together.xyz/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Together AI', docsUrl: 'https://docs.together.ai/reference/chat-completions',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: [''],
  includeModel: (record) => !record?.type || record.type === 'chat',
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
