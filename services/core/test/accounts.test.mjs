// Traditional sign-in: accounts, passwords, sessions and the reset path.
//
// This suite exists because the online product stopped signing people in with an
// operator token read from a file on the Core host and started signing them in with an
// email address and a password. That is a small change to a form and a large change to
// what the service has to get right: passwords must be stored so they cannot be
// recovered, the responses must not turn the sign-in form into an account lookup,
// guessing has to be bounded, and — now that more than one person can be signed in —
// one person's conversations must not be another person's.
//
// Each of those is asserted here against the real HTTP surface and the real files on
// disk, with a synthetic gateway, exactly as test/online.test.mjs does. The gateway is a
// fixture and is never described as a provider; nothing here needs the network.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { COOKIE_SAME_SITE, OnlineApp, SESSIONS, RESET_REQUESTED_MESSAGE } from '../src/online/app.mjs'
import { main, parseTrustedWebOrigins } from '../src/server.mjs'
import { proxyRequest } from '../../../apps/web/api/[...path].js'
import {
  AccountStore, MAX_FAILED_LOGINS, PASSWORD_MIN_LENGTH, ROLES, RESET_CODE_TTL_MS,
  hashPassword, normalizeEmail, passwordProblems, verifyPassword,
} from '../src/online/accounts.mjs'
import { MemoryStore } from '../src/memory/store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = resolve(HERE, '..')
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })
const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0]
const OWNER = { email: 'owner@example.test', password: 'a-long-owner-password' }
const MEMBER = { email: 'member@example.test', password: 'a-long-member-password' }

