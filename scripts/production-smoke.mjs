#!/usr/bin/env node
// Read-only with respect to accounts: signs into a pre-provisioned, dedicated smoke-test
// account, checks the public Vercel -> configured Core path, then signs out. Optional persistence
// modes create/verify/delete one harmless memory marker for an explicit restart test.

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function publicOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('RAGAM_PUBLIC_URL must be a valid HTTPS origin.') }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('RAGAM_PUBLIC_URL must be an exact HTTPS origin with no path, credentials, query, or fragment.')
  }
  return url.origin
}

function cookieFrom(response) {
  const cookies = response.headers.getSetCookie?.() ?? []
  const header = cookies[0] ?? response.headers.get('set-cookie') ?? ''
  const pair = header.split(';', 1)[0]
  if (!pair.startsWith('aetheris_session=') || pair.length <= 'aetheris_session='.length) {
    throw new Error('The sign-in response did not issue a session cookie.')
  }
  return pair
}

function assertCookiePolicy(response) {
  const cookies = response.headers.getSetCookie?.() ?? []
  const header = cookies.find((value) => value.startsWith('aetheris_session=')) ?? response.headers.get('set-cookie') ?? ''
  for (const [pattern, description] of [
    [/\bHttpOnly\b/i, 'HttpOnly'],
    [/\bSecure\b/i, 'Secure'],
    [/\bSameSite=Strict\b/i, 'SameSite=Strict'],
    [/\bPath=\/api(?:;|$)/i, 'Path=/api'],
    [/\bMax-Age=(?!0\b)\d+/i, 'a positive session lifetime'],
  ]) {
    if (!pattern.test(header)) throw new Error(`The session cookie is missing ${description}.`)
  }
}

async function jsonRequest(base, path, { method = 'GET', cookie, body, origin = base, fetchSite = 'same-origin' } = {}) {
  const headers = {
    accept: 'application/json',
    origin,
    'sec-fetch-site': fetchSite,
    'x-aetheris-request': '1',
  }
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  let payload = null
  try { payload = await response.json() } catch { /* status checks below report a safe message */ }
  return { response, payload }
}

async function signOut(base, cookie) {
  const { response: logout, payload: logoutPayload } = await jsonRequest(base, '/api/auth/logout', {
    method: 'POST', cookie, body: {},
  })
  if (logout.status !== 200 || logoutPayload?.authenticated !== false) throw new Error(`Sign-out failed (HTTP ${logout.status}).`)
  const clearCookies = logout.headers.getSetCookie?.() ?? [logout.headers.get('set-cookie') ?? '']
  if (!clearCookies.some((value) => /aetheris_session=/.test(value) && /\bMax-Age=0\b/i.test(value))) {
    throw new Error('Sign-out did not clear the session cookie.')
  }
  const { response: afterLogout, payload: afterLogoutPayload } = await jsonRequest(base, '/api/auth', { cookie })
  if (afterLogout.status !== 200 || afterLogoutPayload?.authenticated !== false) {
    throw new Error(`The signed-out session remained valid (HTTP ${afterLogout.status}).`)
  }
}

async function checkPersistence(base, cookie, mode, markerId) {
  if (mode === '') return
  if (!['--persistence-write', '--persistence-verify'].includes(mode)) {
    throw new Error('Supported modes: --persistence-write or --persistence-verify.')
  }
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(markerId ?? '')) {
    throw new Error('Set RAGAM_SMOKE_MARKER_ID to a unique 8–80 character identifier for the persistence check.')
  }
  const marker = `RAGAM deployment storage smoke marker ${markerId}`
  const listed = async () => {
    const { response, payload } = await jsonRequest(base, '/api/memory?limit=200', { cookie })
    if (response.status !== 200 || !Array.isArray(payload?.memories)) throw new Error(`Memory storage read failed (HTTP ${response.status}).`)
    return payload.memories
  }

  if (mode === '--persistence-write') {
    if ((await listed()).some((item) => item.text === marker)) {
      throw new Error(`Storage marker ${markerId} already exists; use --persistence-verify after the restart.`)
    }
    const { response, payload } = await jsonRequest(base, '/api/memory', {
      method: 'POST', cookie,
      body: { text: marker, kind: 'fact', dataClass: 'internal', tags: ['deployment-smoke'] },
    })
    if (response.status !== 201 || payload?.memory?.text !== marker) throw new Error(`Storage marker write failed (HTTP ${response.status}).`)
    if (!(await listed()).some((item) => item.text === marker)) throw new Error('Storage marker could not be read back after writing.')
    console.log(`OK: harmless storage marker written and read (${markerId}). Restart Core, then run --persistence-verify with the same marker id.`)
    return
  }

  const markerRecord = (await listed()).find((item) => item.text === marker)
  if (!markerRecord?.id) throw new Error(`Storage marker ${markerId} was not found after restart.`)
  const { response } = await jsonRequest(base, `/api/memory/${encodeURIComponent(markerRecord.id)}`, {
    method: 'DELETE', cookie,
    body: { reason: 'Removed after the explicitly requested production storage smoke test.' },
  })
  if (response.status !== 200) throw new Error(`Storage marker cleanup failed (HTTP ${response.status}).`)
  if ((await listed()).some((item) => item.text === marker)) throw new Error('Storage marker remained visible after cleanup.')
  console.log(`OK: storage marker survived the restart and was removed (${markerId})`)
}

