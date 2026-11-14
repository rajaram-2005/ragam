import { randomBytes } from 'node:crypto'

const base = process.env.RAGAM_DAST_BASE_URL
if (base !== 'http://edge:8080') {
  console.log(`RAGAM_DAST_PROBE_JSON=${JSON.stringify({ schema: 'ragam-dast-authz-probes/1', probes: [], fatal: 'refused_non_local_target' })}`)
  process.exit(2)
}
const origin = base
const probes = []

async function request(method, path, { body, cookie } = {}) {
  const headers = {
    accept: 'application/json',
    origin,
    'x-aetheris-request': '1',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  let data = null
  try { data = await response.json() } catch { /* response body is never copied into evidence */ }
  const errorCode = typeof data?.error === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(data.error) ? data.error : null
  return { status: response.status, errorCode, data, setCookie: response.headers.get('set-cookie') ?? '' }
}

function record({ id, method, path, expectedStatus, result, predicate = null, expectedAuthenticated, expectedRole }) {
  const actualAuthenticated = typeof result.data?.authenticated === 'boolean' ? result.data.authenticated : null
  const actualRole = ['owner', 'member'].includes(result.data?.account?.role) ? result.data.account.role : null
  const passed = result.status === expectedStatus
    && (expectedAuthenticated === undefined || actualAuthenticated === expectedAuthenticated)
    && (expectedRole === undefined || actualRole === expectedRole)
    && (!predicate || predicate(result))
  probes.push({
    id,
    method,
    path,
    expectedStatus,
    actualStatus: result.status,
    actualErrorCode: result.errorCode,
    ...(expectedAuthenticated === undefined ? {} : { expectedAuthenticated, actualAuthenticated }),
    ...(expectedRole === undefined ? {} : { expectedRole, actualRole }),
    passed,
  })
  return passed
}

function sessionCookie(header) {
  const match = /(?:^|;\s*)aetheris_session=([A-Za-z0-9_-]+)/.exec(header)
  return match ? `aetheris_session=${match[1]}` : null
}

async function main() {
  let failed = false
  const check = (item) => { if (!record(item)) failed = true }
  const anonymousAuth = await request('GET', '/api/auth')
  check({
    id: 'anonymous-session-is-not-authenticated', method: 'GET', path: '/api/auth', expectedStatus: 200,
    result: anonymousAuth, expectedAuthenticated: false, predicate: (value) => value.data?.authenticated === false,
  })
  const anonymousConfig = await request('GET', '/api/config')
  check({ id: 'anonymous-private-config-rejected', method: 'GET', path: '/api/config', expectedStatus: 401, result: anonymousConfig })

  const ownerPassword = randomBytes(32).toString('base64url')
  const ownerRegistration = await request('POST', '/api/auth/register', {
    body: { email: 'security-owner@example.invalid', password: ownerPassword },
  })
  const ownerCookie = sessionCookie(ownerRegistration.setCookie)
  check({ id: 'synthetic-owner-bootstrap', method: 'POST', path: '/api/auth/register', expectedStatus: 201, result: ownerRegistration, expectedRole: 'owner', predicate: (value) => Boolean(ownerCookie) && value.data?.account?.role === 'owner' })

  if (ownerCookie) {
    const ownerAuth = await request('GET', '/api/auth', { cookie: ownerCookie })
    check({ id: 'synthetic-owner-session-role', method: 'GET', path: '/api/auth', expectedStatus: 200, result: ownerAuth, expectedAuthenticated: true, expectedRole: 'owner', predicate: (value) => value.data?.authenticated === true && value.data?.account?.role === 'owner' })
  }

  const memberPassword = randomBytes(32).toString('base64url')
  const memberRegistration = await request('POST', '/api/auth/register', {
    body: { email: 'security-member@example.invalid', password: memberPassword },
  })
  const memberCookie = sessionCookie(memberRegistration.setCookie)
  check({ id: 'synthetic-member-registration', method: 'POST', path: '/api/auth/register', expectedStatus: 201, result: memberRegistration, expectedRole: 'member', predicate: (value) => Boolean(memberCookie) && value.data?.account?.role === 'member' })

  if (memberCookie) {
    const memberAuth = await request('GET', '/api/auth', { cookie: memberCookie })
    check({ id: 'synthetic-member-session-role', method: 'GET', path: '/api/auth', expectedStatus: 200, result: memberAuth, expectedAuthenticated: true, expectedRole: 'member', predicate: (value) => value.data?.authenticated === true && value.data?.account?.role === 'member' })

    // These routes check owner authorization before reading a body, touching saved
    // provider configuration, or making any provider/network call.
    const ownerProbe = await request('POST', '/api/models/probe', { cookie: memberCookie, body: {} })
    check({ id: 'member-cannot-probe-provider-models', method: 'POST', path: '/api/models/probe', expectedStatus: 403, result: ownerProbe })
    const ownerActivate = await request('PUT', '/api/providers/active', { cookie: memberCookie, body: { id: 'ollama' } })
    check({ id: 'member-cannot-change-active-provider', method: 'PUT', path: '/api/providers/active', expectedStatus: 403, result: ownerActivate })
    const providerTest = await request('POST', '/api/providers/ollama/test', { cookie: memberCookie, body: {} })
    check({ id: 'member-cannot-test-provider-connection', method: 'POST', path: '/api/providers/ollama/test', expectedStatus: 403, result: providerTest })
    const providerHardware = await request('GET', '/api/providers/ollama/hardware', { cookie: memberCookie })
    check({ id: 'member-cannot-read-owner-provider-hardware', method: 'GET', path: '/api/providers/ollama/hardware', expectedStatus: 403, result: providerHardware })
    const pluginConnect = await request('POST', '/api/plugins/connect', { cookie: memberCookie, body: {} })
    check({ id: 'member-cannot-connect-owner-plugin', method: 'POST', path: '/api/plugins/connect', expectedStatus: 403, result: pluginConnect })
  }

  const report = {
    schema: 'ragam-dast-authz-probes/1',
    target: base,
    generatedAt: new Date().toISOString(),
    accounts: 'synthetic in-memory credentials; values and session cookies are not recorded',
    probes,
  }
  console.log(`RAGAM_DAST_PROBE_JSON=${JSON.stringify(report)}`)
  if (failed || probes.some((probe) => !probe.passed)) process.exitCode = 1
}

main().catch(() => {
  const report = {
    schema: 'ragam-dast-authz-probes/1',
    target: base,
    generatedAt: new Date().toISOString(),
    probes,
    fatal: 'A local request failed before all authentication/authorization boundaries could be checked; raw exception details withheld.',
  }
  console.log(`RAGAM_DAST_PROBE_JSON=${JSON.stringify(report)}`)
  process.exitCode = 1
})
