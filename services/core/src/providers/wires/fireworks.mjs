// Fireworks uses the documented OpenAI-compatible inference API. Its control-plane model list is
// account-scoped and cursor-paginated, so discovery is bounded and never silently truncated.
import { createOpenAICompatibleAdapter } from './openai-compatible.mjs'
import { failure } from '../../online/failure.mjs'

export const wire = 'fireworks_chat'
function accountFor(config) {
  const account = config.options?.accountId
  if (typeof account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(account)) {
    throw failure('provider_config_required', 'Fireworks requires an account ID to list models. Configure it in Provider Settings.', 400)
  }
  return account
}
async function fetchModelList(transport, config, headers) {
  const account = encodeURIComponent(accountFor(config))
  const models = new Map()
  let token = null, pages = 0
  do {
    if (pages >= 3 || models.size >= 500) throw failure('invalid_model_list', 'Fireworks has more than 500 accessible models; narrow the account catalogue before continuing.', 502)
    const query = new URLSearchParams({ pageSize: '200' })
    if (token) query.set('pageToken', token)
    const page = await transport(config, `/v1/accounts/${account}/models?${query}`, { headers })
    if (!Array.isArray(page?.models)) throw failure('invalid_model_list', 'Fireworks returned an unsupported model-list shape.', 502)
    if (page.models.length > 200) throw failure('invalid_model_list', 'Fireworks exceeded the requested model page size.', 502)
    for (const row of page.models) {
      if (typeof row?.name === 'string' && row.name.length <= 240) models.set(row.name, row)
      else if (typeof row?.id === 'string' && row.id.length <= 240) models.set(row.id, row)
    }
    token = typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null
    pages += 1
    if (token && models.size >= 500) throw failure('invalid_model_list', 'Fireworks model listing exceeds the 500-model safety limit.', 502)
  } while (token)
  return { models: [...models.values()] }
}
const adapter = createOpenAICompatibleAdapter({
  wire, provider: 'Fireworks AI',
  docsUrl: 'https://docs.fireworks.ai/api-reference/post-chatcompletions',
  modelPath: (config) => `/v1/accounts/${encodeURIComponent(accountFor(config))}/models`,
  fetchModelList,
  chatPath: '/inference/v1/chat/completions',
  modelShapes: ['models', 'data'],
})
export const defaultBaseUrl = 'https://api.fireworks.ai'
export const { models, modelCatalogue, chat, complete, stream, testConnection, getModelCapabilities, cancel, normalizeError } = adapter
export const validateConfig = (config) => {
  if (config.options?.accountId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.options.accountId)) {
    throw failure('invalid_provider_config', 'Fireworks account ID contains unsupported characters.')
  }
  return true
}
