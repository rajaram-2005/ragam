// Adobe Firefly Services: OAuth 2.0 client credentials + image generation.
//
// Verified against the official documentation on 2026-10-17:
//   https://developer.adobe.com/firefly-services/docs/firefly-api/getting-started/ — every
//     call needs an Adobe IMS access token and the client id in `x-api-key`.
//   https://developer.adobe.com/firefly-services/docs/guides/get-started — the token is
//     obtained with `POST https://ims-na1.adobelogin.com/ims/token/v3`,
//     `grant_type=client_credentials`, and the scopes
//     `openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis`.
//   https://developer.adobe.com/firefly-services/docs/firefly-api/api/ — `POST
//     https://firefly-api.adobe.io/v3/images/generate` with `X-Api-Key` and `Bearer`
//     credentials; the response carries `outputs[].image.url`.
//
// Why a JSON credential instead of a single API key: Firefly has no API key. The client id
// is public and the client secret is the credential; the pair is what IMS exchanges for a
// 24-hour token. A single opaque field would have to hide a separator convention, and a user
// pasting one value into a field labelled "API key" would get an authentication failure with
// no clue which half was wrong. The credential is validated at save time, compacted, and
// sealed by the same AES-256-GCM store as every other connection.
//
// Token caching is per client id and bounded to this process. A token is never written to a
// file, a log, an API response or the audit ledger; it exists in memory only and is refreshed
// 60 seconds before Adobe says it expires.

import { failure } from '../../online/failure.mjs'
import {
  assertPrompt, downloadMedia, firstUrl,
  IMAGE_MAX_BYTES,
} from './media-common.mjs'

export const wire = 'firefly_images'
export const credential = 'client_credentials'
export const modality = 'image'

export const SIZES = Object.freeze(['1024x1024', '1536x1024', '1024x1536', 'auto'])
export const MODELS = Object.freeze(['image3', 'image4', 'image4_ultra'])
export const TOKEN_ORIGIN = 'https://ims-na1.adobelogin.com'
export const SCOPES = 'openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis'

const tokens = new Map()

/** Validate and compact the two-part credential. Never returns a sealed value. */
export function readCredential(value) {
  let parsed
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value } catch { parsed = null }
  const clientId = parsed?.clientId ?? parsed?.client_id
  const clientSecret = parsed?.clientSecret ?? parsed?.client_secret
  const clean = (part) => typeof part === 'string' && part.length > 0 && part.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(part)
  if (!clean(clientId) || !clean(clientSecret)) {
    throw failure('invalid_key', 'Adobe Firefly needs {"clientId":"…","clientSecret":"…"} from the Adobe Developer Console.', 400)
  }
  return { clientId, clientSecret }
}

export async function models() {
  return [...MODELS]
}

async function accessToken(transport, config, parsed) {
  const cached = tokens.get(parsed.clientId)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  // The token exchange is form-encoded and goes to Adobe IMS, which is not the Firefly API
  // origin. It is sent as a keyless `custom` destination so the gateway's own credential
  // logic cannot attach the client secret as a bearer token it would then have to trust.
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: parsed.clientId,
    client_secret: parsed.clientSecret,
    scope: SCOPES,
  }).toString()
  const response = await transport({
    ...config, id: 'custom', kind: 'custom', baseUrl: TOKEN_ORIGIN, apiKey: null,
  }, '/ims/token/v3', {
    headers: {},
    body: form,
    contentType: 'application/x-www-form-urlencoded',
    maxResponseBytes: 64 * 1024,
  })
  if (typeof response?.access_token !== 'string' || !response.access_token) {
    throw failure('provider_auth_failed', 'Adobe IMS returned no access token. Check the client id, secret and Firefly API entitlement.', 502)
  }
  const ttl = Number.isFinite(response.expires_in) ? Math.max(60, response.expires_in) * 1000 : 23 * 3600_000
  tokens.set(parsed.clientId, { token: response.access_token, expiresAt: Date.now() + ttl })
  if (tokens.size > 32) for (const [key, entry] of tokens) if (entry.expiresAt <= Date.now()) tokens.delete(key)
  return response.access_token
}

export async function generate(transport, config, { model, prompt, size, signal, trustedOrigins = [] }) {
  assertPrompt(prompt)
  if (!MODELS.includes(model)) throw failure('invalid_model', `Firefly model must be one of ${MODELS.join(', ')}.`, 400)
  if (size !== undefined && !SIZES.includes(size)) throw failure('invalid_parameters', `Size must be one of ${SIZES.join(', ')}.`, 400)

  let parsed
  try { parsed = JSON.parse(config.apiKey) } catch { throw failure('provider_not_configured', 'The saved Firefly credential is not a client-id/secret document. Save it again.', 503) }
  const token = await accessToken(transport, config, parsed)
  const [width, height] = String(size ?? '').split('x').map(Number)
  const data = await transport(config, '/v3/images/generate', {
    headers: {
      'x-api-key': parsed.clientId,
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-model-version': model,
    },
    signal,
    body: {
      prompt,
      numVariations: 1,
      ...(Number.isFinite(width) && Number.isFinite(height) ? { size: { width, height } } : {}),
    },
    maxResponseBytes: 4 * 1024 * 1024,
  })

  const output = Array.isArray(data?.outputs) ? data.outputs[0] : null
  const uri = firstUrl(output?.image?.url, data?.images?.[0]?.url)
  if (!uri) throw failure('invalid_completion', 'Firefly returned no image URL.', 502)
  const file = await downloadMedia(transport, config, uri, {
    signal, kind: 'image', trustedOrigins, maxBytes: IMAGE_MAX_BYTES,
  })
  return {
    bytes: file.bytes,
    model,
    revisedPrompt: typeof output?.prompt === 'string' ? output.prompt : null,
    contentType: file.contentType,
    usage: null,
  }
}