async function fixture(t, options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'aetheris-accounts-test-'))
  const f = { calls: [], resetCodes: [], dir }
  const gateway = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, body, authorization: req.headers.authorization })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Synthetic fixture only.' } }] })}\r\n\r\n`)
      return res.end('data: [DONE]\n\n')
    }
    return res.end(JSON.stringify({ model: body?.model, choices: [{ message: { content: `Synthetic fixture ${body?.model}` } }] }))
  })
  f.gatewayUrl = await listen(gateway)
  const create = () => new OnlineApp({
    dataDir: dir, trustedOrigins: [f.gatewayUrl], timeoutMs: options.timeoutMs ?? 2000,
    maxAccounts: options.maxAccounts, secureCookie: options.secureCookie,
    cookieSameSite: options.cookieSameSite, onResetCode: (info) => f.resetCodes.push(info),
  })
  f.app = create()
  f.server = f.app.server()
  f.url = await listen(f.server)
  f.cookie = ''
  f.request = async (method, path, body, { cookie } = {}) => {
    const response = await fetch(f.url + path, {
      method,
      headers: { cookie: cookie ?? f.cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  /** Public auth calls send no cookie by default; `adopt: false` leaves f.cookie alone. */
  f.register = async (account = OWNER, { cookie = '', adopt = true } = {}) => {
    const r = await f.request('POST', '/api/auth/register', account, { cookie })
    if (adopt && r.status === 201) f.cookie = cookieOf(r)
    return r
  }
  f.login = async (account = OWNER, { cookie = '', adopt = true } = {}) => {
    const r = await f.request('POST', '/api/auth/login', account, { cookie })
    if (adopt && r.status === 200) f.cookie = cookieOf(r)
    return r
  }
  /** Create the account if needed, then sign in with it, and adopt its cookie. */
  f.signIn = async (account = OWNER) => {
    const registered = await f.register(account, { adopt: false })
    const response = registered.status === 201 ? registered : await f.login(account, { adopt: false })
    f.cookie = cookieOf(response)
    return response
  }
  /** Owner signed in, gateway configured, two models listed. Returns the owner cookie. */
  f.configure = async () => {
    await f.signIn(OWNER)
    const saved = await f.request('PUT', '/api/providers/litellm', { baseUrl: `${f.gatewayUrl}/v1`, apiKey: 'synthetic-gateway-secret' })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    assert.equal((await f.request('POST', '/api/models/probe', {})).status, 200)
    return f.cookie
  }
  f.chat = (extra = {}) => ({ prompt: 'ordinary question', model: 'model-a', authorization: { confirmed: true, providerRevision: f.app.store.state.revision }, ...extra })
  f.restart = () => { f.app.close(); f.app = create() }
  t.after(async () => { await close(f.server); await close(gateway); f.app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

// ---------------------------------------------------------------------------
// Password storage
// ---------------------------------------------------------------------------

test('passwords are scrypt-hashed with a per-password salt and no reversible copy is kept', async (t) => {
  const f = await fixture(t)
  const r = await f.register(OWNER)
  assert.equal(r.status, 201, JSON.stringify(r.data))
  const accounts = f.app.accounts.list()
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].role, ROLES.OWNER)

  assert.ok(!readFileSync(join(f.dir, 'accounts.sqlite'), 'latin1').includes(OWNER.password),
    'the plaintext password must not appear in the accounts database')
  assert.equal(statSync(join(f.dir, 'accounts.sqlite')).mode & 0o777, 0o600)

  const stored = hashPassword(OWNER.password)
  assert.match(stored, /^scrypt\$16384\$8\$1\$/, 'the stored form must name its own work factors')
  assert.notEqual(hashPassword(OWNER.password), hashPassword(OWNER.password), 'identical passwords must not produce identical hashes')
  assert.equal(verifyPassword(OWNER.password, stored), true)
  assert.equal(verifyPassword(`${OWNER.password}x`, stored), false)
  // A malformed stored value fails the sign-in instead of throwing through the handler.
  assert.equal(verifyPassword(OWNER.password, 'bcrypt$1$2$3$4$5'), false)
  assert.equal(verifyPassword(OWNER.password, ''), false)
  // The response carries the account, never a hash.
  assert.equal(r.data.account.passwordHash, undefined)
  assert.ok(!JSON.stringify(r.data).includes('scrypt$'))
})

test('password policy is length and denylist, and every rejection names the problem', async (t) => {
  assert.deepEqual(passwordProblems('a-reasonably-long-password', 'someone@example.test'), [])
  assert.deepEqual(passwordProblems('short', 'someone@example.test'), [`Use at least ${PASSWORD_MIN_LENGTH} characters.`])
  assert.deepEqual(passwordProblems('administrator', 'someone@example.test'), ['That password is too common to use.'])
  assert.ok(passwordProblems('aaaaaaaaaaaa', 'someone@example.test').includes('Do not repeat one character.'))
  assert.ok(passwordProblems('someone@example.test', 'someone@example.test').includes('Do not use your email address, or the name part of it, as your password.'))
  assert.ok(passwordProblems('someone', 'someone@example.test').includes('Do not use your email address, or the name part of it, as your password.'))
  // Containment is deliberately NOT a rule: it would refuse a good password because a
  // three-letter name part happens to appear inside it.
  assert.deepEqual(passwordProblems('dandelion-crusher', 'dan@example.test'), [])
  assert.ok(passwordProblems('x'.repeat(257), 'someone@example.test').some((line) => line.includes('at most')))
  assert.equal(normalizeEmail('  Owner@Example.TEST '), 'owner@example.test')

  const f = await fixture(t)
  const weak = await f.register({ email: 'weak@example.test', password: 'short' })
  assert.equal(weak.status, 400); assert.equal(weak.data.error, 'weak_password')
  assert.match(weak.data.message, /at least 12 characters/)
  assert.equal(f.app.accounts.count(), 0, 'a rejected registration creates nothing')
  for (const email of ['', 'not-an-email', 'a@b', 'a b@example.test', `${'x'.repeat(250)}@example.test`]) {
    const r = await f.register({ email, password: 'a-long-enough-password' }, { adopt: false })
    assert.equal(r.status, 400, JSON.stringify(r.data)); assert.equal(r.data.error, 'invalid_email', email)
  }
})

// ---------------------------------------------------------------------------
// Roles, and the removal of the token
// ---------------------------------------------------------------------------

test('the first account owns the installation, later ones are members, and no caller can ask for a role', async (t) => {
  const f = await fixture(t)
  const owner = await f.register(OWNER)
  assert.equal(owner.data.account.role, ROLES.OWNER)
  const member = await f.register(MEMBER, { adopt: false })
  assert.equal(member.data.account.role, ROLES.MEMBER)
  // A registration body naming its own role must not be believed.
  const escalated = await f.register({ ...MEMBER, email: 'sneaky@example.test', role: ROLES.OWNER }, { adopt: false })
  assert.equal(escalated.data.account.role, ROLES.MEMBER)
  assert.equal(f.app.accounts.owner().email, OWNER.email)
  assert.equal(f.app.accounts.count(), 3)
})

test('the operator token sign-in is gone: no token file, no token route, no token field', async (t) => {
  const f = await fixture(t)
  await f.register(OWNER)
  assert.equal(existsSync(join(f.dir, 'access-token')), false, 'no access-token file may be written')
  assert.equal('tokenPath' in f.app, false)
  assert.equal('accessDigest' in f.app, false)
  // The old body shape is not a credential any more. Without an address it is a
  // validation error; with one, the `token` field is simply ignored and the sign-in
  // fails the way any wrong password does.
  const tokenOnly = await f.request('POST', '/api/auth/login', { token: 'anything-at-all' }, { cookie: '' })
  assert.equal(tokenOnly.status, 400); assert.equal(tokenOnly.data.error, 'invalid_email')
  assert.equal(tokenOnly.headers.get('set-cookie'), null)
  const tokenPlusEmail = await f.request('POST', '/api/auth/login', { email: OWNER.email, token: 'anything-at-all' }, { cookie: '' })
  assert.equal(tokenPlusEmail.status, 401); assert.equal(tokenPlusEmail.data.error, 'invalid_credentials')
  assert.equal(tokenPlusEmail.headers.get('set-cookie'), null)
  // No code in the online product still implements the removed mechanism. Comments are
  // stripped first: several files explain, in prose, that the token file is gone, and a
  // scan that could not tell an explanation from an implementation would either pass a
  // real leftover or fail on the sentence that documents its removal.
  const code = (file) => readFileSync(join(CORE, 'src', file), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  for (const file of ['online/app.mjs', 'online/accounts.mjs', 'online/http.mjs', 'online/store.mjs', 'online/context-routes.mjs', 'server.mjs']) {
    assert.doesNotMatch(code(file), /accessDigest|tokenPath|single_operator|body\.token|invalid_login/, `${file} still carries the token sign-in`)
  }
  // And the sign-in route that replaced it reads an address and a password.
  assert.match(code('online/app.mjs'), /path === '\/api\/auth\/login'/)
  assert.match(code('online/app.mjs'), /authenticate\(\{ email: body\.email, password: body\.password \}\)/)
})

// ---------------------------------------------------------------------------
// Guessing, enumeration and locks
// ---------------------------------------------------------------------------

test('an unknown address and a wrong password are indistinguishable in code, status and message', async (t) => {
  const f = await fixture(t)
  await f.register(OWNER, { adopt: false })
  const unknown = await f.request('POST', '/api/auth/login', { email: 'nobody@example.test', password: 'a-long-owner-password' }, { cookie: '' })
  const wrong = await f.request('POST', '/api/auth/login', { email: OWNER.email, password: 'a-long-wrong-password' }, { cookie: '' })
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401)
  assert.equal(unknown.data.error, 'invalid_credentials'); assert.equal(wrong.data.error, unknown.data.error)
  assert.equal(unknown.data.message, wrong.data.message)
  // A duplicate address is the one answer that may differ: the person asking already
  // holds a password that would have to be checked anyway.
  const duplicate = await f.register(OWNER, { adopt: false })
  assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error, 'email_taken')
})

test('eight failures lock that account for fifteen minutes and nobody else', async (t) => {
  const f = await fixture(t)
  await f.register(OWNER, { adopt: false })
  await f.register(MEMBER, { adopt: false })
  for (let attempt = 1; attempt <= MAX_FAILED_LOGINS; attempt += 1) {
    const r = await f.request('POST', '/api/auth/login', { email: OWNER.email, password: 'a-long-wrong-password' }, { cookie: '' })
    assert.equal(r.status, attempt === MAX_FAILED_LOGINS ? 423 : 401, `attempt ${attempt}: ${JSON.stringify(r.data)}`)
  }
  // The correct password now fails too, which is the point of a lock.
  const locked = await f.request('POST', '/api/auth/login', OWNER, { cookie: '' })
  assert.equal(locked.status, 423); assert.equal(locked.data.error, 'account_locked')
  assert.match(locked.data.message, /15 minutes/)
  assert.ok(f.app.accounts.list().find((a) => a.email === OWNER.email).lockedUntil > Date.now())
  // Another account on the same installation is untouched.
  assert.equal((await f.login(MEMBER, { adopt: false })).status, 200)
})

test('registration and sign-in are throttled per address as well as per installation', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.register(OWNER, { adopt: false })).status, 201)
  // The per-address bucket holds 12 in a minute; the 13th is refused before the store is
  // asked, so a duplicate-email probe cannot be repeated without limit.
  let limited = null
  for (let attempt = 2; attempt <= 13; attempt += 1) {
    const r = await f.register(OWNER, { adopt: false })
    if (r.status === 429) { limited = r; break }
    assert.equal(r.status, 409, `attempt ${attempt}: ${JSON.stringify(r.data)}`)
  }
  assert.ok(limited, 'the per-address throttle must refuse the 13th attempt')
  assert.equal(limited.data.error, 'rate_limited')
})

