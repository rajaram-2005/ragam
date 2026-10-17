// Azure OpenAI (Microsoft Foundry Models), v1 API.
//
// Verified against the official reference (2026-10-17):
//   https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle — the v1 API is
//       `https://{resource}.openai.azure.com/openai/v1/`, takes no `api-version`, and names the
//       deployment in the request body's `model` field rather than in the path.
//   https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/models — `GET
//       {endpoint}/openai/v1/models`.
//   https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat — `POST
//       {endpoint}/openai/v1/chat/completions`, with `api-key` or `Authorization: Bearer` auth.
//
// Why this is a wire and not "OpenAI with a different base URL": the credential header is
// `api-key`, not `authorization`, and the endpoint is `/openai/v1/...`, not `/v1/...`. An OpenAI
// base pointed at an Azure resource would send the key to a header Azure ignores and a path Azure
// does not serve, and the failure would look like a bad key. The response and stream shapes are
// OpenAI's, and the contract test pins that too.

import { failure } from '../../online/failure.mjs'
import { idsFromData, tokens } from './common.mjs'

export const wire = 'azure_openai'
export const credential = 'api_key'

const headers = (config) => ({ 'api-key': config.apiKey })
const MAX_MODELS = 500

export async function models(transport, config) {
  const data = await transport(config, '/openai/v1/models', { headers: headers(config) })
  if (!Array.isArray(data?.data) || data.data.length > MAX_MODELS) {
    throw failure('invalid_model_list', 'Azure OpenAI must return at most 500 model records.', 502)
  }
  // This is the resource's model list, not its deployment list: Azure exposes deployment listing
  // only through the ARM management plane, with an Entra token this connection does not hold. The
  // v1 API names the *deployment* in the body's `model` field, so a listed id works when the
  // deployment carries the same name. The UI and docs/27 say that instead of implying discovery
  // found deployments.
  return idsFromData(data)
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  if (!model) throw failure('invalid_model', 'Choose an Azure OpenAI deployment.', 400)
  const body = {
    model,
    messages: (messages ?? []).map(({ role, content }) => ({ role, content })),
    max_tokens: maxTokens,
    stream: Boolean(onText),
    ...(Number.isFinite(temperature) ? { temperature } : {}),
  }

  if (!onText) {
    const data = await transport(config, '/openai/v1/chat/completions', { headers: headers(config), signal, body })
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) {
      throw failure('invalid_completion', 'Azure OpenAI returned no text completion. No model was substituted.', 502)
    }
    return { text, model: data?.model ?? null, usage: usageOf(data?.usage) }
  }

  let text = ''
  let reported = null
  let usage = null
  const onFrame = (frame) => {
    if (frame?.model) reported = frame.model
    if (frame?.usage) usage = usageOf(frame.usage) ?? usage
    const delta = frame?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') { text += delta; onText(delta) }
  }
  await transport(config, '/openai/v1/chat/completions', { headers: headers(config), signal, body, onFrame })
  return { text, model: reported, usage }
}

function usageOf(usage) {
  return tokens(usage?.prompt_tokens, usage?.completion_tokens)
}
