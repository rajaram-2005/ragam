#!/usr/bin/env node
// Active product entry: online inference only, signed in with an account. Legacy research is not imported.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnlineApp } from './online/app.mjs'

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

  const maxAccounts = env.AETHERIS_MAX_ACCOUNTS?.trim() ? Number(env.AETHERIS_MAX_ACCOUNTS) : 1
  if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 10_000) {
    log({ event: 'configuration_invalid', variable: 'AETHERIS_MAX_ACCOUNTS', errorCode: 'invalid_max_accounts' })
    throw new Error('AETHERIS_MAX_ACCOUNTS must be a whole number from 1 to 10000.')
  }
  const localSingleUser = env.AETHERIS_LOCAL_SINGLE_USER === 'true'
  const config = {
    localSingleUser,
    dataDir: env.AETHERIS_ONLINE_DATA_DIR || resolve('.aetheris-data/online'),
    // Provider destinations are a separate allowlist from browser origins.
    trustedOrigins: [env.AETHERIS_TRUSTED_ORIGINS || '', env.AETHERIS_LITELLM_TRUSTED_ORIGINS || ''].join(',').split(',').map((s) => s.trim()).filter(Boolean),
    trustedWebOrigins,
    secureCookie: env.AETHERIS_COOKIE_SECURE !== 'false',
    // 'strict' is the same-origin default for the Docker-served web app. Use 'none'
    // only for a genuinely cross-site embedded deployment; OnlineApp requires Secure.
    cookieSameSite: (env.AETHERIS_COOKIE_SAMESITE || 'strict').trim().toLowerCase(),
    // Public self-host installs begin with exactly one explicitly configured owner.
    // Additional accounts require an operator opt-in and a larger explicit cap.
    maxAccounts,
    ownerEmail: localSingleUser ? null : (env.AETHERIS_OWNER_EMAIL?.trim() || null),
    registrationEnabled: !localSingleUser && env.AETHERIS_ALLOW_ACCOUNT_REGISTRATION === 'true',
    // A password reset cannot be emailed: this product has no mail transport. The code is
    // always written to `password-resets.json` inside the data directory (mode 0600, the
    // same boundary as the provider master key). Printing it too is an explicit operator
    // choice, because a console is very often somebody's log aggregator.
    onResetCode: !localSingleUser && env.AETHERIS_PRINT_RESET_CODES === 'true'
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
  const port = Number(env.AETHERIS_CORE_PORT || env.PORT || 8790), host = env.AETHERIS_CORE_HOST || (localSingleUser ? '127.0.0.1' : '0.0.0.0')
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
  if (localSingleUser) stdout('  access     single-user workspace, localhost only; no account or email login')
  else {
    const accounts = await app.accounts.count()
    if (accounts === 0) {
      stdout(config.ownerEmail
        ? '  sign-in    owner bootstrap is limited to AETHERIS_OWNER_EMAIL; member registration is closed by default'
        : '  sign-in    registration is closed; configure AETHERIS_OWNER_EMAIL before creating the owner account')
    } else stdout(`  sign-in    ${accounts} account(s); owner ${(await app.accounts.owner()) ? 'configured' : 'missing'}`)
  }
  if (config.cookieSameSite !== 'strict') {
    stdout(`  cookie     SameSite=${config.cookieSameSite}${config.secureCookie ? ' + Secure' : ''} — the session is sent on cross-site requests, so this app can be embedded in another site; mutations still require the x-aetheris-request header`)
  }
  stdout('Configure a supported provider in Provider Settings. Model ids are fetched from its configured account; no local inference, guessed model list or automatic fallback.')
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