test('the account count is capped, so an open sign-up page cannot fill the disk', async (t) => {
  const f = await fixture(t, { maxAccounts: 2 })
  assert.equal((await f.register(OWNER, { adopt: false })).status, 201)
  assert.equal((await f.register(MEMBER, { adopt: false })).status, 201)
  const third = await f.register({ email: 'third@example.test', password: 'a-long-third-password' }, { adopt: false })
  assert.equal(third.status, 429); assert.equal(third.data.error, 'account_limit')
  assert.match(third.data.message, /AETHERIS_MAX_ACCOUNTS/)
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('a session cookie is HttpOnly, SameSite=Strict, scoped to /api, secure and eight hours', async (t) => {
  const f = await fixture(t)
  assert.equal(SESSIONS.ttlMs, 8 * 3600_000, 'the documented session length is eight hours')
  const r = await f.register(OWNER, { adopt: false })
  const cookie = cookieOf(r)
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.match(r.headers.get('set-cookie'), /Path=\/api/)
  assert.match(r.headers.get('set-cookie'), /Secure/)
  assert.match(r.headers.get('set-cookie'), /Max-Age=28800/)
  assert.deepEqual((await f.request('GET', '/api/auth', undefined, { cookie })).data,
    { authenticated: true, mode: 'accounts', account: { id: r.data.account.id, email: OWNER.email, role: 'owner' } })
  // Status is the only thing the unauthenticated world can read, and it names no account.
  assert.deepEqual((await f.request('GET', '/api/auth', undefined, { cookie: '' })).data,
    { authenticated: false, mode: 'accounts', account: null })
  // Sign-out ends the session and clears the cookie.
  const out = await f.request('POST', '/api/auth/logout', {}, { cookie })
  assert.equal(out.status, 200); assert.match(out.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie })).data.authenticated, false)
  assert.equal((await f.request('GET', '/api/ready', undefined, { cookie })).status, 401)
})

