// Individually specified SiliconFlow API contract adapter.
// Official Chat docs: https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions
// Model list: https://docs.siliconflow.com/en/api-reference/models/get-model-list.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'siliconflow_chat'
export const defaultBaseUrl = 'https://api.siliconflow.com/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'SiliconFlow', docsUrl: 'https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions',
  modelPath: '/models?sub_type=chat', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
