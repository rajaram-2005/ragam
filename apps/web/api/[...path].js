// Same-origin API proxy for Vercel deployments.
//
// Browser requests stay relative to the Vercel site (/api/...). The upstream is a fixed
// operator-configured Render origin, never a URL supplied by the request. Keeping the browser
// and API on one origin preserves HttpOnly session cookies and avoids enabling CORS.
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const API_PREFIX = '/api/'
const BODY_LIMIT = 2 * 1024 * 1024
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const REQUEST_HEADERS = [
  'accept', 'content-type', 'cookie', 'origin', 'sec-fetch-site',
  'x-aetheris-request', 'last-event-id', 'user-agent', 'range', 'if-range',
]
const RESPONSE_HEADERS = [
  'content-disposition', 'content-range', 'content-security-policy', 'content-type',
  'etag', 'last-modified', 'retry-after', 'accept-ranges', 'x-accel-buffering',
  'x-content-type-options', 'x-request-id',
]

function originFromConfiguration(value, allowLoopbackForTests = false) {
  if (typeof value !== 'string' || !value.trim()) return null
  let url
  try { url = new URL(value) } catch { return null }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const localHttpAllowed = loopback && (allowLoopbackForTests || process.env.NODE_ENV === 'development')
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttpAllowed))
      || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  return url.origin
}

function jsonError(res, status, message, requestId) {
  if (res.headersSent) { res.destroy(); return }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-request-id', requestId)
  if (status === 405) res.setHeader('allow', [...METHODS].join(', '))
  const code = status === 503 ? 'core_unconfigured'
    : status >= 400 && status < 500 ? 'proxy_rejected' : 'core_unavailable'
  res.end(JSON.stringify({ error: code, message }))
}

function tooLarge() {
  const error = new Error('Request exceeds the 2 MiB Core limit.')
  error.status = 413
  return error
}

async function boundedBody(req) {
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) throw tooLarge()

  // Vercel's Node adapter may populate req.body before calling a function. Preserve a
  // raw string/buffer when supplied; re-encode parsed JSON objects for Core otherwise.
  if (req.body !== undefined) {
    const value = req.body
    const encoded = Buffer.isBuffer(value) ? value
      : value instanceof Uint8Array ? Buffer.from(value)
        : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
    if (encoded.length > BODY_LIMIT) throw tooLarge()
    return encoded
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw tooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function isSafeApiPath(pathname) {
  if (!pathname.startsWith(API_PREFIX)) return false
  for (const segment of pathname.split('/').slice(2)) {
    let decoded
    try { decoded = decodeURIComponent(segment) } catch { return false }
    if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) return false
  }
  return true
}

export async function proxyRequest(req, res, {
  coreOrigin = process.env.CORE_API_URL,
  allowLoopbackForTests = false,
  upstreamTimeoutMs = 58_000,
} = {}) {
  const requestId = randomUUID()
  res.setHeader('x-request-id', requestId)
  const upstreamOrigin = originFromConfiguration(coreOrigin, allowLoopbackForTests)
  if (!upstreamOrigin) return jsonError(res, 503, 'The Core API origin must be configured as an exact HTTPS origin.', requestId)

  if (!METHODS.has(req.method)) return jsonError(res, 405, 'HTTP method is not supported by the Core proxy.', requestId)
  if (typeof req.url !== 'string' || !req.url.startsWith('/')) return jsonError(res, 400, 'Invalid API path.', requestId)
  let incoming
  try { incoming = new URL(req.url, 'https://vercel.invalid') } catch { return jsonError(res, 400, 'Invalid API path.', requestId) }
  if (incoming.pathname.startsWith('//') || !isSafeApiPath(incoming.pathname)) {
    return jsonError(res, 404, 'Only safe /api routes are proxied.', requestId)
  }

  let body
  if (!['GET', 'HEAD'].includes(req.method)) {
    try { body = await boundedBody(req) } catch (error) {
      return jsonError(res, error.status ?? 400, error.status === 413 ? error.message : 'Could not read the request body.', requestId)
    }
  }

  const target = new URL(`${incoming.pathname}${incoming.search}`, upstreamOrigin)
  const headers = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  // Never accept a browser-supplied correlation id; this id is safe to log and is
  // echoed by Core so a failed public request can be followed across both services.
  headers.set('x-request-id', requestId)

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, upstreamTimeoutMs)
  req.on('aborted', () => controller.abort())
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel()
      return jsonError(res, 502, 'The Core API returned an unexpected redirect.', requestId)
    }
    res.statusCode = upstream.status
    res.setHeader('cache-control', 'private, no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-request-id', upstream.headers.get('x-request-id') || requestId)
    for (const name of RESPONSE_HEADERS) {
      if (name === 'x-request-id') continue
      const value = upstream.headers.get(name)
      if (value) res.setHeader(name, value)
    }
    const cookies = upstream.headers.getSetCookie?.() ?? []
    if (cookies.length) res.setHeader('set-cookie', cookies)
    else {
      const cookie = upstream.headers.get('set-cookie')
      if (cookie) res.setHeader('set-cookie', cookie)
    }
    if (!upstream.body) return res.end()
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch (error) {
    if (timedOut) return jsonError(res, 504, 'The Core API request timed out.', requestId)
    if (controller.signal.aborted) return
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'core_proxy_failed',
      requestId,
      errorClass: typeof error?.name === 'string' ? error.name : 'Error',
    }))
    jsonError(res, 502, 'The Core API could not be reached.', requestId)
  } finally {
    clearTimeout(timer)
  }
}

export default function handler(req, res) {
  return proxyRequest(req, res)
}
