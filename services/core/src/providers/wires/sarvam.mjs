// Sarvam AI Open-Source Models Chat API: OpenAI-compatible request/response contract.
// Chat Completions (Beta access required): https://docs.sarvam.ai/api-reference/chat/chat-completions-v2
// Deployment-specific model discovery: https://docs.sarvam.ai/api-reference/open-source/models
// Sarvam documents the api-subscription-key header for these endpoints; do not assume a model is
// available merely because the API docs list it—the authenticated deployment list is authoritative.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'sarvam_chat'
export const defaultBaseUrl = 'https://api.sarvam.ai/v2'
export const adapter = createOpenAICompatibleAdapter({
  wire,
  provider: 'Sarvam AI Open-Source Models',
  docsUrl: 'https://docs.sarvam.ai/api-reference/chat/chat-completions-v2',
  modelPath: '/models',
  chatPath: '/chat/completions',
  modelShapes: ['data'],
  apiKeyHeader: 'api-subscription-key',
  omitBearer: true,
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