test('the cookie SameSite policy is an operator choice, and the unusable combination is refused', async (t) => {
  // 'strict' is the default because an installation people visit directly should never
  // hand its session cookie to another site.
  const strict = await fixture(t)
  assert.match((await strict.register(OWNER, { adopt: false })).headers.get('set-cookie'), /SameSite=Strict/)

  // An embedded installation opts in. The point of the opt-in is that the *next* request
  // carries the cookie, so that is what is asserted, not just the header text.
  const embedded = await fixture(t, { cookieSameSite: 'none' })
  const r = await embedded.register(OWNER, { adopt: false })
  assert.match(r.headers.get('set-cookie'), /SameSite=None/)
  assert.match(r.headers.get('set-cookie'), /Secure/, 'a SameSite=None cookie without Secure is discarded by every browser')
  assert.equal((await embedded.request('GET', '/api/ready', undefined, { cookie: cookieOf(r) })).status, 200)

  // The value comes from an environment variable, so it arrives as a string in whatever
  // case somebody typed it.
  const lax = await fixture(t, { cookieSameSite: 'LAX' })
  assert.match((await lax.register(OWNER, { adopt: false })).headers.get('set-cookie'), /SameSite=Lax/)

  // Both refusals happen before anything is created on disk: a configuration this service
  // will not run with should not leave a half-written data directory behind.
  const refused = join(tmpdir(), `aetheris-cookie-refused-${process.pid}-${Date.now()}`)
  assert.throws(() => new OnlineApp({ dataDir: refused, cookieSameSite: 'none', secureCookie: false }),
    /SameSite=None requires a Secure cookie/)
  assert.throws(() => new OnlineApp({ dataDir: refused, cookieSameSite: 'sometimes' }),
    /must be one of strict, lax, none/)
  assert.equal(existsSync(refused), false, 'a refused configuration must not create a data directory')
  assert.deepEqual([...COOKIE_SAME_SITE], ['strict', 'lax', 'none'], 'the accepted values are documented in docs/20')
})

