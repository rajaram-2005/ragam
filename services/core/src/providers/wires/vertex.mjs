// Google Vertex AI (Gemini models), OAuth 2.0 service-account credentials.
//
// Verified against the official references (2026-10-17):
//   https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations — the regional
//       endpoint is `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/
//       {location}/publishers/google/models/{model}:generateContent`, authenticated with
//       `Authorization: Bearer <OAuth 2.0 access token>`.
//   https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1beta1/publishers.models/list —
//       `GET /v1beta1/publishers/google/models` -> { publisherModels, nextPageToken }; v1 has no
//       list method, which is why discovery uses v1beta1 while generation uses v1.
//   https://developers.google.com/identity/protocols/oauth2/service-account — the service-account
//       JWT assertion grant exchanged at https://oauth2.googleapis.com/token.
//
// The credential is the downloaded service-account JSON itself, stored in the connection's
// encrypted slot after validation and compaction. A JSON object rather than an API key because
// Vertex's prediction endpoints do not accept API keys for this flow: they require a principal,
// and the service account is the principal. The private key never leaves the Core host; only the
// short-lived access token does, and only to `aiplatform.googleapis.com`.

import { createSign, createHash } from 'node:crypto'
import { failure } from '../../online/failure.mjs'
import { bodyFor, textOf, usageOf, blockedMessage } from './gemini.mjs'
import { unique } from './common.mjs'

export const wire = 'gcp_vertex'
export const credential = 'service_account'

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const MAX_PAGES = 20
const PAGE_SIZE = 100

/** Validate and normalise the service-account JSON. Called at save time and on every use. */
export function readCredential(value) {
  let parsed
  try { parsed = JSON.parse(value) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw failure('invalid_credential', 'Vertex needs the service-account JSON file, not an API key.', 400)
  }
  const { type, project_id, client_email, private_key, token_uri, location } = parsed
  if (type !== undefined && type !== 'service_account') {
    throw failure('invalid_credential', 'This is not a service-account credential (its `type` is not `service_account`).', 400)
  }
  if (typeof project_id !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project_id)) {
    throw failure('invalid_credential', 'project_id is missing or is not a Google Cloud project id.', 400)
  }
  if (typeof client_email !== 'string' || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(client_email)) {
    throw failure('invalid_credential', 'client_email must be a service-account address ending in .gserviceaccount.com.', 400)
  }
  if (typeof private_key !== 'string' || !private_key.includes('-----BEGIN PRIVATE KEY-----') || !private_key.includes('-----END PRIVATE KEY-----') || private_key.length > 8192) {
    throw failure('invalid_credential', 'private_key must be the PEM private key from the service-account JSON.', 400)
  }
  if (token_uri !== undefined && (typeof token_uri !== 'string' || token_uri.length > 300)) {
    throw failure('invalid_credential', 'token_uri must be a URL.', 400)
  }
  if (location !== undefined && (typeof location !== 'string' || !/^[a-z0-9-]{2,40}$/.test(location))) {
    throw failure('invalid_credential', 'location must look like us-central1.', 400)
  }
  return {
    type: 'service_account',
    project_id,
    client_email,
    private_key,
    ...(token_uri ? { token_uri } : {}),
    ...(location ? { location } : {}),
  }
}

const credentialOf = (config) => readCredential(config.apiKey)

/** `${location}-aiplatform.googleapis.com`, or the global host. */
function locationOf(config, parsed) {
  if (parsed.location) return parsed.location
  const host = new URL(config.baseUrl).hostname
  const regional = /^([a-z0-9-]+)-aiplatform\.googleapis\.com$/.exec(host)
  if (regional) return regional[1]
  if (host === 'aiplatform.googleapis.com') return 'global'
  // A private or test endpoint has no region in its name. Guessing us-central1 would send the
  // request to one the user did not choose; the credential can name the location explicitly.
  throw failure('invalid_credential', 'Cannot derive a Vertex location from this endpoint; add "location" to the credential.', 400)
}

/** The token endpoint: Google's, or the configured origin when a contract test serves both. */
function tokenUriOf(config, parsed) {
  if (!parsed.token_uri) return DEFAULT_TOKEN_URI
  const target = new URL(parsed.token_uri)
  const sameOrigin = target.origin === new URL(config.baseUrl).origin
  if (target.hostname !== 'oauth2.googleapis.com' && !sameOrigin) {
    throw failure('invalid_credential', 'token_uri must be https://oauth2.googleapis.com/token or the configured endpoint origin.', 400)
  }
  return target.href
}

