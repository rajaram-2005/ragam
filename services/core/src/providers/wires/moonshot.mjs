// Individually specified Moonshot AI (Kimi) OpenAI-compatible Chat API adapter.
// Chat Completions: https://platform.kimi.ai/docs/api/chat
// Model discovery: https://platform.kimi.ai/docs/api/list-models
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'moonshot_chat'
export const defaultBaseUrl = 'https://api.moonshot.ai/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire,
  provider: 'Moonshot AI (Kimi)',
  docsUrl: 'https://platform.kimi.ai/docs/api/chat',
  modelPath: '/models',
  chatPath: '/chat/completions',
  modelShapes: ['data'],
  // Moonshot documents usage in streamed completion chunks; do not ask for an
  // OpenAI-specific stream_options extension that its contract does not require.
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