test('the production entrypoint binds the managed PORT and Vercel proxy sign-in/API is same-origin and secure', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const frontendOrigin = 'https://ragam.example'
  const env = {
    AETHERIS_ONLINE_DATA_DIR: dir, AETHERIS_CORE_HOST: '127.0.0.1', PORT: '0',
    AETHERIS_COOKIE_SECURE: 'true', AETHERIS_COOKIE_SAMESITE: 'strict',
    AETHERIS_TRUSTED_WEB_ORIGINS: frontendOrigin,
  }
  const lines = []
  let running = await main({ env, stdout: (line) => lines.push(line) })
  t.after(() => running.shutdown())
  assert.equal(running.config.cookieSameSite, 'strict')
  assert.deepEqual(running.config.trustedWebOrigins, [frontendOrigin])
  assert.equal(running.config.dataDir, dir, 'The configured data directory must be used')
  assert.ok(running.server.address().port > 0, 'Managed PORT must be used when AETHERIS_CORE_PORT is absent')
  assert.deepEqual(parseTrustedWebOrigins(`${frontendOrigin},${frontendOrigin}`), [frontendOrigin])
  assert.throws(() => parseTrustedWebOrigins('https://ragam.example/path'), /exact HTTPS origins/)
  assert.throws(() => parseTrustedWebOrigins('http://public.example'), /exact HTTPS origins/)
  assert.throws(() => parseTrustedWebOrigins('http://localhost:5173'), /exact HTTPS origins/)
  assert.throws(() => parseTrustedWebOrigins('https://user:secret@ragam.example'), (error) => {
    assert.match(error.message, /exact HTTPS origins/)
    assert.equal(error.message.includes('secret'), false, 'configuration errors must not echo credential-shaped values')
    return true
  })
  const invalidConfigLogs = []
  const invalidConfig = await main({ env: { AETHERIS_TRUSTED_WEB_ORIGINS: 'https://user:secret@ragam.example' }, stdout: (line) => invalidConfigLogs.push(line) })
    .then((instance) => ({ instance }), (error) => ({ error }))
  t.after(async () => { await invalidConfig.instance?.shutdown() })
  assert.ok(invalidConfig.error)
  assert.equal(invalidConfig.error.message.includes('secret'), false)
  assert.ok(invalidConfigLogs.some((line) => line.includes('"event":"configuration_invalid"')))
  assert.equal(invalidConfigLogs.some((line) => line.includes('secret')), false)

  let coreOrigin = `http://127.0.0.1:${running.server.address().port}`
  const proxy = createServer((req, res) => {
    void (async () => {
      // Simulate the Node serverless adapter pre-parsing JSON into req.body.
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      await proxyRequest(req, res, { coreOrigin, allowLoopbackForTests: true })
    })()
  })
  const proxyUrl = await listen(proxy)
  t.after(() => close(proxy))
  const browserHeaders = {
    origin: frontendOrigin,
    'sec-fetch-site': 'same-origin',
    'x-aetheris-request': '1',
  }

  const health = await fetch(`${proxyUrl}/api/health`, { headers: browserHeaders })
  assert.equal(health.status, 200)
  assert.match(health.headers.get('x-request-id'), /^[0-9a-f-]{36}$/i)
  assert.equal((await health.json()).status, 'ok')

  const registered = await fetch(`${proxyUrl}/api/auth/register`, {
    method: 'POST',
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  })
  assert.equal(registered.status, 201, await registered.text())
  const registrationCookie = registered.headers.get('set-cookie')
  assert.match(registrationCookie, /HttpOnly/)
  assert.match(registrationCookie, /Secure/)
  assert.match(registrationCookie, /SameSite=Strict/)
  assert.match(registrationCookie, /Path=\/api/)

  const loggedIn = await fetch(`${proxyUrl}/api/auth/login`, {
    method: 'POST',
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  })
  assert.equal(loggedIn.status, 200, await loggedIn.text())
  const cookie = loggedIn.headers.get('set-cookie')
  assert.match(cookie, /Secure/, 'the login cookie must also survive the Vercel proxy')

  const auth = await fetch(`${proxyUrl}/api/auth`, { headers: { cookie } })
  assert.equal(auth.status, 200)
  assert.equal((await auth.json()).authenticated, true, 'proxy must preserve the session cookie on the next request')
  const providers = await fetch(`${proxyUrl}/api/providers`, { headers: { cookie } })
  assert.equal(providers.status, 200, 'an authenticated application API call must survive the proxy')

  const forged = await fetch(`${proxyUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { ...browserHeaders, origin: 'https://untrusted.example', cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(forged.status, 403, 'Core must reject origins not explicitly trusted for the Vercel proxy')
  const originFailureLog = lines.map((line) => { try { return JSON.parse(line) } catch { return null } })
    .find((entry) => entry?.event === 'http_request_failed' && entry.errorCode === 'origin_rejected')
  assert.ok(originFailureLog?.requestId, 'API rejection logs carry a correlation id')
  assert.equal(JSON.stringify(originFailureLog).includes(OWNER.password), false, 'request logs must not include credentials')

  const logout = await fetch(`${proxyUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { ...browserHeaders, cookie, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
  assert.match(logout.headers.get('set-cookie'), /Secure/)
  const signedOut = await fetch(`${proxyUrl}/api/auth`, { headers: { cookie } })
  assert.equal((await signedOut.json()).authenticated, false, 'logout must revoke the server-side session')
  const deniedAfterLogout = await fetch(`${proxyUrl}/api/providers`, { headers: { cookie } })
  assert.equal(deniedAfterLogout.status, 401)

  assert.equal(existsSync(join(dir, 'accounts.sqlite')), true, 'registration must be stored under the configured data directory')
  await running.shutdown()
  running = await main({ env, stdout: () => {} })
  coreOrigin = `http://127.0.0.1:${running.server.address().port}`
  const afterRestart = await fetch(`${proxyUrl}/api/auth`, { headers: { cookie } })
  assert.equal((await afterRestart.json()).authenticated, false, 'the in-memory session must not survive a Core restart')
  const persistentLogin = await fetch(`${proxyUrl}/api/auth/login`, {
    method: 'POST',
    headers: { ...browserHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  })
  assert.equal(persistentLogin.status, 200, 'the account database must remain usable after a Core restart')

  const originalFindByEmail = running.app.accounts.findByEmail
  running.app.accounts.findByEmail = () => {
    const error = new Error('private SQLite file path and internal detail')
    error.code = 'ERR_SQLITE_ERROR'
    throw error
  }
  let databaseFailure
  try {
    databaseFailure = await fetch(`${proxyUrl}/api/auth/register`, {
      method: 'POST',
      headers: { ...browserHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'db-error@example.test', password: 'a-long-database-password' }),
    })
  } finally {
    running.app.accounts.findByEmail = originalFindByEmail
  }
  assert.equal(databaseFailure.status, 500)
  assert.deepEqual(await databaseFailure.json(), { error: 'internal_error', message: 'The request could not be completed.' })

  // Embedded mode remains opt-in and refuses the browser-invalid None-without-Secure pair.
  const refused = await main({ env: { ...env, AETHERIS_COOKIE_SAMESITE: 'none', AETHERIS_COOKIE_SECURE: 'false' }, stdout: () => {} })
    .then((instance) => ({ instance }), (error) => ({ error }))
  t.after(async () => { await refused.instance?.shutdown() })
  assert.ok(refused.error)
  assert.match(refused.error.message, /SameSite=None requires a Secure cookie/)
})

test('sessions belong to one account, roll over at the cap, and die with the process', async (t) => {
  const f = await fixture(t)
  await f.register(OWNER, { adopt: false })
  const cookies = []
  for (let index = 0; index < SESSIONS.perAccount + 2; index += 1) {
    const r = await f.login(OWNER, { adopt: false })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    cookies.push(cookieOf(r))
  }
  const mine = [...f.app.sessions.values()].filter((session) => session.email === OWNER.email)
  assert.equal(mine.length, SESSIONS.perAccount, 'the oldest sessions of that account are dropped, not the new sign-in')
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie: cookies.at(-1) })).data.authenticated, true)
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie: cookies[0] })).data.authenticated, false)
  // Sessions live in process memory: a restart signs everybody out, which is a property
  // worth stating rather than discovering during an incident.
  f.restart()
  assert.equal(f.app.sessions.size, 0)
  assert.equal(f.app.authenticated({ headers: { cookie: cookies.at(-1) } }), null)
})