// Access tokens live one hour. Cached per credential so a chat request does not pay for a token
// exchange every time; bounded so a stream of distinct credentials cannot grow memory forever.
const tokenCache = new Map()
const CACHE_LIMIT = 16
// The audience is part of the cache key: a token minted for one token endpoint must not be reused
// against another, and two installations configured with the same key are still different targets.
const cacheKey = (parsed, uri) => createHash('sha256').update(`${parsed.client_email}\n${uri}\n${parsed.private_key}`).digest('hex')

async function accessToken(transport, config, parsed, signal) {
  const uri = tokenUriOf(config, parsed)
  const key = cacheKey(parsed, uri)
  const cached = tokenCache.get(key)
  if (cached && cached.expires > Date.now() + 60_000) return cached.token

  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iss: parsed.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 }))
  const signature = base64url(createSign('RSA-SHA256').update(`${header}.${claims}`).sign(parsed.private_key))
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString()
  const target = new URL(uri)
  const data = await transport({ ...config, baseUrl: target.origin }, target.pathname, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    contentType: 'application/x-www-form-urlencoded',
    body,
    signal,
  })
  if (typeof data?.access_token !== 'string' || !data.access_token) {
    throw failure('provider_auth_failed', 'Vertex did not return an access token for this service account.', 502)
  }
  const expires = Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000
  if (tokenCache.size >= CACHE_LIMIT) tokenCache.delete(tokenCache.keys().next().value)
  tokenCache.set(key, { token: data.access_token, expires })
  return data.access_token
}

const base64url = (value) => Buffer.from(value).toString('base64url')

export async function models(transport, config) {
  const parsed = credentialOf(config)
  const token = await accessToken(transport, config, parsed)
  const names = []
  let pageToken = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = `?pageSize=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const data = await transport(config, `/v1beta1/publishers/google/models${query}`, { headers: { authorization: `Bearer ${token}` } })
    if (!Array.isArray(data?.publisherModels)) {
      throw failure('invalid_model_list', 'Vertex returned no publisher-model list.', 502)
    }
    names.push(...data.publisherModels.map((model) => String(model?.name ?? '').split('/').pop()))
    const next = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null
    if (next !== null && next === pageToken) throw failure('invalid_model_list', 'Vertex repeated a page token.', 502)
    pageToken = next
    if (!pageToken) break
  }
  if (pageToken) throw failure('model_list_too_large', 'Vertex returned more model pages than this build will read.', 502)
  // This product chats. Embedding, image and video publisher models are listed by the same
  // endpoint and would appear as selectable models that every request rejects.
  const models = unique(names.filter((name) => /^gemini-/.test(name) && !/(embedding|imagen|image|veo|tts|audio)/.test(name)))
  if (models.length > 500) throw failure('model_list_too_large', 'Vertex listed more than 500 chat models.', 502)
  return models
}

export async function chat(transport, config, { model, messages, maxTokens, temperature, signal, onText }) {
  const parsed = credentialOf(config)
  if (!model) throw failure('invalid_model', 'Choose a Vertex model.', 400)
  const id = String(model).replace(/^publishers\/google\/models\//, '').replace(/^models\//, '')
  const location = locationOf(config, parsed)
  const token = await accessToken(transport, config, parsed, signal)
  const path = `/v1/projects/${encodeURIComponent(parsed.project_id)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(id)}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
  const body = bodyFor({ messages, maxTokens, temperature })
  const headers = { authorization: `Bearer ${token}` }

  if (!onText) {
    const data = await transport(config, path, { headers, signal, body })
    const text = textOf(data)
    if (!text) throw failure('invalid_completion', blockedMessage(data), 502)
    return { text, model: data?.modelVersion ?? null, usage: usageOf(data) }
  }

  let text = ''
  let reported = null
  let usage = null
  let sawCandidate = false
  let finished = false
  const onFrame = (frame) => {
    if (frame?.modelVersion) reported = frame.modelVersion
    if (frame?.usageMetadata) usage = usageOf(frame)
    if (Array.isArray(frame?.candidates) && frame.candidates.length) sawCandidate = true
    if (frame?.candidates?.[0]?.finishReason) finished = true
    const delta = textOf(frame)
    if (delta) { text += delta; onText(delta) }
  }
  await transport(config, path, { headers, signal, body, onFrame, doneOnEnd: true })
  if (!sawCandidate) throw failure('invalid_completion', 'Vertex returned no candidate. No model was substituted.', 502)
  // The body ending is not the protocol's completion signal; the final candidate's finish reason
  // is. A clean early close is an interruption, not a shorter answer.
  if (!finished) throw failure('provider_interrupted', 'Vertex stream ended without a finish reason.', 502)
  return { text, model: reported, usage }
}
