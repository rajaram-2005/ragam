// Individually specified DeepInfra OpenAI-compatible API contract adapter.
// Official Chat API and API overview: https://docs.deepinfra.com/api-reference/introduction
// The documented /v1/openai/models?filter=with_meta endpoint exposes tags so non-chat models can be excluded.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'deepinfra_chat'
export const defaultBaseUrl = 'https://api.deepinfra.com/v1/openai'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'DeepInfra', docsUrl: 'https://docs.deepinfra.com/api-reference/introduction',
  modelPath: '/models?filter=with_meta&sort_by=maf', chatPath: '/chat/completions',
  modelShapes: ['data'],
  includeModel: (record) => record?.metadata?.tags?.includes('chat') === true,
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