// ---------------------------------------------------------------------------
// What an account can do
// ---------------------------------------------------------------------------

test('only the owner account changes the installation gateway; a member can still use it', async (t) => {
  const f = await fixture(t)
  const ownerCookie = await f.configure()
  assert.equal((await f.register(MEMBER, { adopt: false })).status, 201)
  // A real sign-in, not just a registration, so the login path is audited too.
  const member = await f.login(MEMBER, { adopt: false })
  const memberCookie = cookieOf(member)
  assert.notEqual(memberCookie, ownerCookie)

  const put = await f.request('PUT', '/api/providers/litellm', { baseUrl: `${f.gatewayUrl}/v1`, apiKey: 'another-synthetic-key' }, { cookie: memberCookie })
  assert.equal(put.status, 403); assert.equal(put.data.error, 'owner_required')
  assert.equal((await f.request('POST', '/api/providers/litellm/test', {}, { cookie: memberCookie })).status, 403)
  assert.equal((await f.request('POST', '/api/models/probe', {}, { cookie: memberCookie })).status, 403)
  assert.equal((await f.request('DELETE', '/api/providers/litellm', {}, { cookie: memberCookie })).status, 403)
  // The connection is readable, and still never carries the key.
  const visible = await f.request('GET', '/api/providers', undefined, { cookie: memberCookie })
  assert.equal(visible.status, 200); assert.equal(visible.data.keyConfigured, true); assert.equal(visible.data.apiKey, undefined)
  // A member can chat through it: refusing that would make the account useless.
  const chat = await f.request('POST', '/api/chat', f.chat(), { cookie: memberCookie })
  assert.equal(chat.status, 200, JSON.stringify(chat.data))
  assert.equal(chat.data.sentExternally, true)
  // The owner still can.
  assert.equal((await f.request('POST', '/api/models/probe', {}, { cookie: ownerCookie })).status, 200)

  const subjects = f.app.ledger.query({ limit: 200 }).map((row) => `${row.category}:${row.action}:${row.subject}`)
  assert.ok(subjects.some((row) => row.startsWith('auth:register:')), 'registration is audited')
  assert.ok(subjects.some((row) => row.startsWith('auth:login:')), 'sign-in is audited')
  assert.ok(subjects.some((row) => row.startsWith('provider:configure:')), 'a gateway change is audited')
  assert.ok(subjects.some((row) => row.startsWith('model:online_chat:')), 'inference is audited')
  assert.ok(!subjects.some((row) => row.endsWith(':owner')), 'no audit row may still be attributed to a generic owner')
  // The two accounts are separately attributable, which is the reason to have accounts.
  const ownerAccount = (await f.request('GET', '/api/auth', undefined, { cookie: ownerCookie })).data.account
  const memberAccount = member.data.account
  assert.ok(subjects.includes(`provider:configure:${ownerAccount.id}`))
  assert.ok(subjects.includes(`model:online_chat:${memberAccount.id}`))
})

