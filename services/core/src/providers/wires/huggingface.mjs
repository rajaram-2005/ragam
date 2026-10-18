// Individually specified Hugging Face Inference Providers API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'huggingface_chat'
export const defaultBaseUrl = 'https://router.huggingface.co/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Hugging Face Inference Providers', docsUrl: 'https://huggingface.co/docs/inference-providers/tasks/chat-completion',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
