// Individually specified OpenRouter API contract adapter. Explicit native search uses its Responses
// API `openrouter:web_search` server tool; see https://openrouter.ai/docs/api_reference/responses/web-search.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'openrouter_chat'
export const defaultBaseUrl = 'https://openrouter.ai/api/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'OpenRouter', docsUrl: 'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
  responsesSearchToolType: 'openrouter:web_search',
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
export const { chatInputKinds, chatNativeSearch, chatTools } = adapter
