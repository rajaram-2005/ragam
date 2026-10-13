#!/usr/bin/env node
// Aetheris Omni core service — process entry point.
//
// Everything interesting lives in ./app.mjs; this file only does the parts that
// belong to a process: read configuration, boot the app, bind a socket, and shut
// down cleanly. It is deliberately thin so the same app object can be embedded in
// tests (see test/offline.test.mjs) without starting a server.
//
// Security notes that apply here specifically:
//   * Secrets are read from the environment or from *_FILE paths only. They are
//     never printed, never written to the audit log, and never served by any
//     route — /api/config returns publicConfig(), which redacts them.
//   * The egress guard is installed by the app constructor over globalThis.fetch,
//     so the runtime policy applies to this whole process, not just to code that
//     remembers to ask.
//   * `host` defaults to 0.0.0.0 so the service is reachable from a container or
//     a preview proxy. That is a bind address, not an authorisation decision:
//     `allowedOrigin` governs which browser origins may call the API, and it
//     defaults to same-origin only.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AetherisOmniApp, createHttpServer } from './app.mjs'
import { loadConfig, loadDotEnv, publicConfig } from './config.mjs'
import { RUNTIME_POLICIES } from './policy/egress.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Fill in .env values without overriding anything already set in the environment. */
function applyDotEnv(env = process.env, cwd = resolve(here, '..')) {
  const parsed = loadDotEnv(cwd)
  let applied = 0
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value
      applied += 1
    }
  }
  return applied
}

export async function main({ env = process.env, stdout = console.log, stderr = console.error } = {}) {
  const dotEnvApplied = applyDotEnv(env, resolve(here, '..'))

  let config
  try {
    config = loadConfig(env)
  } catch (error) {
    stderr(`aetheris-core: configuration error — ${error.message}`)
    return { exitCode: 2, server: null, app: null }
  }

  // Configuration problems are reported before anything binds, so a typo cannot
  // silently disable a safety control.
  for (const warning of config.warnings) stderr(`aetheris-core: warning — ${warning}`)
  let app
  try {
    app = new AetherisOmniApp({ config })
  } catch (error) {
    stderr(`aetheris-core: startup failed — ${error.message}`)
    return { exitCode: 2, server: null, app: null }
  }

  // Probe local runtimes so readiness reflects what is actually installed, and
  // register whatever models they report. A missing runtime is a degraded state,
  // not a fatal one: the service still starts and still answers honestly.
  let probe
  try {
    probe = await app.probeAll()
  } catch (error) {
    stderr(`aetheris-core: model probe failed — ${error.message}`)
    probe = null
  }

  const server = createHttpServer(app)
  await new Promise((listen, fail) => {
    server.once('error', fail)
    server.listen(config.port, config.host, listen)
  }).catch((error) => {
    stderr(`aetheris-core: cannot bind ${config.host}:${config.port} — ${error.message}`)
    app.close()
    return null
  })

  if (!server.listening) return { exitCode: 2, server, app }

  const ready = app.readiness()
  const exposed = publicConfig(config)
  stdout('aetheris-core listening')
  stdout(`  url           http://${config.host}:${config.port}`)
  stdout(`  policy        ${exposed.policy}`)
  stdout(`  readiness     ${ready.status}`)
  stdout(`  local models  ${app.registry.list({ availableOnly: true }).length} ready`)
  stdout(`  data dir      ${config.dataDir}`)
  if (dotEnvApplied) stdout(`  .env          ${dotEnvApplied} value(s) applied`)
  if (exposed.policy === RUNTIME_POLICIES.STRICT_OFFLINE) {
    stdout('  network       external egress is blocked at the fetch layer')
  } else {
    stdout(`  network       external egress allowed for: ${exposed.onlineAllowlist?.join(', ') || '(none allowlisted)'}`)
  }
  if (probe) {
    for (const [name, result] of Object.entries(probe.providers)) {
      stdout(`  provider      ${name}: ${result.availability}`)
    }
  }
  // Report what is NOT ready rather than implying everything works.
  for (const missing of ready.notReady ?? []) {
    stdout(`  limitation    ${missing.id}: ${missing.availability}`)
  }
  if (!ready.capabilities.chat) stdout('  limitation    no local chat model is installed; /api/chat will return no_model_available')
  if (!ready.capabilities.videoGeneration) stdout('  limitation    no video generation model is available; /api/video will refuse rather than substitute a still image')

  // --- graceful shutdown ---------------------------------------------------
  let closing = null
  const shutdown = (signal) => {
    if (closing) return closing
    stdout(`aetheris-core: ${signal} received, shutting down`)
    closing = new Promise((done) => {
      const timer = setTimeout(() => {
        stderr('aetheris-core: shutdown timed out, forcing exit')
        done(1)
      }, 10_000)
      server.close(() => {
        clearTimeout(timer)
        try {
          app.close()
        } catch (error) {
          stderr(`aetheris-core: error while closing — ${error.message}`)
        }
        done(0)
      })
    })
    return closing
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal).then((code) => process.exit(code))
    })
  }

  return { exitCode: 0, server, app, shutdown, config }
}

// Only boot when executed directly, so tests can import main() without a server.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const result = await main()
  if (result.exitCode !== 0) process.exit(result.exitCode)
}
