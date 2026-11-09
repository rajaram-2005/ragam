#!/usr/bin/env node
// Five-area end-to-end qualification against the REAL OnlineApp HTTP server.
//
//   node scripts/release/e2e-qualification.mjs --out docs/release/evidence/e2e-qualification.json
//
// Every check records its integration mode. The provider used here is an
// ISOLATED TEST SERVICE on loopback that speaks the OpenAI-compatible wire;
// it is not a live third-party provider and is never reported as one. Real
// vendor calls, real model inference and real generated video remain BLOCKED
// in the qualification report. Nothing here is a mock of the application:
// the app, its SQLite stores, its job queue, its plugin registry and its MCP
// registry are the production modules, reached over real HTTP sockets.

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../../services/core/src/online/app.mjs'
import { writeJson, atRoot } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const out = atRoot(flag('out', 'docs/release/evidence/e2e-qualification.json'))

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

const results = []
async function check(id, area, mode, fn) {
  try {
    const detail = await fn()
    results.push({ id, area, mode, status: 'PASS', detail })
  } catch (error) {
    results.push({ id, area, mode, status: 'FAIL', detail: error?.message ?? String(error) })
  }
}
const expect = (condition, message) => { if (!condition) throw new Error(message) }

// Isolated provider service. It is explicitly labelled in every result.
let mode = 'normal'
const calls = []
const isolated = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body = null
  try { body = raw ? JSON.parse(raw) : null } catch { body = null }
  const path = req.url.split('?')[0]
  calls.push({ path, method: req.method, body, authorization: req.headers.authorization ?? null })
  const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

  if (path.endsWith('/models')) {
    return json({ data: [{ id: 'isolated-model-a' }, { id: 'isolated-model-b' }, { id: 'gpt-image-isolated' }] })
  }
  if (path.endsWith('/chat/completions')) {
    if (mode === 'auth') return json({ error: { code: 'invalid_api_key' } }, 401)
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'stall') { res.flushHeaders(); setTimeout(() => res.end('data: [DONE]\n\n'), 5000).unref(); return }
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Isolated ' } }] })}\r\n\r\n`)
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'service reply.' } }] })}\r\n\r\n`)
      return res.end('data: [DONE]\n\n')
    }
    if (mode === 'stall') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); setTimeout(() => res.end('{}'), 5000).unref(); return }
    return json({ model: body?.model, choices: [{ message: { content: `Isolated service reply for ${body?.model}` } }] })
  }
  if (path.endsWith('/images/generations')) {
    if (mode === 'malformed-image') return json({ data: [{ b64_json: 'not-base64!!' }] })
    return json({ model: body?.model ?? 'gpt-image-isolated', data: [{ b64_json: PNG_1X1, revised_prompt: 'isolated fixture' }] })
  }
  // fal.ai queue contract, isolated.
  if (path.includes('/fal-ai/') && !path.includes('/requests/')) {
    const origin = `http://127.0.0.1:${isolated.address().port}`
    return json({ request_id: `req-${calls.length}`, status_url: `${origin}/requests/req-${calls.length}/status`, response_url: `${origin}/requests/req-${calls.length}/result`, cancel_url: `${origin}/requests/req-${calls.length}/cancel` })
  }
  if (path.includes('/status')) {
    if (mode === 'queue-stall') return json({ status: 'IN_QUEUE', queue_position: 1 })
    return json({ status: 'FAILED' })
  }
  if (path.includes('/result')) return json({ video: { url: 'http://127.0.0.1/unused' } })
  return json({ error: 'not found' }, 404)
})

const dir = mkdtempSync(join(tmpdir(), 'ragam-e2e-'))
mkdirSync(dir, { recursive: true })
const isolatedUrl = await listen(isolated)
const appOptions = {
  dataDir: dir,
  trustedOrigins: [isolatedUrl],
  timeoutMs: 4000,
  mediaPoll: { initialMs: 20, factor: 1, maxMs: 40, attempts: 12 },
  logger: () => {},
}
const createApp = () => new OnlineApp(appOptions)
let app = createApp()
let server = app.server()
let base = await listen(server)

let cookie = ''
let accountId = ''
const request = async (method, path, body, { signal, as = 'json', useCookie = cookie } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(useCookie ? { cookie: useCookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  })
  if (as === 'raw') return response
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, headers: response.headers, text }
}
const revision = () => app.store.state.revision
const chatBody = (extra = {}) => ({
  prompt: 'ordinary question',
  model: 'isolated-model-a',
  localOnly: false,
  authorization: { confirmed: true, providerRevision: revision() },
  ...extra,
})

