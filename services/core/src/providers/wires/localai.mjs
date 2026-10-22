// Individually specified LocalAI API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'localai_chat'
export const defaultBaseUrl = 'http://<localai-host>:8080/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'LocalAI', docsUrl: 'https://localai.io/docs/features/openai-functions/',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
