// Phase 1 observational probes, not production code or acceptance tests.
// Run from the checkout: node docs/experiments/phase1-probes.mjs
// Only synthetic loopback HTTP traffic; temporary isolated data; no real models.
// Findings may change after remediation. Inspect JSON rather than interpreting
// successful execution as a security pass. Never point these fixtures at production.
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AetherisOmniApp, createHttpServer } from '../../services/core/src/app.mjs'
import { loadConfig } from '../../services/core/src/config.mjs'
import { OpenAiCompatLocalProvider } from '../../services/core/src/providers/local.mjs'
import { createEgressGuard } from '../../services/core/src/policy/egress.mjs'
import { classifyText } from '../../services/core/src/policy/classify.mjs'

const observations = { schema: 'aetheris.phase1-probes/1', syntheticFixturesOnly: true }
const requests = []
const reply = { choices: [{ message: { role: 'assistant', content: 'Synthetic audit fixture, not model inference.' } }] }
const fixture = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`)
  req.resume()
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'audit-fixture' }] }))
  res.flushHeaders()
  setTimeout(() => res.end(JSON.stringify(reply)), 250)
})
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const close = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve()
  server.closeAllConnections()
  server.close(resolve)
})
let app, api, dir
try {
  const base = await listen(fixture)
  const provider = new OpenAiCompatLocalProvider({
    baseUrl: `${base}/v1`, guard: createEgressGuard({ policy: 'strict_offline' }), timeoutMs: 100,
  })
  const started = performance.now()
  try {
    await provider.chat({ model: 'audit-fixture', messages: [{ role: 'user', content: 'synthetic fixture' }] })
    observations.bodyDeadline = { configuredTimeoutMs: 100, delayedBodyMs: 250, elapsedMs: Math.round(performance.now() - started), outcome: 'completed_without_timeout' }
  } catch (error) {
    observations.bodyDeadline = { configuredTimeoutMs: 100, delayedBodyMs: 250, elapsedMs: Math.round(performance.now() - started), outcome: error.code ?? error.name }
  }
  requests.length = 0
  dir = await mkdtemp(join(tmpdir(), 'aetheris-phase1-'))
  const config = loadConfig({
    AETHERIS_DATA_DIR: dir, AETHERIS_RUNTIME_POLICY: 'strict_offline',
    OLLAMA_ENABLED: 'false', LLAMACPP_ENABLED: 'true', LLAMACPP_BASE_URL: `${base}/v1`,
  })
  app = new AetherisOmniApp({ config })
  await app.probeAll()
  const models = app.registry.list().filter((m) => m.id.includes('audit-fixture'))
  observations.metadataReadiness = {
    requestsBeforeInference: [...requests],
    models: models.map((m) => ({ id: m.id, availability: m.measured?.availability, toolCalling: m.toolCalling, minRamGb: m.minRamGb })),
  }
  api = createHttpServer(app)
  const apiUrl = await listen(api)
  observations.unauthenticatedRead = {
    endpoint: '/api/sessions', authorizationHeaderSent: false,
    status: (await fetch(`${apiUrl}/api/sessions`)).status,
  }
  // Deliberately invalid, fabricated credential-shaped text. No real credential.
  const prompt = 'AUDIT_SECRET_TOKEN=not-a-real-credential'
  try {
    const result = await app.chat({ prompt, dataClass: 'public', model: models[0]?.id })
    observations.declaredClassification = {
      detectorClass: classifyText(prompt).dataClass, requestClass: 'public',
      responseClass: result.classification, sentExternally: result.sentExternally,
    }
  } catch (error) {
    observations.declaredClassification = { outcome: error.code ?? error.name, message: error.message }
  }
  const task = app.godCore.submit({ prompt: 'synthetic unexecuted audit task' })
  const before = app.godCore.list().length
  await close(api)
  await app.close()
  app = new AetherisOmniApp({ config })
  observations.taskRecreation = {
    tasksBefore: before, tasksAfterAppRecreationSameDataDirectory: app.godCore.list().length,
    originalTaskRecovered: app.godCore.list().some((t) => t.id === task.id),
    scope: 'application-object recreation, not process-kill or crash recovery testing',
  }
} finally {
  await close(api)
  await app?.close()
  await close(fixture)
  if (dir) await rm(dir, { recursive: true, force: true })
}
console.log(JSON.stringify(observations, null, 2))