async function main() {
  const rawBase = process.env.RAGAM_PUBLIC_URL
  const email = process.env.RAGAM_SMOKE_EMAIL
  const password = process.env.RAGAM_SMOKE_PASSWORD
  const mode = process.argv[2] ?? ''
  const markerId = process.env.RAGAM_SMOKE_MARKER_ID
  if (!rawBase || !email || !password) {
    throw new Error('Set RAGAM_PUBLIC_URL, RAGAM_SMOKE_EMAIL, and RAGAM_SMOKE_PASSWORD for a dedicated smoke-test account.')
  }
  if (!['', '--persistence-write', '--persistence-verify'].includes(mode)) {
    throw new Error('Supported modes: --persistence-write or --persistence-verify.')
  }
  if (mode && !/^[A-Za-z0-9._-]{8,80}$/.test(markerId ?? '')) {
    throw new Error('Set RAGAM_SMOKE_MARKER_ID to a unique 8–80 character identifier for the persistence check.')
  }
  const base = publicOrigin(rawBase)

  const { response: health, payload: healthPayload } = await jsonRequest(base, '/api/health')
  if (health.status !== 200 || healthPayload?.status !== 'ok') throw new Error(`Health check failed (HTTP ${health.status}).`)
  console.log('OK: public health endpoint')

  const { response: signedOut, payload: signedOutPayload } = await jsonRequest(base, '/api/auth')
  if (signedOut.status !== 200 || signedOutPayload?.authenticated !== false) {
    throw new Error(`Expected a signed-out authentication status (HTTP ${signedOut.status}).`)
  }
  console.log('OK: signed-out authentication status')

  const { response: untrustedLogout } = await jsonRequest(base, '/api/auth/logout', {
    method: 'POST', body: {}, origin: 'https://untrusted-smoke.invalid', fetchSite: 'cross-site',
  })
  if (untrustedLogout.status !== 403) throw new Error(`An untrusted origin was not rejected (HTTP ${untrustedLogout.status}).`)
  console.log('OK: untrusted-origin mutation rejected through the proxy')

  const { response: login, payload: loginPayload } = await jsonRequest(base, '/api/auth/login', {
    method: 'POST', body: { email, password },
  })
  if (login.status !== 200 || loginPayload?.authenticated !== true) throw new Error(`Sign-in failed (HTTP ${login.status}).`)
  const cookie = cookieFrom(login)
  let checkError = null
  try {
    assertCookiePolicy(login)
    console.log('OK: sign-in and secure session cookie')

    const { response: auth, payload: authPayload } = await jsonRequest(base, '/api/auth', { cookie })
    if (auth.status !== 200 || authPayload?.authenticated !== true) throw new Error(`Authenticated status check failed (HTTP ${auth.status}).`)
    const { response: providers } = await jsonRequest(base, '/api/providers', { cookie })
    if (providers.status !== 200) throw new Error(`Authenticated API request failed (HTTP ${providers.status}).`)
    console.log('OK: authenticated status and API request')

    await checkPersistence(base, cookie, mode, markerId)
  } catch (error) {
    checkError = error
  }

  try {
    await signOut(base, cookie)
    console.log('OK: sign-out and session invalidation')
  } catch (error) {
    if (!checkError) checkError = error
  }
  if (checkError) throw checkError
  console.log('Smoke checks passed for the supplied public URL. A successful persistence check still requires an actual Core restart.')
}

main().catch((error) => fail(error?.message ?? 'Smoke test failed.'))