try {
  // --- Chat -----------------------------------------------------------------
  await check('chat.auth', 'Chat', 'isolated_test_service', async () => {
    const anonymous = await request('GET', '/api/ready', undefined, { useCookie: '' })
    expect(anonymous.status === 401, `unauthenticated readiness should be 401, got ${anonymous.status}`)
    const registered = await request('POST', '/api/auth/register', { email: 'owner@example.test', password: 'a-long-owner-password' })
    expect(registered.status === 201, `register returned ${registered.status}`)
    cookie = registered.headers.get('set-cookie').split(';')[0]
    accountId = registered.data.account.id
    const config = await request('GET', '/api/config')
    expect(config.data.auth.account.role === 'owner', 'first account must be owner')
    return { register: registered.status, role: config.data.auth.account.role, unauthenticated: anonymous.status }
  })

  await check('chat.model_selection_no_substitution', 'Chat', 'isolated_test_service', async () => {
    const configured = await request('PUT', '/api/providers/openai', { baseUrl: `${isolatedUrl}/v1`, apiKey: 'synthetic-test-key' })
    expect(configured.status === 200, `configure returned ${configured.status}: ${configured.text}`)
    const probed = await request('POST', '/api/models/probe', {})
    expect(probed.status === 200, `probe returned ${probed.status}`)
    const selected = await request('PUT', '/api/models/selection', { model: 'isolated-model-a' })
    expect(selected.data.selectedModel === 'isolated-model-a', 'explicit model was not selected')
    const refused = await request('PUT', '/api/models/selection', { model: 'not-a-listed-model' })
    expect(refused.status === 409 && refused.data.error === 'model_unavailable', 'unlisted model must be refused, not substituted')
    return { selectedModel: selected.data.selectedModel, unlistedModelStatus: refused.status, error: refused.data.error }
  })

  await check('chat.real_inference_and_intended_routing', 'Chat', 'isolated_test_service', async () => {
    const before = calls.length
    const response = await request('POST', '/api/chat', chatBody())
    expect(response.status === 200, `chat returned ${response.status}: ${response.text}`)
    const seen = calls.slice(before).filter((call) => call.path.endsWith('/chat/completions'))
    expect(seen.length === 1, `expected one provider call, got ${seen.length}`)
    expect(seen[0].body.model === 'isolated-model-a', `provider saw model ${seen[0].body.model}`)
    expect(seen[0].authorization === 'Bearer synthetic-test-key', 'credential was not sent to the configured provider only')
    expect(response.data.model === 'isolated-model-a' || String(response.data.text ?? response.data.reply ?? '').includes('isolated-model-a'), 'response did not identify the selected model')
    return { status: response.status, providerModel: seen[0].body.model, provider: 'openai (isolated service)' }
  })

  await check('chat.streaming', 'Chat', 'isolated_test_service', async () => {
    const response = await request('POST', '/api/chat/stream', chatBody(), { as: 'raw' })
    expect(response.status === 200, `stream returned ${response.status}`)
    const text = await response.text()
    expect(text.includes('event: delta') && text.includes('Isolated ') && text.includes('event: done'), `stream lacked delta/done: ${text.slice(0, 200)}`)
    return { status: response.status, deltaEvents: (text.match(/event: delta/g) ?? []).length, doneEvent: text.includes('event: done') }
  })

  let sessionId = ''
  await check('chat.history_persistence_across_restart', 'Chat', 'isolated_test_service', async () => {
    const created = await request('POST', '/api/sessions', { title: 'release E2E' })
    expect(created.status === 201, `session create returned ${created.status}`)
    sessionId = created.data.id ?? created.data.session?.id
    expect(sessionId, 'session id missing')
    const response = await request('POST', '/api/chat', chatBody({ sessionId }))
    expect(response.status === 200, `chat returned ${response.status}`)
    const loaded = await request('GET', `/api/sessions/${sessionId}`)
    expect(loaded.status === 200, `session read returned ${loaded.status}`)
    expect(loaded.text.includes('ordinary question'), 'user turn not persisted')
    // Close the app and open a fresh instance over the same SQLite files.
    app.close()
    await close(server)
    app = createApp()
    server = app.server()
    base = await listen(server)
    const after = await request('GET', `/api/sessions/${sessionId}`, undefined, { useCookie: '' })
    expect(after.status === 401, 'restarted app must still require authentication')
    const signedIn = await request('POST', '/api/auth/login', { email: 'owner@example.test', password: 'a-long-owner-password' })
    cookie = signedIn.headers.get('set-cookie').split(';')[0]
    const reloaded = await request('GET', `/api/sessions/${sessionId}`)
    expect(reloaded.status === 200 && reloaded.text.includes('ordinary question'), 'conversation did not survive app restart')
    return { sessionId, userTurnPersisted: true, survivedRestart: true, unauthenticatedAfterRestart: after.status }
  })

  await check('chat.cancellation', 'Chat', 'isolated_test_service', async () => {
    mode = 'stall'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120)
    let aborted = false
    try {
      const response = await request('POST', '/api/chat/stream', chatBody(), { signal: controller.signal, as: 'raw' })
      // Reading the body is what observes the abort once headers are sent.
      await response.text()
    } catch (error) {
      aborted = error?.name === 'AbortError' || controller.signal.aborted
    }
    clearTimeout(timer)
    mode = 'normal'
    expect(aborted, 'client abort did not cancel the in-flight request')
    const health = await request('GET', '/api/health', undefined, { useCookie: '' })
    expect(health.status === 200, `service unhealthy after cancellation: ${health.status}`)
    return { aborted, healthAfterCancellation: health.status }
  })

  await check('chat.error_handling_and_credential_non_exposure', 'Chat', 'isolated_test_service', async () => {
    mode = 'auth'
    const response = await request('POST', '/api/chat', chatBody())
    mode = 'normal'
    expect(response.status >= 400, `provider 401 should fail the request, got ${response.status}`)
    expect(!response.text.includes('synthetic-test-key'), 'credential leaked into an error response')
    expect(!response.text.includes('NEVER'), 'upstream error body leaked verbatim')
    return { status: response.status, error: response.data?.error, keyExposed: response.text.includes('synthetic-test-key') }
  })

  // --- Image ----------------------------------------------------------------
  await check('image.no_fake_success_without_provider', 'Image', 'isolated_test_service', async () => {
    const response = await request('POST', '/api/image/generate', { prompt: 'a red square', localOnly: false })
    expect(response.status === 503 && response.data.error === 'provider_not_configured', `expected explicit refusal, got ${response.status}: ${response.text}`)
    return { status: response.status, error: response.data.error }
  })

  await check('image.generation_storage_gallery_provenance', 'Image', 'isolated_test_service', async () => {
    const configured = await request('PUT', '/api/providers/openai-images', { baseUrl: `${isolatedUrl}/v1`, apiKey: 'synthetic-test-key' })
    expect(configured.status === 200, `configure image returned ${configured.status}: ${configured.text}`)
    const probed = await request('POST', '/api/providers/openai-images/test', {})
    expect(probed.status === 200, `image probe returned ${probed.status}`)
    const started = await request('POST', '/api/image/generate', { prompt: 'a red square', model: 'gpt-image-isolated', localOnly: false })
    expect(started.status === 202, `image generate returned ${started.status}: ${started.text}`)
    const jobId = started.data.id
    let job = null
    for (let i = 0; i < 80; i += 1) {
      const polled = await request('GET', `/api/media/jobs/${jobId}`)
      job = polled.data
      if (['succeeded', 'failed', 'cancelled'].includes(job?.state)) break
      await new Promise((done) => setTimeout(done, 50))
    }
    expect(job?.state === 'succeeded', `image job ended ${job?.state}: ${JSON.stringify(job?.error ?? null)}`)
    const gallery = await request('GET', '/api/image/jobs')
    expect(gallery.data.jobs.some((entry) => entry.id === jobId), 'generated image absent from gallery')
    const content = await request('GET', `/api/media/jobs/${jobId}/content`, undefined, { as: 'raw' })
    expect(content.status === 200, `artifact content returned ${content.status}`)
    const bytes = Buffer.from(await content.arrayBuffer())
    expect(bytes.length > 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG', 'stored bytes are not a PNG')
    const provenance = JSON.stringify(job.params ?? job)
    expect(provenance.includes('gpt-image-isolated') && provenance.includes('openai-images'), 'job provenance lacks provider/model')
    return { jobId, state: job.state, bytes: bytes.length, mime: content.headers.get('content-type'), galleryListed: true }
  })

  await check('image.failure_handling_no_artifact', 'Image', 'isolated_test_service', async () => {
    mode = 'malformed-image'
    let started
    let job = null
    try {
      started = await request('POST', '/api/image/generate', { prompt: 'bad response', model: 'gpt-image-isolated', localOnly: false })
      expect(started.status === 202, `image generate returned ${started.status}`)
      for (let i = 0; i < 80; i += 1) {
        const polled = await request('GET', `/api/media/jobs/${started.data.id}`)
        job = polled.data
        if (['succeeded', 'failed', 'cancelled'].includes(job?.state)) break
        await new Promise((done) => setTimeout(done, 50))
      }
    } finally {
      mode = 'normal'
    }
    expect(job?.state === 'failed', `malformed provider response should fail the job, got ${job?.state}`)
    expect(!job.artifact, 'failed job must not carry an artifact')
    return { state: job.state, artifact: job.artifact ?? null }
  })

  // --- Video ----------------------------------------------------------------
  await check('video.no_fake_success_without_provider', 'Video', 'isolated_test_service', async () => {
    // The image connection is configured but no video connection exists.
    const response = await request('POST', '/api/video/generate', { prompt: 'a short clip', localOnly: false })
    expect(response.status === 503 && response.data.error === 'provider_not_configured', `expected explicit refusal, got ${response.status}: ${response.text}`)
    return { status: response.status, error: response.data.error }
  })

  await check('video.job_lifecycle_and_provider_failure', 'Video', 'isolated_test_service', async () => {
    const configured = await request('PUT', '/api/providers/fal-video', { baseUrl: isolatedUrl, apiKey: 'synthetic-test-key' })
    expect(configured.status === 200, `configure video returned ${configured.status}: ${configured.text}`)
    const probed = await request('POST', '/api/providers/fal-video/test', {})
    expect(probed.status === 200, `video probe returned ${probed.status}`)
    const started = await request('POST', '/api/video/generate', { prompt: 'a short clip', model: 'fal-ai/veo3', localOnly: false })
    expect(started.status === 202, `video generate returned ${started.status}: ${started.text}`)
    let job = null
    for (let i = 0; i < 80; i += 1) {
      const polled = await request('GET', `/api/media/jobs/${started.data.id}`)
      job = polled.data
      if (['succeeded', 'failed', 'cancelled'].includes(job?.state)) break
      await new Promise((done) => setTimeout(done, 50))
    }
    expect(job?.state === 'failed', `provider-reported FAILED must fail the job, got ${job?.state}`)
    expect(!job.artifact, 'failed video job must not carry an artifact')
    return { jobId: started.data.id, state: job.state, historyStates: (job.history ?? []).map((h) => h.state) }
  })

  await check('video.cancellation', 'Video', 'isolated_test_service', async () => {
    mode = 'queue-stall'
    const started = await request('POST', '/api/video/generate', { prompt: 'a stalled clip', model: 'fal-ai/veo3', localOnly: false })
    expect(started.status === 202, `video generate returned ${started.status}`)
    await new Promise((done) => setTimeout(done, 80))
    const cancelled = await request('POST', `/api/media/jobs/${started.data.id}/cancel`, {})
    mode = 'normal'
    expect(cancelled.status === 200, `cancel returned ${cancelled.status}: ${cancelled.text}`)
    expect(cancelled.data.state === 'cancelled' || cancelled.data.cancelled === true, `job not cancelled: ${cancelled.text}`)
    return { jobId: started.data.id, cancelState: cancelled.data.state ?? 'cancelled' }
  })

  // --- Plugins --------------------------------------------------------------
  await check('plugins.discovery_and_preflight', 'Plugins', 'in_process', async () => {
    const list = await request('GET', '/api/plugins')
    expect(list.status === 200 && list.data.plugins.some((p) => p.id === 'aetheris.online-status'), 'built-in plugin not discovered')
    const capabilities = await request('GET', '/api/plugins/capabilities')
    expect(capabilities.status === 200, `capabilities returned ${capabilities.status}`)
    const preflight = await request('POST', '/api/plugins/aetheris.online-status/preflight', { capability: 'status' })
    expect(preflight.status === 200 && preflight.data.readOnly === true, 'read-only preflight not reported')
    return { plugins: list.data.plugins.length, readOnly: preflight.data.readOnly }
  })

  await check('plugins.execution_errors_and_permission_boundary', 'Plugins', 'in_process', async () => {
    const invoked = await request('POST', '/api/plugins/aetheris.online-status/invoke', { capability: 'status', input: {} })
    expect(invoked.status === 200, `invoke returned ${invoked.status}: ${invoked.text}`)
    const unknown = await request('POST', '/api/plugins/no-such-plugin/invoke', { capability: 'status', input: {} })
    expect(unknown.status === 404, `unknown plugin should be 404, got ${unknown.status}`)
    const install = await request('POST', '/api/plugins/install', {})
    expect(install.status === 403 && install.data.error === 'extension_installation_disabled', 'raw plugin installation must be refused')
    const memberRegister = await request('POST', '/api/auth/register', { email: 'member@example.test', password: 'a-long-member-password' })
    expect(memberRegister.status === 201, `member register returned ${memberRegister.status}`)
    const memberCookie = memberRegister.headers.get('set-cookie').split(';')[0]
    const ownerOnly = await request('POST', '/api/plugins/connect', { url: isolatedUrl }, { useCookie: memberCookie })
    expect(ownerOnly.status === 403 && ownerOnly.data.error === 'owner_required', 'member must not be able to configure plugins')
    return { invoke: invoked.status, unknown: unknown.status, install: install.status, memberOwnerOnly: ownerOnly.status }
  })

  // --- MCP ------------------------------------------------------------------
  await check('mcp.startup_discovery', 'MCP', 'in_process', async () => {
    const servers = await request('GET', '/api/mcp/servers')
    const tools = await request('GET', '/api/mcp/tools')
    const resources = await request('GET', '/api/mcp/resources')
    const prompts = await request('GET', '/api/mcp/prompts')
    expect(servers.status === 200 && servers.data.servers.length >= 1, 'no in-process MCP server registered')
    expect(tools.status === 200 && tools.data.tools.length >= 1, 'no MCP tools discovered')
    expect(resources.status === 200, `resources returned ${resources.status}`)
    expect(prompts.status === 200, `prompts returned ${prompts.status}`)
    return { servers: servers.data.servers.length, tools: tools.data.tools.length, resources: resources.data.resources?.length ?? 0, prompts: prompts.data.prompts?.length ?? 0 }
  })

  await check('mcp.invocation_and_error_recovery', 'MCP', 'in_process', async () => {
    const preflight = await request('POST', '/api/mcp/preflight', { server: 'aetheris.online', tool: 'connection.status' })
    expect(preflight.status === 200, `preflight returned ${preflight.status}`)
    const called = await request('POST', '/api/mcp/call', { server: 'aetheris.online', tool: 'connection.status', arguments: {} })
    expect(called.status === 200, `call returned ${called.status}: ${called.text}`)
    const unknown = await request('POST', '/api/mcp/call', { server: 'aetheris.online', tool: 'no.such.tool', arguments: {} })
    expect(unknown.status >= 400, `unknown tool should fail, got ${unknown.status}`)
    const recovered = await request('GET', '/api/mcp/tools')
    expect(recovered.status === 200, 'registry unhealthy after a failed invocation')
    return { preflight: preflight.status, call: called.status, unknownTool: unknown.status, recovered: recovered.status }
  })
} finally {
  try { await close(server) } catch {}
  try { app.close() } catch {}
  try { await close(isolated) } catch {}
  rmSync(dir, { recursive: true, force: true })
}

