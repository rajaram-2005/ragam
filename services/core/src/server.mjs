#!/usr/bin/env node
// Active product entry: online inference only, signed in with an account. Legacy research is not imported.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnlineApp } from './online/app.mjs'
import { DEFAULT_MAX_ACCOUNTS } from './online/accounts.mjs'

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : 'startup_failed'
}

export function parseTrustedWebOrigins(value = '') {
  if (!String(value).trim()) return []
  return [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    let parsed
    try { parsed = new URL(item) } catch { throw new Error('AETHERIS_TRUSTED_WEB_ORIGINS contains an invalid origin.') }
    if (parsed.protocol !== 'https:' || parsed.origin !== item || parsed.username || parsed.password) {
      throw new Error('AETHERIS_TRUSTED_WEB_ORIGINS entries must be exact HTTPS origins, without paths or wildcards.')
    }
    return parsed.origin
  }))]
}

export async function main({ env = process.env, stdout = console.log } = {}) {
  const log = (record) => stdout(JSON.stringify({ timestamp: new Date().toISOString(), ...record }))
  let trustedWebOrigins
  try {
    trustedWebOrigins = parseTrustedWebOrigins(env.AETHERIS_TRUSTED_WEB_ORIGINS || '')
  } catch (error) {
    log({ event: 'configuration_invalid', variable: 'AETHERIS_TRUSTED_WEB_ORIGINS', errorCode: 'invalid_trusted_web_origin' })
    throw error
  }

  const config = {
    dataDir: env.AETHERIS_ONLINE_DATA_DIR || resolve('.aetheris-data/online'),
    // Provider destinations are a separate allowlist from browser origins.
    trustedOrigins: [env.AETHERIS_TRUSTED_ORIGINS || '', env.AETHERIS_LITELLM_TRUSTED_ORIGINS || ''].join(',').split(',').map((s) => s.trim()).filter(Boolean),
    trustedWebOrigins,
    secureCookie: env.AETHERIS_COOKIE_SECURE !== 'false',
    // 'strict' works when the browser talks to the same-origin Vercel proxy. Use 'none'
    // only for a genuinely cross-site embedded deployment; OnlineApp requires Secure.
    cookieSameSite: (env.AETHERIS_COOKIE_SAMESITE || 'strict').trim().toLowerCase(),
    maxAccounts: Number(env.AETHERIS_MAX_ACCOUNTS || DEFAULT_MAX_ACCOUNTS),
    // A password reset cannot be emailed: this product has no mail transport. The code is
    // always written to `password-resets.json` inside the data directory (mode 0600, the
    // same boundary as the provider master key). Printing it too is an explicit operator
    // choice, because a console is very often somebody's log aggregator.
    onResetCode: env.AETHERIS_PRINT_RESET_CODES === 'true'
      ? ({ email, code, expiresAt }) => stdout(`password reset code for ${email}: ${code} (single use, expires ${new Date(expiresAt).toISOString()})`)
      : null,
  }
  let app
  try {
    app = new OnlineApp({
      ...config,
      timeoutMs: Number(env.AETHERIS_ONLINE_TIMEOUT_MS || 120_000),
      logger: (record) => log(record),
    })
  } catch (error) {
    log({ event: 'core_startup_failed', stage: 'initialize', errorCode: safeErrorCode(error) })
    throw error
  }
  const server = app.server()
  // Render (and other managed web hosts) inject PORT. AETHERIS_CORE_PORT remains the
  // explicit override for local installs; PORT is the deployment-platform fallback.
  const port = Number(env.AETHERIS_CORE_PORT || env.PORT || 8790), host = env.AETHERIS_CORE_HOST || '0.0.0.0'
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done) })
  } catch (error) {
    app.close()
    log({ event: 'core_startup_failed', stage: 'listen', errorCode: safeErrorCode(error) })
    throw error
  }
  log({ event: 'core_started', host, port: server.address().port, dataDir: config.dataDir, nodeVersion: process.versions.node })
  stdout(`Aetheris online-only API listening on ${host}:${server.address().port}`)
  stdout(`  data dir   ${config.dataDir}`)
  const accounts = app.accounts.count()
  if (accounts === 0) stdout('  sign-in    no accounts yet — open the web app and create the first one; it becomes the owner')
  else stdout(`  sign-in    ${accounts} account(s); owner ${app.accounts.owner() ? 'configured' : 'missing'}`)
  if (config.cookieSameSite !== 'strict') {
    stdout(`  cookie     SameSite=${config.cookieSameSite}${config.secureCookie ? ' + Secure' : ''} — the session is sent on cross-site requests, so this app can be embedded in another site; mutations still require the x-aetheris-request header`)
  }
  stdout('Configure an online gateway (LiteLLM, Ollama or llama.cpp server) in Provider Settings. No local inference or automatic model downloads.')
  let closed = false
  const shutdown = async () => {
    if (closed) return
    closed = true
    log({ event: 'core_shutdown_started' })
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    app.close()
    log({ event: 'core_shutdown_complete' })
  }
  return { app, server, config, shutdown, exitCode: 0 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await main()
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (stopping) return; stopping = true; await running.shutdown(); process.exit(0) })
}
