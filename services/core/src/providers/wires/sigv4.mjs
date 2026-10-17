// AWS Signature Version 4 for the one service this build signs: Bedrock.
//
// Written rather than imported because the alternative is adding an AWS SDK — tens of megabytes of
// dependency for one signing algorithm that fits in a page — and because the transport already owns
// the network. The algorithm is specified at
//   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// and this file's contract test checks it against the worked example AWS publishes, so a change to
// it that no longer signs a real request fails rather than quietly producing an Authorization
// header Bedrock rejects.
//
// Scope: header-based signing, no query-string signing (Bedrock's `Converse` and
// `ListFoundationModels` need none), no chunked uploads, no S3 `UNSIGNED-PAYLOAD`.

import { createHash, createHmac } from 'node:crypto'

const HASH = 'SHA256'
const ALGORITHM = 'AWS4-HMAC-SHA256'

const sha256 = (value) => createHash(HASH).update(value).digest('hex')
const hmac = (key, value) => createHmac(HASH, key).update(value).digest()

/**
 * RFC 3986 encoding, as SigV4 requires: every byte except `A-Z a-z 0-9 - . _ ~` is percent-encoded,
 * and `/` is kept as a separator in the path.
 */
export function uriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** A `YYYYMMDDTHHMMSSZ` timestamp and the `YYYYMMDD` date derived from it. */
export function amzDate(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { stamp: iso, date: iso.slice(0, 8) }
}

/**
 * Sign a request and return the headers to send. `host` is taken from the URL the transport will
 * call, because it is part of the canonical request and a mismatch is an invalid signature.
 *
 * `now` is injectable so the contract test can sign a fixed moment; production never passes it.
 */
export function signV4({ method, url, headers = {}, body = '', credentials, service = 'bedrock', now = new Date() }) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials
  if (!accessKeyId || !secretAccessKey) throw new Error('SigV4 requires an access key id and a secret access key.')
  const target = new URL(url)
  const { stamp, date } = amzDate(now)
  const region = regionOf(target.hostname, credentials.region)

  const canonical = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    if (key === 'authorization' || key === 'host' || key.startsWith('x-amz-')) continue
    canonical[key] = String(value).trim().replace(/\s+/g, ' ')
  }
  const signed = { host: target.host, 'x-amz-date': stamp, ...canonical }
  if (sessionToken) signed['x-amz-security-token'] = sessionToken

  const names = Object.keys(signed).sort()
  const canonicalHeaders = names.map((name) => `${name}:${signed[name]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalUri = target.pathname.split('/').map((segment) => {
    // Decode first, then encode once, so a model id containing `:` signs as `%3A` either way. A
    // malformed escape from a provider-supplied id is left as sent rather than thrown out of the
    // request: the signature will not verify, which is the correct outcome.
    try { return uriEncode(decodeURIComponent(segment)) } catch { return uriEncode(segment) }
  }).join('/') || '/'
  const query = [...target.searchParams.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256(body ?? ''),
  ].join('\n')

  const scope = `${date}/${region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, stamp, scope, sha256(canonicalRequest)].join('\n')
  // The chain is date → region → service → "aws4_request", in that order: each HMAC's output is
  // the next one's key. Reversing it still produces a plausible-looking signature, which is why
  // the published test vector below exists.
  const signingKey = [date, region, service, 'aws4_request'].reduce(
    (key, part) => hmac(key, part), Buffer.from(`AWS4${secretAccessKey}`))
  const signature = createHmac(HASH, signingKey).update(stringToSign).digest('hex')

  return {
    ...headers,
    host: target.host,
    'x-amz-date': stamp,
    ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** `bedrock-runtime.us-east-1.amazonaws.com` → `us-east-1`; an explicit region wins. */
export function regionOf(hostname, explicit) {
  if (explicit) return explicit
  const match = /^(?:bedrock-runtime|bedrock)(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(hostname)
  if (!match) throw new Error('Cannot derive an AWS region from this endpoint; include `region` in the credential.')
  return match[1]
}
