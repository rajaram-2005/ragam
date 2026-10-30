const ALLOWED_ENDPOINTS = new Set(['rest/v1', 'storage/v1'])
const ALLOWED_CALLER_HEADERS = new Set([
  'accept', 'accept-profile', 'cache-control', 'content-profile', 'content-range',
  'content-type', 'if-match', 'if-none-match', 'prefer', 'range', 'x-upsert',
])

export class SupabaseAdminError extends Error {
  constructor(code, status = null) {
    super(code)
    this.name = 'SupabaseAdminError'
    this.code = code
    this.status = status
  }
}

function configuredOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new SupabaseAdminError('supabase_url_missing')
  let url
  try { url = new URL(value) } catch { throw new SupabaseAdminError('supabase_url_invalid') }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new SupabaseAdminError('supabase_url_invalid')
  }
  return url.origin
}

function endpointPath(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.startsWith('/') || endpoint.includes('\\')) {
    throw new SupabaseAdminError('supabase_endpoint_invalid')
  }
  const [namespace, version, ...segments] = endpoint.split('/')
  const root = `${namespace}/${version}`
  let invalidSegment = false
  for (const part of segments) {
    let decoded
    try { decoded = decodeURIComponent(part) } catch { invalidSegment = true; break }
    if (!decoded || decoded === '.' || decoded === '..' || /[\/\\\u0000-\u001f\u007f]/u.test(decoded)) {
      invalidSegment = true
      break
    }
  }
  if (!ALLOWED_ENDPOINTS.has(root) || segments.length === 0 || invalidSegment) {
    throw new SupabaseAdminError('supabase_endpoint_invalid')
  }
  return endpoint
}

/**
 * Minimal server-only Supabase REST client. It intentionally accepts only a fixed HTTPS origin
 * and the database/storage API prefixes. It never logs request URLs, headers, response bodies,
 * or credentials. Do not construct this in browser code or with an anon key.
 */
export class SupabaseAdminClient {
  #origin
  #serviceRoleKey
  #fetchImpl

  constructor({ url = process.env.SUPABASE_URL, serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.#origin = configuredOrigin(url)
    if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length < 20) throw new SupabaseAdminError('supabase_service_key_missing')
    if (typeof fetchImpl !== 'function') throw new SupabaseAdminError('supabase_fetch_unavailable')
    this.#serviceRoleKey = serviceRoleKey
    this.#fetchImpl = fetchImpl
    this.timeoutMs = Math.max(1, Math.min(30_000, Number(timeoutMs) || 10_000))
  }

  async request(endpoint, { method = 'GET', query = '', headers = {}, body, timeoutMs = this.timeoutMs } = {}) {
    const path = endpointPath(endpoint)
    const verb = String(method).toUpperCase()
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) throw new SupabaseAdminError('supabase_method_invalid')
    if (typeof query !== 'string' || query.startsWith('?') || query.includes('#')) throw new SupabaseAdminError('supabase_query_invalid')
    const url = `${this.#origin}/${path}${query ? `?${query}` : ''}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(30_000, Number(timeoutMs) || this.timeoutMs)))
    const callerHeaders = new Headers(headers)
    const requestHeaders = new Headers()
    for (const [name, value] of callerHeaders) {
      if (!ALLOWED_CALLER_HEADERS.has(name)) throw new SupabaseAdminError('supabase_header_invalid')
      requestHeaders.set(name, value)
    }
    requestHeaders.set('apikey', this.#serviceRoleKey)
    requestHeaders.set('authorization', `Bearer ${this.#serviceRoleKey}`)
    if (!requestHeaders.has('accept')) requestHeaders.set('accept', 'application/json')
    if (body !== undefined && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json')
    try {
      const response = await this.#fetchImpl(url, {
        method: verb,
        headers: requestHeaders,
        body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) throw new SupabaseAdminError(`supabase_http_${response.status}`, response.status)
      if (response.status === 204 || verb === 'HEAD') return null
      const text = await response.text()
      if (!text) return null
      try { return JSON.parse(text) } catch { throw new SupabaseAdminError('supabase_response_invalid', response.status) }
    } catch (error) {
      if (error instanceof SupabaseAdminError) throw error
      if (controller.signal.aborted) throw new SupabaseAdminError('supabase_request_timeout')
      throw new SupabaseAdminError('supabase_request_failed')
    } finally {
      clearTimeout(timeout)
    }
  }
}
