// Amazon Bedrock, Converse API, signed with AWS Signature Version 4.
//
// Verified against the official references (2026-10-17):
//   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
//     POST /model/{modelId}/converse, body { messages, system?, inferenceConfig? }, response
//     { output: { message: { content: [{ text }] } }, usage: { inputTokens, outputTokens,
//     totalTokens }, stopReason }
//   https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListFoundationModels.html
//     GET /foundation-models -> { modelSummaries: [{ modelId, outputModalities,
//     inferenceTypesSupported, modelLifecycle }] } on the control-plane host
//   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
//     the signing algorithm, checked against AWS's published worked example in sigv4.mjs
//
// Credentials are an IAM access key, not an API key: Bedrock authorises inference with IAM, and
// the request is signed, not bearer-authenticated. A Bedrock API key (a bearer token) is a
// different credential and is not accepted here — sending one as `accessKeyId` fails the shape
// check rather than producing a request that looks signed and is not.
//
// Streaming is not implemented: `ConverseStream` returns `application/vnd.amazon.eventstream`
// (a binary framing), while the transport parses SSE. The stream endpoint therefore delivers this
// provider's answer in a single `done` event. That is a limitation of this build, stated here
// rather than hidden behind a spinner.

import { failure } from '../../online/failure.mjs'
import { conversation, requireUserFirst, tokens, unique } from './common.mjs'
import { regionOf, signV4 } from './sigv4.mjs'

export const wire = 'aws_bedrock'
export const credential = 'aws_credentials'
export const streaming = false

/**
 * The credential is a small JSON object in the connection's encrypted slot:
 * `{ accessKeyId, secretAccessKey, sessionToken?, region? }`. It is validated once, at save time,
 * and stored compacted; it is never logged, returned or put in a URL.
 */
export function readCredential(value) {
  let parsed
  try { parsed = JSON.parse(value) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw failure('invalid_credential', 'Bedrock needs a JSON credential: {"accessKeyId","secretAccessKey"} plus optional "sessionToken" and "region".', 400)
  }
  const { accessKeyId, secretAccessKey, sessionToken, region } = parsed
  if (typeof accessKeyId !== 'string' || !/^[A-Z0-9]{16,64}$/.test(accessKeyId)) {
    throw failure('invalid_credential', 'accessKeyId must be an IAM access key id (16–64 upper-case letters and digits).', 400)
  }
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length < 32 || secretAccessKey.length > 128 || /\s/.test(secretAccessKey)) {
    throw failure('invalid_credential', 'secretAccessKey must be the 32–128 character IAM secret, with no spaces.', 400)
  }
  if (sessionToken !== undefined && (typeof sessionToken !== 'string' || !sessionToken || sessionToken.length > 4096 || /\s/.test(sessionToken))) {
    throw failure('invalid_credential', 'sessionToken must be the temporary-credential token, with no spaces.', 400)
  }
  if (region !== undefined && (typeof region !== 'string' || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))) {
    throw failure('invalid_credential', 'region must look like us-east-1.', 400)
  }
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}), ...(region ? { region } : {}) }
}

/** The control-plane host that serves model metadata, derived from the runtime endpoint. */
export function controlUrl(baseUrl) {
  const url = new URL(baseUrl)
  return `${url.protocol}//${url.host.replace(/^bedrock-runtime(-fips)?\./, (_, fips) => `bedrock${fips ?? ''}.`)}`
}

const credentialOf = (config) => readCredential(config.apiKey)

/** A signed request; the body is the exact string that is signed and sent. */
async function signed(transport, config, { method, url, body, signal }) {
  const credentials = credentialOf(config)
  // A region declared in the credential must agree with the endpoint it will sign for. Signing
  // with the wrong scope produces a request AWS rejects as an auth failure, which reads like a bad
  // key; refusing here names the actual mistake. A host with no derivable region (a private
  // endpoint) is allowed and relies on the declared region.
  let hostRegion = null
  try { hostRegion = regionOf(new URL(config.baseUrl).hostname, undefined) } catch { hostRegion = null }
  if (hostRegion && credentials.region && hostRegion !== credentials.region) {
    throw failure('invalid_credential', `The credential says ${credentials.region} but the endpoint is in ${hostRegion}.`, 400)
  }
  const headers = signV4({
    method,
    url,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ?? '',
    credentials,
    service: 'bedrock',
  })
  return transport({ ...config, baseUrl: new URL(url).origin }, `${new URL(url).pathname}${new URL(url).search}`, {
    headers, body, contentType: body ? 'application/json' : undefined, signal,
  })
}

export async function models(transport, config) {
  const base = controlUrl(config.baseUrl)
  const listed = await signed(transport, config, { method: 'GET', url: `${base}/foundation-models` })
  if (!Array.isArray(listed?.modelSummaries) || listed.modelSummaries.length > 1000) {
    throw failure('invalid_model_list', 'Bedrock must return at most 1000 model records.', 502)
  }
  const chat = listed.modelSummaries
    .filter((model) => (model?.outputModalities ?? []).includes('TEXT'))
    .filter((model) => (model?.inferenceTypesSupported ?? []).includes('ON_DEMAND'))
    .filter((model) => (model?.modelLifecycle?.status ?? 'ACTIVE') === 'ACTIVE')
    .map((model) => model?.modelId)

  // Cross-region inference profiles are not foundation models, and many current models are only
  // reachable through one. They are listed separately; a credential without permission to read
  // them still gets the foundation-model list rather than no models at all.
  let profiles = []
  try {
    const data = await signed(transport, config, { method: 'GET', url: `${base}/inference-profiles` })
    if (Array.isArray(data?.inferenceProfileSummaries) && data.inferenceProfileSummaries.length <= 1000) {
      profiles = data.inferenceProfileSummaries
        .filter((profile) => (profile?.status ?? 'ACTIVE') === 'ACTIVE')
        .map((profile) => profile?.inferenceProfileId)
    }
  } catch { profiles = [] }

  const models = unique([...chat, ...profiles])
  if (models.length > 500) throw failure('model_list_too_large', 'Bedrock listed more than 500 models.', 502)
  return models
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal }) {
  if (!model) throw failure('invalid_model', 'Choose a Bedrock model or inference profile.', 400)
  const { system, turns } = conversation(messages)
  requireUserFirst(turns, 'Bedrock')
  const body = JSON.stringify({
    ...(system ? { system: [{ text: system }] } : {}),
    messages: turns.map((turn) => ({ role: turn.role, content: [{ text: turn.content }] })),
    inferenceConfig: {
      maxTokens,
      ...(Number.isFinite(temperature) ? { temperature } : {}),
    },
  })
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/model/${encodeURIComponent(model)}/converse`)
  const data = await signed(transport, config, { method: 'POST', url: url.href, body, signal })

  const content = data?.output?.message?.content
  const text = Array.isArray(content)
    ? content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('')
    : ''
  if (!text) {
    const reason = typeof data?.stopReason === 'string' && /^[a-z_]{2,40}$/.test(data.stopReason) ? ` (${data.stopReason})` : ''
    throw failure('invalid_completion', `Bedrock returned no text${reason}. No model was substituted.`, 502)
  }
  return { text, model, usage: tokens(data?.usage?.inputTokens, data?.usage?.outputTokens) }
}
