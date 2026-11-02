// Individually specified MiniMax OpenAI-compatible API contract adapter.
// Official Chat docs: https://platform.minimax.io/docs/api-reference/text-openai-api
// Model list: https://platform.minimax.io/docs/api-reference/models/openai/list-models
// For a China-region account, the documented API host is api.minimaxi.com instead.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'minimax_chat'
export const defaultBaseUrl = 'https://api.minimax.io/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'MiniMax', docsUrl: 'https://platform.minimax.io/docs/api-reference/text-openai-api',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