test('history, memory and knowledge belong to the account that made them', async (t) => {
  const f = await fixture(t)
  const ownerCookie = await f.configure()
  const ownerAccount = (await f.request('GET', '/api/auth', undefined, { cookie: ownerCookie })).data.account

  const session = await f.request('POST', '/api/sessions', { title: 'owner only' }, { cookie: ownerCookie })
  assert.equal(session.status, 201)
  assert.equal((await f.request('POST', '/api/chat', f.chat({ sessionId: session.data.id }), { cookie: ownerCookie })).status, 200)
  assert.equal((await f.request('POST', '/api/knowledge/ingest', { title: 'owner note', text: 'The orchard gate opens at sunrise.', classification: 'public' }, { cookie: ownerCookie })).status, 201)
  assert.equal((await f.request('POST', '/api/memory', { text: 'The owner prefers short answers.' }, { cookie: ownerCookie })).status, 201)

  const member = await f.signIn(MEMBER)
  const memberCookie = cookieOf(member)
  assert.notEqual(member.data.account.id, ownerAccount.id)
  assert.deepEqual((await f.request('GET', '/api/sessions', undefined, { cookie: memberCookie })).data.sessions, [])
  assert.deepEqual((await f.request('GET', '/api/memory', undefined, { cookie: memberCookie })).data.memories, [])
  assert.deepEqual((await f.request('GET', '/api/knowledge/documents', undefined, { cookie: memberCookie })).data.documents, [])
  assert.equal((await f.request('GET', '/api/sessions/recall?q=orchard', undefined, { cookie: memberCookie })).data.hits.length, 0)
  // The owner's conversation id is not a key into somebody else's history.
  const cross = await f.request('POST', '/api/chat', f.chat({ sessionId: session.data.id }), { cookie: memberCookie })
  assert.equal(cross.status, 404); assert.equal(cross.data.error, 'session_not_found')
  assert.equal((await f.request('GET', `/api/sessions/${session.data.id}`, undefined, { cookie: memberCookie })).status, 404)
  // Neither is their knowledge, even when the member asks for it by name.
  const search = await f.request('POST', '/api/knowledge/search', { query: 'orchard gate' }, { cookie: memberCookie })
  assert.equal(search.data.results.length, 0)

  // Separate databases, not filters over one: the isolation does not depend on a query
  // remembering to include a WHERE clause.
  assert.equal(existsSync(join(f.dir, `memory-${ownerAccount.id}.sqlite`)), true)
  assert.equal(existsSync(join(f.dir, `memory-${member.data.account.id}.sqlite`)), true)
  assert.equal(existsSync(join(f.dir, `knowledge-${ownerAccount.id}.sqlite`)), true)
  // The member's own data is theirs, and the owner's is still intact.
  assert.equal((await f.request('POST', '/api/sessions', { title: 'member only' }, { cookie: memberCookie })).status, 201)
  assert.equal((await f.request('GET', '/api/sessions', undefined, { cookie: memberCookie })).data.sessions.length, 1)
  assert.equal((await f.request('GET', '/api/sessions', undefined, { cookie: ownerCookie })).data.sessions.length, 1)
  assert.equal((await f.request('GET', '/api/memory', undefined, { cookie: ownerCookie })).data.memories.length, 1)
  assert.equal((await f.request('GET', '/api/memory', undefined, { cookie: memberCookie })).data.memories.length, 0)
})

test('a single-operator installation hands its existing history to the first account', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-legacy-adopt-'))
  // What the pre-accounts product wrote: one shared store, no account ids anywhere.
  const legacy = new MemoryStore(join(dir, 'memory.sqlite'))
  const kept = legacy.startSession({ title: 'from before accounts' })
  legacy.appendTurn(kept.id, { role: 'user', content: 'older conversation', dataClass: 'internal' })
  legacy.close()
  assert.equal(existsSync(join(dir, 'memory.sqlite')), true)

  const f = await fixture(t, { dir })
  const owner = await f.register(OWNER, { adopt: false })
  const id = owner.data.account.id
  assert.equal(existsSync(join(dir, 'memory.sqlite')), false, 'the legacy store is adopted, not copied')
  assert.equal(existsSync(join(dir, `memory-${id}.sqlite`)), true)
  assert.equal(f.app.contextFor(id).memory.getSession(kept.id).title, 'from before accounts')
  // The second account gets an empty store; adoption happens once, for the owner.
  const member = await f.register(MEMBER, { adopt: false })
  assert.deepEqual(f.app.contextFor(member.data.account.id).memory.listSessions({ limit: 10 }), [])
})

// ---------------------------------------------------------------------------
// Password reset and change
// ---------------------------------------------------------------------------

