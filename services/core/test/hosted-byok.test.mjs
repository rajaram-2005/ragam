import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { HostedByokService, safeProviderList, sealProviderCredential, unsealProviderCredential } from '../src/hosted/byok.mjs'

const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const API_KEY = 'sk-user-a-super-secret'
const ENCRYPTION_KEY = Buffer.alloc(32, 9)
const ENV = {
  NODE_ENV: 'test', SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test', AETHERIS_PROVIDER_ENCRYPTION_KEY: ENCRYPTION_KEY.toString('base64'),
  AETHERIS_HOSTED_ORIGINS: 'https://ragam.example',
}

class MockServerResponse {
  constructor() { this.headers = {}; this.statusCode = 200; this.body = '' }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value }
  writeHead(status, headers = {}) { this.statusCode = status; Object.assign(this.headers, Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))) }
  end(body = '') { this.body = String(body); this.writableEnded = true }
  json() { return JSON.parse(this.body || '{}') }
}

class MockFetchResponse {
  constructor(value, status = 200) { this.value = value; this.status = status; this.ok = status >= 200 && status < 300 }
  async json() { return this.value }
  async text() { return this.value === null ? '' : JSON.stringify(this.value) }
  static json(value, status = 200) { return new MockFetchResponse(value, status) }
}

function request(method, path, { body, cookie = '', origin = 'https://ragam.example', headers = {} } = {}) {
  const source = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(source ? [Buffer.from(source)] : [])
  req.method = method
  req.url = `/api/hosted${path}`
  req.headers = {
    host: 'ragam-core.vercel.app',
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-aetheris-request': '1' }),
    ...(origin ? { origin } : {}),
    ...(cookie ? { cookie } : {}),
    ...headers,
  }
  return req
}

