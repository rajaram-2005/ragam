// Individually specified Alibaba Cloud Model Studio contract adapter.
// Official Chat docs: https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope
// Separate model-list API: https://help.aliyun.com/en/model-studio/list-models.
// Regional/workspace endpoints and API keys differ; the default is the documented Singapore host.
import { failure } from '../../online/failure.mjs'
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'

const textModality = (value) => Array.isArray(value) && value.some((item) => String(item).toLowerCase() === 'text')

async function fetchTextModels(transport, config, headers) {
  const records = []
  let total = null
  const pageSize = 100
  for (let pageNo = 1; pageNo <= 5; pageNo += 1) {
    const payload = await transport(config, `/api/v1/models?page_no=${pageNo}&page_size=${pageSize}`, { headers })
    const output = payload?.output
    if (!Array.isArray(output?.models) || !Number.isSafeInteger(output?.total) || output.total < 0) {
      throw failure('invalid_model_list', 'Alibaba Cloud Model Studio returned an unsupported model-list shape.', 502)
    }
    total = output.total
    records.push(...output.models.filter((record) =>
      textModality(record?.inference_metadata?.request_modality)
      && textModality(record?.inference_metadata?.response_modality)))
    if ((pageNo * pageSize) >= total) return { models: records }
  }
  if (total > pageSize * 5) {
    throw failure('invalid_model_list', 'Alibaba Cloud Model Studio model list exceeded the adapter page bound.', 502)
  }
  return { models: records }
}

export const wire = 'alibaba_model_studio_chat'
export const defaultBaseUrl = 'https://dashscope-intl.aliyuncs.com'
export const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Alibaba Cloud Model Studio', docsUrl: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope',
  modelPath: '/api/v1/models?page_no=1&page_size=100',
  chatPath: '/compatible-mode/v1/chat/completions',
  modelShapes: ['models'],
  fetchModelList: fetchTextModels,
  streamUsage: true,
})
export const { models, modelCatalogue, chat, complete, stream, validateConfig, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
