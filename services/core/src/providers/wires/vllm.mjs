// Individually specified vLLM API contract adapter.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'vllm_chat'
export const defaultBaseUrl = 'http://<vllm-host>:8000/v1'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'vLLM', docsUrl: 'https://docs.vllm.ai/en/latest/serving/online_serving/',
  modelPath: '/models', chatPath: '/chat/completions',
  modelShapes: ['data'],
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
