// Baidu Qianfan OpenAI-compatible Chat API.
// Official model discovery: GET https://qianfan.baidubce.com/v2/models
// Official chat: POST https://qianfan.baidubce.com/v2/chat/completions
// The authenticated catalogue returns model type/status metadata; include chat models unless the
// catalogue explicitly marks them offline. This is a fixture-tested contract, not live Baidu access.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

export const wire = 'baidu_qianfan_chat'
export const defaultBaseUrl = 'https://qianfan.baidubce.com/v2'
export const adapter = createOpenAICompatibleAdapter({
  wire,
  provider: 'Baidu Qianfan',
  docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
  modelPath: '/models',
  chatPath: '/chat/completions',
  modelShapes: ['data'],
  includeModel: (record) => record?.type === 'chat' && record?.status !== 'offline',
  streamUsage: false,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
