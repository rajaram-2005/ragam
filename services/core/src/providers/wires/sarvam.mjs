// Sarvam AI Open-Source Models Chat API: OpenAI-compatible request/response contract.
// Chat Completions (Beta access required): https://docs.sarvam.ai/api-reference/chat/chat-completions-v2
// Deployment-specific model discovery: https://docs.sarvam.ai/api-reference/open-source/models
// The Chat endpoint says api-subscription-key is required; its auth section also lists API-key
// header OR Bearer alternatives. This adapter chooses the documented API-key-header option and
// does not send Bearer. Do not assume a model is available merely because docs list it—the
// authenticated deployment list is authoritative.
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
export const { chatInputKinds, chatNativeSearch, chatTools } = adapter