test('a reset code is delivered on the host, works once, and ends every session', async (t) => {
  const f = await fixture(t)
  const signedIn = await f.register(OWNER, { adopt: false })
  const oldCookie = cookieOf(signedIn)

  // The answer does not depend on whether the address exists.
  const ghost = await f.request('POST', '/api/auth/password-reset/request', { email: 'nobody@example.test' }, { cookie: '' })
  const known = await f.request('POST', '/api/auth/password-reset/request', { email: OWNER.email }, { cookie: '' })
  assert.equal(ghost.status, 202); assert.equal(known.status, 202)
  assert.deepEqual(ghost.data, { requested: true, message: RESET_REQUESTED_MESSAGE })
  assert.deepEqual(known.data, ghost.data)
  assert.equal(f.resetCodes.length, 1, 'only a real account produces a code')
  assert.equal(f.resetCodes[0].email, OWNER.email)

  const code = f.resetCodes[0].code
  assert.ok(code.length >= 32)
  assert.ok(f.resetCodes[0].expiresAt - Date.now() <= RESET_CODE_TTL_MS)
  // The host-readable copy exists at 0600 and holds no password.
  assert.equal(statSync(join(f.dir, 'password-resets.json')).mode & 0o777, 0o600)
  assert.ok(!readFileSync(join(f.dir, 'password-resets.json'), 'utf8').includes(OWNER.password))
  assert.equal(f.app.accounts.pendingResets().length, 1)

  assert.equal((await f.request('POST', '/api/auth/password-reset/confirm', { email: OWNER.email, code: 'not-the-code', password: 'a-brand-new-password' }, { cookie: '' })).status, 400)
  assert.equal((await f.request('POST', '/api/auth/password-reset/confirm', { email: 'nobody@example.test', code, password: 'a-brand-new-password' }, { cookie: '' })).status, 400)
  // The new password may not be the old one.
  assert.equal((await f.request('POST', '/api/auth/password-reset/confirm', { email: OWNER.email, code, password: OWNER.password }, { cookie: '' })).data.error, 'weak_password')

  const done = await f.request('POST', '/api/auth/password-reset/confirm', { email: OWNER.email, code, password: 'a-brand-new-password' }, { cookie: '' })
  assert.equal(done.status, 200); assert.equal(done.data.reset, true)
  assert.equal((await f.request('POST', '/api/auth/login', { email: OWNER.email, password: 'a-brand-new-password' }, { cookie: '' })).status, 200)
  assert.equal((await f.request('POST', '/api/auth/login', OWNER, { cookie: '' })).status, 401)
  // Single use: the same code is now worthless.
  assert.equal((await f.request('POST', '/api/auth/password-reset/confirm', { email: OWNER.email, code, password: 'yet-another-new-password' }, { cookie: '' })).data.error, 'invalid_reset_code')
  assert.equal(f.app.accounts.pendingResets().length, 0)
  // The session open before the reset is dead, which is why somebody resets a password.
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie: oldCookie })).data.authenticated, false)
})

test('changing a password from inside a session keeps that session and drops the others', async (t) => {
  const f = await fixture(t)
  const keep = cookieOf(await f.register(OWNER, { adopt: false }))
  const dropped = cookieOf(await f.login(OWNER, { adopt: false }))
  assert.notEqual(keep, dropped)

  const wrong = await f.request('POST', '/api/auth/password', { currentPassword: 'not-my-password', newPassword: 'a-brand-new-password' }, { cookie: keep })
  assert.equal(wrong.status, 401); assert.equal(wrong.data.error, 'invalid_credentials')
  const changed = await f.request('POST', '/api/auth/password', { currentPassword: OWNER.password, newPassword: 'a-brand-new-password' }, { cookie: keep })
  assert.equal(changed.status, 200); assert.equal(changed.data.changed, true)
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie: keep })).data.authenticated, true)
  assert.equal((await f.request('GET', '/api/auth', undefined, { cookie: dropped })).data.authenticated, false)
  assert.equal((await f.request('POST', '/api/auth/login', { email: OWNER.email, password: 'a-brand-new-password' }, { cookie: '' })).status, 200)
  // An anonymous caller cannot reach the change route at all.
  assert.equal((await f.request('POST', '/api/auth/password', { currentPassword: OWNER.password, newPassword: 'another-new-password' }, { cookie: '' })).status, 401)
})

// ---------------------------------------------------------------------------
// The store on its own
// ---------------------------------------------------------------------------

test('the account store stands alone: caps, roles, reset lifetime and a repeatable close', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-store-only-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const codes = []
  const store = new AccountStore({ dir, maxAccounts: 1, onResetCode: (info) => codes.push(info) })
  t.after(() => store.close())

  const owner = store.register({ email: 'only@example.test', password: 'a-long-only-password' })
  assert.equal(owner.role, ROLES.OWNER)
  assert.throws(() => store.register({ email: 'second@example.test', password: 'a-long-second-password' }), /already has 1 account/)
  assert.equal(store.count(), 1)
  assert.equal(store.findByEmail('ONLY@example.test').id, owner.id)
  assert.equal(store.get(owner.id).email, 'only@example.test')
  assert.equal(store.findByEmail('absent@example.test'), null)

  // A requested code replaces the previous one, so an old code cannot be replayed later.
  const first = store.requestReset('only@example.test')
  const second = store.requestReset('only@example.test')
  assert.notEqual(first.code, second.code)
  assert.throws(() => store.confirmReset({ email: 'only@example.test', code: first.code, password: 'a-brand-new-password' }), /not valid/)
  assert.equal(store.confirmReset({ email: 'only@example.test', code: second.code, password: 'a-brand-new-password' }).id, owner.id)
  assert.equal(store.authenticate({ email: 'only@example.test', password: 'a-brand-new-password' }).id, owner.id)
  // An expired code is a dead code.
  const expired = store.requestReset('only@example.test', { now: Date.now() - RESET_CODE_TTL_MS - 1000 })
  assert.throws(() => store.confirmReset({ email: 'only@example.test', code: expired.code, password: 'another-new-password' }), /not valid/)
  assert.equal(store.requestReset('absent@example.test').created, false)
  assert.ok(codes.length >= 2, 'the host delivery hook is called for real accounts')
  // Closing twice must not throw: shutdown paths are allowed to overlap.
  store.close(); store.close()
})
