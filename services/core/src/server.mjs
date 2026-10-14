#!/usr/bin/env node
// Active product entry: online inference only. Legacy research is not imported.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OnlineApp } from './online/app.mjs'
export async function main({ env = process.env, stdout = console.log } = {}) {
  const config = {
    dataDir: env.AETHERIS_ONLINE_DATA_DIR || resolve('.aetheris-data/online'),
    trustedOrigins: (env.AETHERIS_LITELLM_TRUSTED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    secureCookie: env.AETHERIS_COOKIE_SECURE !== 'false',
  }
  const app = new OnlineApp(config), server = app.server()
  const port = Number(env.AETHERIS_CORE_PORT || 8790), host = env.AETHERIS_CORE_HOST || '0.0.0.0'
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done) })
  stdout(`Aetheris online-only API listening on ${host}:${server.address().port}`)
  stdout(`Owner sign-in token file: ${app.tokenPath} (read on this host; never share it in chat)`)
  stdout('Configure LiteLLM in Provider Settings. No local inference or automatic model downloads.')
  const shutdown = async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); app.close() }
  return { app, server, config, shutdown, exitCode: 0 }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await main()
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { if (stopping) return; stopping = true; await running.shutdown(); process.exit(0) })
}
