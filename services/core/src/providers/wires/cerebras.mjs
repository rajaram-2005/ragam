// Individually specified Cerebras Inference API contract adapter.
// Official Chat: POST /v1/chat/completions, Bearer authentication. The model list is documented at
// https://inference-docs.cerebras.ai/api-reference/models/list-models.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'cerebras_chat'
export const defaultBaseUrl = 'https://api.cerebras.ai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Cerebras Inference', docsUrl: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