function cookieFrom(response, name) {
  const cookies = response.headers['set-cookie'] ?? []
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`))
  return found?.split(';')[0] ?? ''
}

function harness() {
  const users = new Map([
    ['token-a', { id: USER_A, email: 'a@example.com' }],
    ['token-b', { id: USER_B, email: 'b@example.com' }],
  ])
  const records = new Map()
  const calls = []
  const fetcher = async (input, options = {}) => {
    const url = new URL(input)
    calls.push({ url: url.toString(), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null })
    if (url.pathname === '/auth/v1/token') {
      const parsed = JSON.parse(options.body)
      if (parsed.email === 'a@example.com') return MockFetchResponse.json({ access_token: 'token-a', refresh_token: 'refresh-a', expires_in: 3600, user: users.get('token-a') })
      if (parsed.email === 'b@example.com') return MockFetchResponse.json({ access_token: 'token-b', refresh_token: 'refresh-b', expires_in: 3600, user: users.get('token-b') })
      return MockFetchResponse.json({ msg: 'bad credentials' }, 400)
    }
    if (url.pathname === '/auth/v1/user') {
      const user = users.get((options.headers?.authorization ?? '').replace(/^Bearer /, ''))
      return user ? Response.json(user) : Response.json({ msg: 'unauthorized' }, 401)
    }
    if (url.pathname === '/auth/v1/signup') return MockFetchResponse.json({ user: users.get('token-a') })
    if (url.pathname === '/auth/v1/logout') return MockFetchResponse.json({})
    if (url.pathname.startsWith('/rest/v1/byok_provider_connections')) {
      const userId = url.searchParams.get('user_id')?.replace(/^eq\./, '')
      const method = options.method ?? 'GET'
      if (method === 'GET') return MockFetchResponse.json(records.has(userId) ? [records.get(userId)] : [])
      if (method === 'POST') {
        const value = JSON.parse(options.body)
        records.set(value.user_id, { ...value, updated_at: '2026-11-03T00:00:00.000Z' })
        return MockFetchResponse.json(null)
      }
      if (method === 'PATCH') {
        records.set(userId, { ...records.get(userId), ...JSON.parse(options.body) })
        return MockFetchResponse.json(null)
      }
      if (method === 'DELETE') { records.delete(userId); return MockFetchResponse.json(null) }
    }
    throw new Error(`Unexpected test fetch ${options.method ?? 'GET'} ${url}`)
  }
  const gateway = {
    request: async (_config, path, opts) => {
      calls.push({ providerPath: path, body: opts?.body ?? null })
      if (path === '/models') return { data: [{ id: 'gpt-test' }] }
      if (path.startsWith('/v1/models')) return { models: [{ name: 'command-test' }] }
      if (path === '/chat/completions') return { model: 'gpt-test', choices: [{ message: { content: 'Test reply' } }], usage: { total_tokens: 4 } }
      throw new Error(`Unexpected provider path ${path}`)
    },
  }
  return { service: new HostedByokService({ env: ENV, fetcher, gateway }), records, calls }
}

async function invoke(service, method, path, options = {}) {
  const res = new MockServerResponse()
  await service.handle(request(method, path, options), res)
  return res
}

async function signedIn(service, email) {
  const response = await invoke(service, 'POST', '/auth/login', { body: { email, password: 'a-long-password-not-used-here' } })
  assert.equal(response.statusCode, 200)
  const access = cookieFrom(response, 'ragam_access')
  const refresh = cookieFrom(response, 'ragam_refresh')
  assert.ok(access && refresh)
  return `${access}; ${refresh}`
}

test('provider credentials are authenticated ciphertext bound to one account and provider', () => {
  const sealed = sealProviderCredential(ENCRYPTION_KEY, USER_A, 'openai', API_KEY)
  assert.notEqual(JSON.stringify(sealed).includes(API_KEY), true)
  assert.equal(unsealProviderCredential(ENCRYPTION_KEY, USER_A, 'openai', sealed), API_KEY)
  assert.throws(() => unsealProviderCredential(ENCRYPTION_KEY, USER_B, 'openai', sealed), /could not be decrypted/)
  assert.throws(() => unsealProviderCredential(ENCRYPTION_KEY, USER_A, 'anthropic', sealed), /could not be decrypted/)
})

test('hosted catalogue only includes implemented credential-based chat providers', () => {
  const providers = safeProviderList()
  assert.ok(providers.some((provider) => provider.id === 'openai' && provider.nativeSearch))
  assert.ok(providers.some((provider) => provider.id === 'anthropic' && provider.nativeSearch))
  assert.ok(providers.some((provider) => provider.id === 'gemini' && provider.nativeSearch))
  assert.ok(!providers.some((provider) => ['litellm', 'ollama', 'bedrock', 'vertex'].includes(provider.id)))
})

test('provider records and decrypted credentials remain scoped to the authenticated account', async () => {
  const { service, records } = harness()
  const cookieA = await signedIn(service, 'a@example.com')
  const cookieB = await signedIn(service, 'b@example.com')

  const saved = await invoke(service, 'PUT', '/provider', { cookie: cookieA, body: { provider: 'openai', apiKey: API_KEY } })
  assert.equal(saved.statusCode, 200)
  assert.equal(saved.json().configured, true)
  assert.ok(!JSON.stringify(saved.json()).includes(API_KEY), 'the API response must never include a provider credential')
  assert.equal(records.size, 1)
  assert.ok(!JSON.stringify(records.get(USER_A)).includes(API_KEY), 'database row stores ciphertext, not plaintext')
  assert.equal(records.get(USER_A).user_id, USER_A)

  const otherUser = await invoke(service, 'GET', '/provider', { cookie: cookieB })
  assert.equal(otherUser.statusCode, 200)
  assert.deepEqual(otherUser.json(), { configured: false, provider: null, model: '', models: [], updatedAt: null })
})

test('model listing and chat require a selected listed model and per-request provider consent', async () => {
  const { service, calls } = harness()
  const cookie = await signedIn(service, 'a@example.com')
  await invoke(service, 'PUT', '/provider', { cookie, body: { provider: 'openai', apiKey: API_KEY } })

  const modelList = await invoke(service, 'POST', '/provider/models', { cookie, body: {} })
  assert.equal(modelList.statusCode, 200)
  assert.deepEqual(modelList.json().models, ['gpt-test'])
  await invoke(service, 'PUT', '/provider/model', { cookie, body: { model: 'gpt-test' } })

  const refused = await invoke(service, 'POST', '/chat', { cookie, body: { prompt: 'Hello', authorization: {} } })
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().error, 'consent_required')
  assert.equal(calls.some((call) => call.providerPath === '/chat/completions'), false)

  const accepted = await invoke(service, 'POST', '/chat', { cookie, body: { prompt: 'Hello', authorization: { confirmed: true } } })
  assert.equal(accepted.statusCode, 200)
  assert.equal(accepted.json().text, 'Test reply')
  assert.equal(calls.some((call) => call.providerPath === '/chat/completions'), true)
})

test('Search requires explicit consent and unsupported providers do not silently fall back', async () => {
  const { service, calls } = harness()
  const cookie = await signedIn(service, 'a@example.com')
  await invoke(service, 'PUT', '/provider', { cookie, body: { provider: 'openai', apiKey: API_KEY } })
  await invoke(service, 'POST', '/provider/models', { cookie, body: {} })
  await invoke(service, 'PUT', '/provider/model', { cookie, body: { model: 'gpt-test' } })

  const refused = await invoke(service, 'POST', '/chat', { cookie, body: { prompt: 'Search', nativeSearch: true, authorization: { confirmed: true } } })
  assert.equal(refused.statusCode, 403)
  assert.equal(refused.json().error, 'search_consent_required')
  assert.equal(calls.some((call) => call.providerPath === '/chat/completions'), false)

  const unsupported = await invoke(service, 'PUT', '/provider', { cookie, body: { provider: 'cohere', apiKey: API_KEY } })
  assert.equal(unsupported.statusCode, 200)
  await invoke(service, 'POST', '/provider/models', { cookie, body: {} })
  await invoke(service, 'PUT', '/provider/model', { cookie, body: { model: 'command-test' } })
  const noSearch = await invoke(service, 'POST', '/chat', { cookie, body: { prompt: 'Search', nativeSearch: true, authorization: { confirmed: true, nativeSearchConfirmed: true } } })
  assert.equal(noSearch.statusCode, 409)
  assert.equal(noSearch.json().error, 'capability_unavailable')
})

test('hosted mutations reject missing, cross-site, and unlisted origins', async () => {
  const { service } = harness()
  const noHeader = await invoke(service, 'POST', '/auth/login', { body: { email: 'a@example.com', password: 'pass' }, headers: { 'x-aetheris-request': undefined } })
  assert.equal(noHeader.statusCode, 403)
  const crossOrigin = await invoke(service, 'POST', '/auth/login', { body: { email: 'a@example.com', password: 'pass' }, origin: 'https://evil.example' })
  assert.equal(crossOrigin.statusCode, 403)
})


test('signup and password recovery use Supabase Auth without exposing tokens to the browser', async () => {
  const { service, calls } = harness()
  const signup = await invoke(service, 'POST', '/auth/signup', { body: { email: 'a@example.com', password: 'long-enough-password' } })
  assert.equal(signup.statusCode, 202, 'signup requires email confirmation when Auth is configured that way')
  assert.equal(signup.json().confirmationRequired, true)
  assert.equal(signup.headers['set-cookie'], undefined, 'an unconfirmed signup does not get an app session')
  assert.ok(!JSON.stringify(signup.json()).includes('token-a'))

  const reset = await invoke(service, 'POST', '/auth/password-reset/request', { body: { email: 'a@example.com' } })
  assert.equal(reset.statusCode, 202)
  assert.match(reset.json().message, /If an account uses that address/)
  assert.ok(calls.some((call) => call.url.includes('/auth/v1/recover?redirect_to=')))

  const recovery = await invoke(service, 'POST', '/auth/recovery-session', { body: { accessToken: 'token-a', refreshToken: 'refresh-a' } })
  assert.equal(recovery.statusCode, 200)
  assert.ok(cookieFrom(recovery, 'ragam_access'))
  const changed = await invoke(service, 'POST', '/auth/password', { cookie: `${cookieFrom(recovery, 'ragam_access')}; ${cookieFrom(recovery, 'ragam_refresh')}`, body: { password: 'another-long-password' } })
  assert.equal(changed.statusCode, 200)
  assert.equal(changed.json().changed, true)
  assert.ok(changed.headers['set-cookie'].every((cookie) => cookie.includes('Max-Age=0')))
})

test('provider endpoint configuration accepts only the documented HTTPS host', async () => {
  const { service } = harness()
  const cookie = await signedIn(service, 'a@example.com')
  const response = await invoke(service, 'PUT', '/provider', { cookie, body: { provider: 'openai', apiKey: API_KEY, baseUrl: 'https://attacker.example/v1' } })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().error, 'invalid_endpoint')
})