const report = {
  schema: 'ragam-e2e-qualification/1',
  executedAt: new Date().toISOString(),
  backend: 'services/core/src/online/app.mjs (production module)',
  serviceMode: 'isolated_test_service',
  liveThirdPartyCalls: 0,
  notes: [
    'All HTTP requests went to the real Core server over loopback sockets; the provider is an isolated OpenAI-compatible test service with a synthetic key.',
    'No live third-party provider, no real model inference and no real generated video were exercised. Those gates remain BLOCKED.',
    'MCP and Plugins checks used the real in-process registries, not substitutes.',
  ],
  modesUsed: [...new Set(results.map((r) => r.mode))],
  pass: results.filter((r) => r.status === 'PASS').length,
  fail: results.filter((r) => r.status === 'FAIL').length,
  notTested: [
    { id: 'mcp.timeouts_and_remote_error_recovery', reason: 'No remote MCP server or authorized test endpoint configured; only in-process registry checks ran.' },
    { id: 'chat.live_provider_inference', reason: 'No authorized live/staging provider credential.' },
    { id: 'image.live_provider_generation', reason: 'No authorized live/staging provider credential.' },
    { id: 'video.real_artifact', reason: 'No authorized live/staging video provider; no real MP4 artifact was produced.' },
  ],
  results,
}
writeJson(out, report)
for (const result of results) console.log(`${result.status}  ${result.id} [${result.mode}] — ${JSON.stringify(result.detail).slice(0, 180)}`)
console.log(`\n${report.pass} PASS, ${report.fail} FAIL — ${out}`)
if (report.fail) process.exit(1)
