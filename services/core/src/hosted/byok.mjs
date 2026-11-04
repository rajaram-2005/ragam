import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { failure } from '../online/failure.mjs'
import { readBody, sendJson } from '../online/http.mjs'
import { OnlineGateway } from '../online/gateway.mjs'
import { normalizeChatMessages, redactChatMessages, textFromChatContent } from '../online/chat-content.mjs'
import { classifyText } from '../policy/classify.mjs'
import { mostSensitiveDataClass } from '../policy/egress.mjs'
import { PROVIDERS, PROVIDER_STATUS } from '../providers/catalog.mjs'
import { CREDENTIAL_KINDS, normaliseCredential, wireFor } from '../providers/wires/index.mjs'
import { MANUFACTURING_MODE, addIndustryInstruction } from '../providers/industry-operations.mjs'

const ACCESS_COOKIE = 'ragam_access'
const REFRESH_COOKIE = 'ragam_refresh'
const COOKIE_TTL = 60 * 60
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,8192}$/
const NON_HOSTED = new Set(['litellm', 'ollama', 'llamacpp', 'vllm', 'localai', 'comfyui'])

function cookieValue(header = '', name) {
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return null }
    }
  }
  return null
}

function parseKey(value) {
  if (typeof value !== 'string') throw failure('hosted_not_configured', 'Hosted BYOK is not configured.', 503)
  const raw = value.trim()
  let key
  try {
    if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex')
    else key = Buffer.from(raw, 'base64')
  } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) throw failure('hosted_not_configured', 'Hosted BYOK encryption key must be 32 bytes (base64 or 64 hex characters).', 503)
  return key
}

