#!/usr/bin/env node
// Active product entry: online inference only, signed in with an account. Legacy research is not imported.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnlineApp } from './online/app.mjs'
import { DEFAULT_MAX_ACCOUNTS } from './online/accounts.mjs'
export async function main({ env = process.env, stdout = console.log } = {}) {
  const config = {
    dataDir: env.AETHERIS_ONLINE_DATA_DIR || resolve('.aetheris-data/online'),
    // Exact origins the operator trusts for an endpoint that would otherwise be refused: a
    // private or loopback LiteLLM gateway, or a local Ollama / llama.cpp server. The first
    // name is the general one; AETHERIS_LITELLM_TRUSTED_ORIGINS is still read, so an existing
    // installation keeps working unchanged.
    trustedOrigins: [env.AETHERIS_TRUSTED_ORIGINS || '', env.AETHERIS_LITELLM_TRUSTED_ORIGINS || ''].join(',').split(',').map((s) => s.trim()).filter(Boolean),
    secureCookie: env.AETHERIS_COOKIE_SECURE !== 'false',
    // 'strict' never sends the session cookie on a cross-site request, which is right for
    // an installation visited directly and breaks one served inside another site's iframe.
    // 'none' is the opt-in for that; OnlineApp refuses it without a Secure cookie.
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
  const app = new OnlineApp(config), server = app.server()
  const port = Number(env.AETHERIS_CORE_PORT || 8790), host = env.AETHERIS_CORE_HOST || '0.0.0.0'
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done) })
  stdout(`Aetheris online-only API listening on ${host}:${server.address().port}`)
  stdout(`  data dir   ${config.dataDir}`)
  const accounts = app.accounts.count()
  if (accounts === 0) stdout('  sign-in    no accounts yet — open the web app and create the first one; it becomes the owner')
  else stdout(`  sign-in    ${accounts} account(s); owner ${app.accounts.owner()?.email ?? 'none'}`)
  if (config.cookieSameSite !== 'strict') {
    stdout(`  cookie     SameSite=${config.cookieSameSite}${config.secureCookie ? ' + Secure' : ''} — the session is sent on cross-site requests, so this app can be embedded in another site; mutations still require the x-aetheris-request header`)
  }
  stdout('Configure an online gateway (LiteLLM, Ollama or llama.cpp server) in Provider Settings. No local inference or automatic model downloads.')
  const shutdown = async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); app.close() }
  return { app, server, config, shutdown, exitCode: 0 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await main()
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (stopping) return; stopping = true; await running.shutdown(); process.exit(0) })
}
