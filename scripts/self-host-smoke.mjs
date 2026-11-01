#!/usr/bin/env node
// End-to-end smoke against the loopback-only Caddy URL. No account or provider
// credentials are created; the checks prove the default local workspace contract.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const base = (process.env.RAGAM_SMOKE_URL || 'http://localhost').replace(/\/$/, '')
const mode = process.env.RAGAM_SMOKE_MODE || 'bootstrap'
const identityFile = process.env.RAGAM_SMOKE_ID_FILE || null
const deadline = Date.now() + 60_000

async function health() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) })
      if (response.status === 200 && (await response.json()).status === 'ok') return
    } catch { /* Compose services are still becoming healthy. */ }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Core health did not become ready through the local edge proxy.')
}

await health()
const status = await fetch(`${base}/api/auth`)
if (status.status !== 200) throw new Error(`Local workspace status returned HTTP ${status.status}.`)
const auth = await status.json()
if (auth.authenticated !== true || auth.mode !== 'local' || auth.account?.mode !== 'local' || auth.account?.role !== 'owner') {
  throw new Error('The default Compose stack did not open a local single-user workspace.')
}
if ('email' in auth.account || status.headers.get('set-cookie')) {
  throw new Error('Local mode exposed an email identity or issued an account session cookie.')
}

const configResponse = await fetch(`${base}/api/config`)
if (configResponse.status !== 200) throw new Error(`Local config returned HTTP ${configResponse.status}.`)
const config = await configResponse.json()
if (config.auth?.mode !== 'local' || 'email' in (config.auth?.account ?? {})) {
  throw new Error('The config response exposed account/email authentication in local mode.')
}

const catalogueResponse = await fetch(`${base}/api/providers/catalog`)
if (catalogueResponse.status !== 200) throw new Error(`Provider catalogue returned HTTP ${catalogueResponse.status}.`)
const catalogue = await catalogueResponse.json()
for (const id of ['openai', 'gemini', 'anthropic', 'xai']) {
  if (!catalogue.providers?.some((provider) => provider.id === id)) throw new Error(`Provider adapter '${id}' is missing from the catalogue.`)
}

const register = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
  body: JSON.stringify({ username: 'unexpected', password: 'not-a-real-account' }),
})
if (register.status !== 404) throw new Error(`Account creation should be disabled, got HTTP ${register.status}.`)

if (mode === 'bootstrap') {
  const title = `Ragam CI restore marker ${randomUUID()}`
  const sessionResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' },
    body: JSON.stringify({ title }),
  })
  if (sessionResponse.status !== 201) throw new Error(`Could not create a local restore marker, got HTTP ${sessionResponse.status}.`)
  const session = await sessionResponse.json()
  if (!session.id || session.title !== title) throw new Error('The restore marker response had no persistent session id or title.')
  if (identityFile) writeFileSync(identityFile, `${JSON.stringify({ accountId: auth.account.id, sessionId: session.id, title })}\n`)
} else if (mode === 'verify') {
  if (!identityFile) throw new Error('RAGAM_SMOKE_ID_FILE is required in verify mode.')
  const expected = JSON.parse(readFileSync(identityFile, 'utf8'))
  if (auth.account.id !== expected.accountId) throw new Error('The local workspace identity did not survive the cold-volume restore.')
  const sessionsResponse = await fetch(`${base}/api/sessions`)
  if (sessionsResponse.status !== 200) throw new Error(`Session history returned HTTP ${sessionsResponse.status} after restore.`)
  const sessions = await sessionsResponse.json()
  if (!sessions.sessions?.some((session) => session.id === expected.sessionId && session.title === expected.title)) {
    throw new Error('The SQLite conversation-history marker did not survive the cold-volume restore.')
  }
} else {
  throw new Error('RAGAM_SMOKE_MODE must be bootstrap or verify.')
}

console.log(`Self-host ${mode} smoke passed: localhost-only workspace, no account/email/cookie, provider catalogue, and restored SQLite history.`)