function seal(key, userId, providerId, secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${userId}:${providerId}:v1`))
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return { version: 1, iv: iv.toString('base64'), data: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function unseal(key, userId, providerId, saved) {
  try {
    if (saved?.version !== 1) throw new Error('version')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'))
    decipher.setAAD(Buffer.from(`${userId}:${providerId}:v1`))
    decipher.setAuthTag(Buffer.from(saved.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8')
  } catch { throw failure('credential_store_corrupt', 'The saved provider credential could not be decrypted.', 500) }
}

function safeProviderList() {
  return PROVIDERS.filter((entry) => entry.status !== PROVIDER_STATUS.PENDING && !NON_HOSTED.has(entry.id))
    .filter((entry) => {
      try {
        const wire = wireFor(entry.wire)
        return typeof wire.chat === 'function' && (wire.credential ?? CREDENTIAL_KINDS.API_KEY) === CREDENTIAL_KINDS.API_KEY
      } catch { return false }
    })
    .map((entry) => {
      const wire = wireFor(entry.wire)
      return { id: entry.id, label: entry.label, wire: entry.wire, defaultBaseUrl: wire.defaultBaseUrl ?? null,
        nativeSearch: wire.chatNativeSearch === true, docsUrl: entry.docsUrl }
    })
}

function hostedBaseUrl(entry, value) {
  let parsed
  try { parsed = new URL(String(value ?? '')) } catch { throw failure('invalid_endpoint', 'Choose the provider’s documented HTTPS endpoint.', 400) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw failure('invalid_endpoint', 'Hosted connections require the provider’s documented public HTTPS endpoint.', 400)
  }
  if (entry.defaultBaseUrl) {
    let expected
    try { expected = new URL(entry.defaultBaseUrl) } catch { throw failure('invalid_endpoint', 'This provider does not have a hosted endpoint.', 400) }
    const cleanPath = (path) => path.replace(/\/+$/, '')
    if (parsed.origin !== expected.origin || cleanPath(parsed.pathname) !== cleanPath(expected.pathname)) {
      throw failure('invalid_endpoint', 'Use the documented endpoint for this provider.', 400)
    }
    return expected.href.replace(/\/+$/, '')
  }
  if (entry.id === 'azure-openai' && /^(?:[a-z0-9-]+\.)?openai\.azure\.com$/i.test(parsed.hostname) && !parsed.port && parsed.pathname === '/') {
    return parsed.origin
  }
  throw failure('invalid_endpoint', 'This provider requires a supported documented HTTPS endpoint.', 400)
}

function jsonFetch(fetcher, url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  return fetcher(url, { ...options, signal: options.signal ?? controller.signal }).finally(() => clearTimeout(timer))
}

export class HostedByokService {
  constructor({ env = process.env, fetcher = globalThis.fetch, gateway = null, logger = null } = {}) {
    this.env = env
    this.fetcher = fetcher
    this.logger = typeof logger === 'function' ? logger : () => {}
    this.url = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '')
    this.anonKey = env.SUPABASE_ANON_KEY ?? ''
    this.serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
    this.allowedOrigins = new Set(String(env.AETHERIS_HOSTED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean))
    this.siteUrl = String(env.AETHERIS_HOSTED_SITE_URL ?? [...this.allowedOrigins][0] ?? '').replace(/\/+$/, '')
    try { this.encryptionKey = parseKey(env.AETHERIS_PROVIDER_ENCRYPTION_KEY) } catch { this.encryptionKey = null }
    this.gateway = gateway ?? new OnlineGateway({ timeoutMs: 120_000 })
  }

  ready() {
    return Boolean(this.url && /^https:\/\//.test(this.url) && this.anonKey && this.serviceKey && this.encryptionKey)
  }

  #assertReady() {
    if (!this.ready()) throw failure('hosted_not_configured', 'Hosted account storage is not configured. Contact the site operator.', 503)
  }

  #cookie(name, value, maxAge = COOKIE_TTL) {
    const secure = this.env.NODE_ENV === 'production' || this.env.AETHERIS_COOKIE_SECURE === 'true'
    return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/hosted; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  }

  #setSessionCookies(res, session) {
    if (!TOKEN_PATTERN.test(session?.access_token ?? '') || !TOKEN_PATTERN.test(session?.refresh_token ?? '')) {
      throw failure('auth_failed', 'The sign-in service returned an invalid session.', 502)
    }
    const maxAge = Math.max(60, Math.min(Number(session.expires_in) || COOKIE_TTL, 24 * 60 * 60))
    res.setHeader('set-cookie', [this.#cookie(ACCESS_COOKIE, session.access_token, maxAge), this.#cookie(REFRESH_COOKIE, session.refresh_token, 30 * 24 * 60 * 60)])
  }

  #clearSessionCookies(res) {
    const secure = this.env.NODE_ENV === 'production' || this.env.AETHERIS_COOKIE_SECURE === 'true'
    res.setHeader('set-cookie', [ACCESS_COOKIE, REFRESH_COOKIE].map((name) => `${name}=; HttpOnly; SameSite=Lax; Path=/api/hosted; Max-Age=0${secure ? '; Secure' : ''}`))
  }

  async #auth(path, body, accessToken = null) {
    this.#assertReady()
    const response = await jsonFetch(this.fetcher, `${this.url}/auth/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { apikey: this.anonKey, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const status = response.status
      const msg = status === 400 || status === 422 ? 'Check your email and password, then try again.'
        : status === 429 ? 'Too many sign-in attempts. Wait a moment and try again.'
          : 'The account service could not complete that request.'
      throw failure(status === 429 ? 'rate_limited' : 'auth_failed', msg, status === 429 ? 429 : status === 400 || status === 422 ? 400 : 502)
    }
    return payload
  }

  async #currentUser(req, res, { optional = false } = {}) {
    this.#assertReady()
    let access = cookieValue(req.headers.cookie, ACCESS_COOKIE)
    const refresh = cookieValue(req.headers.cookie, REFRESH_COOKIE)
    if (access && TOKEN_PATTERN.test(access)) {
      try {
        const user = await this.#auth('/user', undefined, access)
        if (typeof user.id === 'string' && user.id) return { id: user.id, email: user.email ?? '' }
      } catch (error) {
        if (error.status !== 401) throw error
      }
    }
    if (refresh && TOKEN_PATTERN.test(refresh)) {
      try {
        const session = await this.#auth('/token?grant_type=refresh_token', { refresh_token: refresh })
        this.#setSessionCookies(res, session)
        const user = await this.#auth('/user', undefined, session.access_token)
        if (typeof user.id === 'string' && user.id) return { id: user.id, email: user.email ?? '' }
      } catch (error) {
        if (![400, 401].includes(error.status)) throw error
        this.#clearSessionCookies(res)
      }
    }
    if (optional) return null
    throw failure('unauthenticated', 'Sign in to your Ragam account.', 401)
  }

  #rest(path, { method = 'GET', body, prefer = null } = {}) {
    this.#assertReady()
    return jsonFetch(this.fetcher, `${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.serviceKey,
        authorization: `Bearer ${this.serviceKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(prefer ? { prefer } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => {
      const text = await response.text()
      const payload = text ? JSON.parse(text) : null
      if (!response.ok) throw failure('account_storage_failed', 'Your account storage could not complete that request.', 503)
      return payload
    })
  }

  async #record(userId) {
    const rows = await this.#rest(`byok_provider_connections?select=user_id,provider_id,base_url,credential,models,selected_model,updated_at&user_id=eq.${encodeURIComponent(userId)}&limit=1`)
    return Array.isArray(rows) ? rows[0] ?? null : null
  }

  #publicRecord(row) {
    if (!row) return { configured: false, provider: null, model: '', models: [], updatedAt: null }
    return { configured: true, provider: row.provider_id, baseUrl: row.base_url, model: row.selected_model ?? '', models: Array.isArray(row.models) ? row.models : [], updatedAt: row.updated_at }
  }

  async #config(userId, row = null) {
    const saved = row ?? await this.#record(userId)
    if (!saved) throw failure('provider_not_configured', 'Add your own provider key in Provider Settings before chatting.', 409)
    const wire = wireFor(saved.wire ?? safeProviderList().find((entry) => entry.id === saved.provider_id)?.wire)
    return { row: saved, wire, config: { id: saved.provider_id, kind: saved.provider_id, wire: wire.wire, label: safeProviderList().find((entry) => entry.id === saved.provider_id)?.label ?? saved.provider_id, baseUrl: saved.base_url, apiKey: unseal(this.encryptionKey, userId, saved.provider_id, saved.credential), options: {} } }
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://hosted.invalid')
    const path = url.pathname.replace(/^\/api\/hosted/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    try {
      if (path === '/health' && method === 'GET') return sendJson(res, 200, { status: this.ready() ? 'ok' : 'configuration_required', service: 'hosted-byok' })
      const origin = req.headers.origin
      if (origin && (!this.allowedOrigins.size || !this.allowedOrigins.has(origin))) throw failure('origin_rejected', 'This request origin is not allowed.', 403)
      if (!['GET', 'HEAD'].includes(method)) {
        if (req.headers['x-aetheris-request'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') throw failure('csrf_rejected', 'Use the same-origin Ragam website.', 403)
        if (!origin || !this.allowedOrigins.has(origin)) throw failure('origin_rejected', 'This request origin is not allowed.', 403)
      }

      if (path === '/auth' && method === 'GET') {
        const user = await this.#currentUser(req, res, { optional: true })
        return sendJson(res, 200, { authenticated: Boolean(user), account: user })
      }
      if (path === '/auth/signup' && method === 'POST') {
        const body = await readBody(req, { maxBytes: 16 * 1024 })
        if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) throw failure('invalid_account', 'Use an email address and a password of at least 12 characters.', 400)
        const result = await this.#auth('/signup', { email: body.email.trim(), password: body.password, data: { product: 'ragam' } })
        if (result.access_token) this.#setSessionCookies(res, result)
        return sendJson(res, result.access_token ? 201 : 202, { authenticated: Boolean(result.access_token), confirmationRequired: !result.access_token, account: result.user ? { id: result.user.id, email: result.user.email ?? '' } : null })
      }
      if (path === '/auth/login' && method === 'POST') {
        const body = await readBody(req, { maxBytes: 16 * 1024 })
        if (typeof body.email !== 'string' || typeof body.password !== 'string') throw failure('invalid_account', 'Enter your email address and password.', 400)
        const session = await this.#auth('/token?grant_type=password', { email: body.email.trim(), password: body.password })
        this.#setSessionCookies(res, session)
        return sendJson(res, 200, { authenticated: true, account: { id: session.user.id, email: session.user.email ?? '' } })
      }
      if (path === '/auth/password-reset/request' && method === 'POST') {
        const body = await readBody(req, { maxBytes: 8 * 1024 })
        if (typeof body.email !== 'string' || body.email.length > 254 || !body.email.includes('@')) {
          throw failure('invalid_email', 'Enter a valid email address.', 400)
        }
        if (!this.siteUrl || !this.allowedOrigins.has(this.siteUrl)) throw failure('hosted_not_configured', 'Account recovery is not configured for this site.', 503)
        try {
          await this.#auth(`/recover?redirect_to=${encodeURIComponent(this.siteUrl)}`, { email: body.email.trim() })
        } catch (error) {
          if (error.status === 429) throw error
          // Do not reveal whether an account exists; Supabase normally returns the same
          // success shape for existing and unknown email addresses.
        }
        return sendJson(res, 202, { requested: true, message: 'If an account uses that address, a password recovery link will be sent.' })
      }
      if (path === '/auth/recovery-session' && method === 'POST') {
        const body = await readBody(req, { maxBytes: 16 * 1024 })
        if (!TOKEN_PATTERN.test(body.accessToken ?? '') || !TOKEN_PATTERN.test(body.refreshToken ?? '')) {
          throw failure('invalid_recovery', 'That recovery link is invalid or expired. Request a new one.', 400)
        }
        const user = await this.#auth('/user', undefined, body.accessToken)
        if (typeof user.id !== 'string' || !user.id) throw failure('invalid_recovery', 'That recovery link is invalid or expired. Request a new one.', 401)
        this.#setSessionCookies(res, { access_token: body.accessToken, refresh_token: body.refreshToken, expires_in: 3600 })
        return sendJson(res, 200, { account: { id: user.id, email: user.email ?? '' } })
      }
      if (path === '/auth/password' && method === 'POST') {
        const user = await this.#currentUser(req, res)
        const body = await readBody(req, { maxBytes: 16 * 1024 })
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) {
          throw failure('invalid_password', 'Use a password between 12 and 256 characters.', 400)
        }
        const access = cookieValue(req.headers.cookie, ACCESS_COOKIE)
        if (!access || !TOKEN_PATTERN.test(access)) throw failure('unauthenticated', 'Sign in again to update your password.', 401)
        const response = await jsonFetch(this.fetcher, `${this.url}/auth/v1/user`, {
          method: 'PUT', headers: { apikey: this.anonKey, authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify({ password: body.password }),
        })
        if (!response.ok) throw failure('password_update_failed', 'The password could not be changed. Request a fresh recovery link and try again.', response.status === 401 ? 401 : 400)
        await response.json().catch(() => ({}))
        this.#clearSessionCookies(res)
        return sendJson(res, 200, { changed: true, email: user.email })
      }
      if (path === '/auth/logout' && method === 'POST') {
        const access = cookieValue(req.headers.cookie, ACCESS_COOKIE)
        if (access && TOKEN_PATTERN.test(access)) await this.#auth('/logout', {}, access).catch(() => {})
        this.#clearSessionCookies(res)
        return sendJson(res, 200, { authenticated: false })
      }

      const user = await this.#currentUser(req, res)
      if (path === '/providers' && method === 'GET') return sendJson(res, 200, { providers: safeProviderList() })
      if (path === '/provider' && method === 'GET') return sendJson(res, 200, this.#publicRecord(await this.#record(user.id)))
      if (path === '/provider' && method === 'PUT') {
        const body = await readBody(req, { maxBytes: 20 * 1024 })
        const entry = safeProviderList().find((item) => item.id === body.provider)
        if (!entry) throw failure('invalid_provider', 'Choose a provider supported by this hosted account.', 400)
        const wire = wireFor(entry.wire)
        if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 8192) throw failure('invalid_key', 'Enter a provider API key no longer than 8192 characters.', 400)
        const baseUrl = hostedBaseUrl(entry, body.baseUrl || entry.defaultBaseUrl)
        const storedKey = normaliseCredential(entry.wire, body.apiKey.trim())
        wire.validateConfig?.({ id: entry.id, wire: entry.wire, options: {} })
        const record = {
          user_id: user.id,
          provider_id: entry.id,
          base_url: baseUrl.replace(/\/+$/, ''),
          credential: seal(this.encryptionKey, user.id, entry.id, storedKey),
          models: [],
          selected_model: '',
        }
        await this.#rest('byok_provider_connections?on_conflict=user_id', { method: 'POST', body: record, prefer: 'resolution=merge-duplicates,return=minimal' })
        return sendJson(res, 200, this.#publicRecord({ ...record, updated_at: new Date().toISOString() }))
      }
      if (path === '/provider' && method === 'DELETE') {
        await this.#rest(`byok_provider_connections?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' })
        return sendJson(res, 200, { configured: false })
      }
      if (path === '/provider/models' && method === 'POST') {
        const { row, wire, config } = await this.#config(user.id)
        const models = await wire.models(this.gateway.request.bind(this.gateway), config)
        if (!Array.isArray(models) || models.length > 500) throw failure('invalid_model_list', 'The provider returned an unsupported model list.', 502)
        const clean = [...new Set(models.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 240 && !/[\x00-\x1f\x7f]/.test(id)))].sort()
        const selected = clean.includes(row.selected_model) ? row.selected_model : ''
        await this.#rest(`byok_provider_connections?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { models: clean, selected_model: selected }, prefer: 'return=minimal' })
        return sendJson(res, 200, { models: clean, model: selected })
      }
      if (path === '/provider/model' && method === 'PUT') {
        const body = await readBody(req, { maxBytes: 4096 })
        if (typeof body.model !== 'string' || !body.model || body.model.length > 240) throw failure('invalid_model', 'Choose a listed model.', 400)
        const row = await this.#record(user.id)
        if (!row || !Array.isArray(row.models) || !row.models.includes(body.model)) throw failure('model_unavailable', 'Choose a model returned by your provider. No model fallback is performed.', 409)
        await this.#rest(`byok_provider_connections?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { selected_model: body.model }, prefer: 'return=minimal' })
        return sendJson(res, 200, { model: body.model })
      }
      if (path === '/chat' && method === 'POST') {
        const body = await readBody(req, { maxBytes: 256 * 1024 })
        if (body.authorization?.confirmed !== true) throw failure('consent_required', 'Confirm sending this message to your selected provider.', 403)
        const { row, wire, config } = await this.#config(user.id)
        const model = body.model ?? row.selected_model
        if (!model || !Array.isArray(row.models) || !row.models.includes(model)) throw failure('model_unavailable', 'Select a model from your provider’s current model list. No fallback is performed.', 409)
        const normalized = normalizeChatMessages(body.messages ?? [{ role: 'user', content: body.prompt }])
        if (body.industryMode !== undefined && body.industryMode !== null && body.industryMode !== false
          && body.industryMode !== '' && body.industryMode !== MANUFACTURING_MODE) {
          throw failure('invalid_industry_mode', 'Choose a supported industry mode.', 400)
        }
        const industryMode = body.industryMode === MANUFACTURING_MODE ? MANUFACTURING_MODE : null
        const sensitivity = mostSensitiveDataClass(...normalized.messages.map((message) => classifyText(textFromChatContent(message.content)).dataClass))
        if (['restricted', 'confidential'].includes(sensitivity) && body.authorization?.allowSensitive !== true) throw failure('sensitive_consent_required', 'This message may contain sensitive data. Explicitly authorize this transfer or remove it.', 403)
        addIndustryInstruction(normalized.messages, industryMode)
        const redacted = redactChatMessages(normalized.messages)
        const nativeSearch = body.nativeSearch === true
        if (nativeSearch && body.authorization?.nativeSearchConfirmed !== true) throw failure('search_consent_required', 'Explicitly approve provider-native search for this request.', 403)
        if (nativeSearch && wire.chatNativeSearch !== true) throw failure('capability_unavailable', 'This provider does not expose provider-native Search. No fallback is performed.', 409)
        const maxTokens = Number.isInteger(body.maxTokens) && body.maxTokens > 0 && body.maxTokens <= 8192 ? body.maxTokens : 512
        const temperature = Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2 ? body.temperature : 0.2
        const result = await wire.chat(this.gateway.request.bind(this.gateway), config, { model, messages: redacted.value, maxTokens, temperature, nativeSearch, signal: AbortSignal.timeout(120_000) })
        if (typeof result?.text !== 'string' || !result.text) throw failure('invalid_completion', 'The provider returned no text. No model was substituted.', 502)
        return sendJson(res, 200, { text: result.text, model: result.model ?? model, usage: result.usage ?? null, grounding: result.grounding ?? null, provider: entryLabel(row.provider_id), sensitive: sensitivity !== 'public', industryMode })
      }
      throw failure('not_found', 'Hosted endpoint not found.', 404)
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      const code = typeof error?.code === 'string' ? error.code : 'hosted_request_failed'
      if (status >= 500) this.logger({ event: 'hosted_byok_request_failed', code })
      return sendJson(res, status, { error: code, message: status >= 500 ? 'The request could not be completed. No provider fallback was attempted.' : String(error?.message ?? 'Request refused.') })
    }
  }
}

function entryLabel(providerId) { return safeProviderList().find((entry) => entry.id === providerId)?.label ?? providerId }

export function createHostedByokService(options = {}) { return new HostedByokService(options) }
export { seal as sealProviderCredential, unseal as unsealProviderCredential, safeProviderList }
