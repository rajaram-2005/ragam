#!/usr/bin/env node
// End-to-end smoke against the public Caddy URL. Synthetic account only; never use
// production credentials or real user data with this script.
const base = (process.env.RAGAM_SMOKE_URL || 'http://127.0.0.1').replace(/\/$/, '')
const email = process.env.RAGAM_SMOKE_EMAIL || 'owner@example.test'
const password = process.env.RAGAM_SMOKE_PASSWORD || 'a-long-smoke-test-password'
const mode = process.env.RAGAM_SMOKE_MODE || 'bootstrap'
const deadline = Date.now() + 60_000

async function health() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.status === 200 && (await response.json()).status === 'ok') return
    } catch { /* Compose services are still becoming healthy. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Core health did not become ready through the edge proxy.')
}

async function register(account) {
  return fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify(account),
  })
}

await health()
if (mode === 'bootstrap') {
  const owner = await register({ email, password })
  if (owner.status !== 201) throw new Error(`Owner bootstrap returned HTTP ${owner.status}.`)
  const payload = await owner.json()
  if (payload.account?.role !== 'owner') throw new Error('The configured first account was not assigned the owner role.')
  const member = await register({ email: 'member@example.test', password: 'a-long-member-test-password' })
  if (member.status !== 403 || (await member.json()).error !== 'registration_closed') {
    throw new Error('Member registration was not closed by default.')
  }
} else if (mode !== 'verify') {
  throw new Error('RAGAM_SMOKE_MODE must be bootstrap or verify.')
}

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
  body: JSON.stringify({ email, password }),
})
if (login.status !== 200) throw new Error(`Owner sign-in returned HTTP ${login.status}.`)
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
if (!cookie) throw new Error('Core did not issue an owner session cookie.')
const auth = await fetch(`${base}/api/auth`, { headers: { cookie } })
if (auth.status !== 200 || (await auth.json()).authenticated !== true) {
  throw new Error('The authenticated session did not survive an API request.')
}
console.log(`Self-host ${mode} smoke passed: health, owner sign-in, session, and closed registration.`)
