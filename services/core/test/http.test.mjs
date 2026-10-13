// End-to-end HTTP tests for the unified service.
//
// These bind a real socket, speak real HTTP, and drive the five product areas
// through the same routes the web app uses. The point is to prove the areas work
// in ONE app and that each one reports honestly when it cannot:
//
//   Chat    /api/chat, /api/chat/stream, /api/knowledge/*, /api/tasks
//   Image   /api/image/generate, /api/image/jobs
//   Video   /api/video/generate, /api/video/jobs
//   Plugins /api/plugins/*
//   MCP     /api/mcp/*
//
// The model behind the Chat tests is the loopback fixture in
// test/helpers/local-model-server.mjs. It proves the transport and routing; it is
// not a claim that a real LLM is installed on this host.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AetherisOmniApp, createHttpServer } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { startLocalModelServer } from './helpers/local-model-server.mjs'
import { RUNTIME_POLICIES } from '../src/policy/egress.mjs'
import { RISK, SERVER_KINDS } from '../src/mcp/layer.mjs'
import { PROTOCOLS, SCOPES } from '../src/plugins/manifest.mjs'
import { parseAllowlist } from '../src/mcp/layer.mjs'

/** Boot the app plus a real HTTP listener on an ephemeral loopback port. */
async function startCore({ env = {}, withModel = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aetheris-http-'))
  const model = withModel ? await startLocalModelServer() : null

  const config = loadConfig({
    AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
    AETHERIS_DATA_DIR: dataDir,
    OLLAMA_ENABLED: withModel ? 'true' : 'false',
    ...(model ? { OLLAMA_BASE_URL: model.baseUrl } : {}),
    LLAMACPP_ENABLED: 'false',
    ...env,
  })

  const app = new AetherisOmniApp({ config })
  if (withModel) await app.probeAll()

  const server = createHttpServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, headers: response.headers, json, text }
  }

  return {
    app,
    server,
    model,
    baseUrl,
    call,
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, body, headers) => call('POST', path, body ?? {}, headers),
    patch: (path, body, headers) => call('PATCH', path, body ?? {}, headers),
    del: (path, body, headers) => call('DELETE', path, body ?? {}, headers),
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      app.close()
      if (model) await model.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// System routes
// ---------------------------------------------------------------------------

test('system routes report real state', async () => {
  const core = await startCore()
  try {
    const health = await core.get('/api/health')
    assert.equal(health.status, 200)
    assert.equal(health.json.status, 'ok')
    assert.equal(health.json.policy, RUNTIME_POLICIES.STRICT_OFFLINE)

    const ready = await core.get('/api/ready')
    assert.equal(ready.status, 200)
    assert.equal(ready.json.status, 'ready')
    assert.equal(ready.json.offlineEnforced, true)
    assert.equal(ready.json.capabilities.chat, true)
    assert.equal(ready.json.models.ready, 1)
    // Capabilities that are not backed by anything must be reported as false.
    assert.equal(ready.json.capabilities.imageGeneration, false)
    assert.equal(ready.json.capabilities.videoGeneration, false)

    const hardware = await core.get('/api/hardware')
    assert.equal(hardware.status, 200)
    assert.ok(hardware.json.cpuCount >= 1)
    assert.equal(hardware.json.gpuDetected, false, 'no GPU is detected on this host and none is invented')

    const models = await core.get('/api/models?ready=true')
    assert.equal(models.json.models.length, 1)
    assert.equal(models.json.models[0].id, 'ollama:tiny-local:latest')

    // The model family travels with the model list, because the model control in Chat
    // is where a user sees it. It arrives validated, so the API cannot serve a
    // capability claim that nothing backs.
    assert.equal(models.json.family.valid, true)
    assert.deepEqual(models.json.family.violations, [])
    assert.deepEqual(models.json.family.tiers.map((t) => t.id), ['lite', 'pro', 'high'])
    const lite = models.json.family.tiers.find((t) => t.id === 'lite')
    assert.deepEqual(lite.availableCapabilities, ['text.completion', 'text.extract'])
    assert.equal(lite.status, 'partial')

    // A discovered third-party model carries no Klyvaron tier, because a label is a
    // lookup against the backing records and this id is not one of them.
    assert.equal(models.json.models[0].tier, null)

    // No response may be cached: these are live status endpoints.
    assert.equal(health.headers.get('cache-control'), 'no-store')
  } finally {
    await core.close()
  }
})

test('unknown routes return 404 rather than a server error', async () => {
  const core = await startCore()
  try {
    const missing = await core.get('/api/does-not-exist')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error, 'not_found')

    // A known path with the wrong method is a client error too.
    const wrongMethod = await core.call('DELETE', '/api/health')
    assert.equal(wrongMethod.status, 404)
  } finally {
    await core.close()
  }
})

test('OPTIONS preflight is answered and cross-origin requests are not enabled by default', async () => {
  const core = await startCore()
  try {
    const options = await core.call('OPTIONS', '/api/chat')
    assert.equal(options.status, 204)
    // allowedOrigin defaults to null → same-origin only, so no CORS grant is sent.
    assert.equal(options.headers.get('access-control-allow-origin'), null)

    const crossOrigin = await core.get('/api/health', { origin: 'https://evil.example' })
    assert.equal(crossOrigin.status, 200, 'the API still answers; it just does not grant browser access')
    assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null)
  } finally {
    await core.close()
  }
})

test('an explicitly configured origin is reflected, and only that one', async () => {
  const core = await startCore({ env: { AETHERIS_ALLOWED_ORIGIN: 'http://127.0.0.1:5173' } })
  try {
    const allowed = await core.get('/api/health', { origin: 'http://127.0.0.1:5173' })
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')
  } finally {
    await core.close()
  }
})

test('malformed and oversized bodies are rejected as client errors', async () => {
  const core = await startCore()
  try {
    const response = await fetch(`${core.baseUrl}/api/knowledge/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title": "broken",',
    })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.equal(body.error, 'invalid_json')

    // Over the 4 MB limit the connection is refused with 413.
    const big = await fetch(`${core.baseUrl}/api/knowledge/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'huge', text: 'x'.repeat(5 * 1024 * 1024) }),
    }).catch((error) => ({ status: null, error }))
    assert.ok(big.status === 413 || big.error, `expected 413 or a reset connection, got ${big.status}`)
  } finally {
    await core.close()
  }
})

// ---------------------------------------------------------------------------
// Area 1: Chat
// ---------------------------------------------------------------------------

test('Chat: a real request reaches the local model and comes back grounded', async () => {
  const core = await startCore()
  try {
    const reply = await core.post('/api/chat', { prompt: 'Explain the contactor rule' })
    assert.equal(reply.status, 200)
    assert.match(reply.json.text, /local reply to: Explain the contactor rule/)
    assert.equal(reply.json.modelId, 'ollama:tiny-local:latest')
    assert.equal(reply.json.sentExternally, false)
    assert.equal(reply.json.stream, false)
    // Ordinary prose carries no secret markers, so it classifies as public.
    assert.equal(reply.json.classification, 'public')

    // The model server saw exactly the request the router authorised.
    const chatCalls = core.model.requests.filter((r) => r.url === '/api/chat')
    assert.equal(chatCalls.length, 1)
    const sent = JSON.parse(chatCalls[0].body)
    assert.equal(sent.stream, false)
    assert.equal(sent.model, 'tiny-local:latest', 'the provider-local model id is used, not the registry id')

    // A prompt that looks like it carries a credential is classified higher, which
    // is what stops it leaving the machine in hybrid mode.
    const risky = await core.post('/api/chat', { prompt: 'debug this: AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY' })
    assert.equal(risky.status, 200)
    assert.equal(risky.json.classification, 'restricted', 'a credential in the prompt must classify as restricted')
    assert.equal(risky.json.sentExternally, false)
  } finally {
    await core.close()
  }
})

test('Chat: streaming returns server-sent events and finishes', async () => {
  const core = await startCore()
  try {
    const response = await fetch(`${core.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'stream me' }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)

    const raw = await response.text()
    const events = raw
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const name = /^event: (.+)$/m.exec(block)?.[1]
        const data = /^data: (.+)$/m.exec(block)?.[1]
        return { name, data: data ? JSON.parse(data) : null }
      })

    const deltas = events.filter((e) => e.name === 'delta')
    assert.ok(deltas.length > 1, `expected several deltas, got ${deltas.length}`)
    const done = events.find((e) => e.name === 'done')
    assert.ok(done, 'the stream must terminate with a done event')
    assert.equal(done.data.modelId, 'ollama:tiny-local:latest')
    assert.equal(done.data.chunks, deltas.length)
    assert.equal(
      deltas.map((d) => d.data.text).join('').trim(),
      'local reply to: stream me',
    )
    assert.equal(events.some((e) => e.name === 'error'), false)
  } finally {
    await core.close()
  }
})

test('Chat: with no model installed the API refuses instead of inventing an answer', async () => {
  const core = await startCore({ withModel: false })
  try {
    const reply = await core.post('/api/chat', { prompt: 'hello' })
    assert.equal(reply.status, 503)
    assert.equal(reply.json.error, 'no_model_available')
    assert.ok(reply.json.route.explanation.length > 0)

    const ready = await core.get('/api/ready')
    assert.equal(ready.json.status, 'degraded')
    assert.equal(ready.json.capabilities.chat, false)

    // Streaming reports the same honest error as an event, then closes.
    const stream = await fetch(`${core.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })
    const text = await stream.text()
    assert.match(text, /event: error/)
    assert.match(text, /no_model_available/)
  } finally {
    await core.close()
  }
})

test('Chat: company knowledge is retrieved, cited and injected into the prompt', async () => {
  const core = await startCore()
  try {
    const ingested = await core.post('/api/knowledge/ingest', {
      title: 'BMS Policy',
      text: 'The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius. Isolation resistance must remain above 500 ohms per volt at all times.',
      classification: 'internal',
    })
    assert.equal(ingested.status, 201)
    assert.equal(ingested.json.duplicate, false)
    assert.equal(ingested.json.chunks, 1)

    const search = await core.post('/api/knowledge/search', { query: 'contactor opening threshold', topK: 3 })
    assert.equal(search.status, 200)
    assert.equal(search.json.results.length, 1)
    assert.deepEqual(search.json.results[0].matchedTerms, ['contactor', 'open'])
    assert.equal(search.json.citations[0].title, 'BMS Policy')
    assert.ok(search.json.citations[0].sha256)

    const grounded = await core.post('/api/chat', { prompt: 'What is the contactor rule?', useKnowledge: true })
    assert.equal(grounded.status, 200)
    assert.equal(grounded.json.grounding.hasEvidence, true)
    assert.equal(grounded.json.grounding.citations.length, 1)

    // The retrieved evidence really was sent to the model as context.
    const sent = JSON.parse(core.model.requests.filter((r) => r.url === '/api/chat').at(-1).body)
    assert.equal(sent.messages[0].role, 'system')
    assert.match(sent.messages[0].content, /contactor/)

    const stats = await core.get('/api/knowledge/stats')
    assert.equal(stats.status, 200)
    assert.equal(stats.json.store.documents, 1)

    // Re-ingesting identical content is detected as a duplicate, not stored twice.
    const again = await core.post('/api/knowledge/ingest', { title: 'BMS Policy', text: ingested.json.document.contentKey })
    assert.equal(again.status, 201)
    assert.equal(again.json.duplicate, true)
  } finally {
    await core.close()
  }
})

test('Chat: a God Core task runs the full lifecycle over HTTP', async () => {
  const core = await startCore()
  try {
    const created = await core.post('/api/tasks', { prompt: 'What is our policy on the contactor threshold?' })
    assert.equal(created.status, 200)
    const task = created.json
    assert.deepEqual(
      task.steps.map((step) => step.phase),
      ['understand', 'plan', 'retrieve', 'route', 'execute', 'observe', 'verify', 'synthesize'],
    )
    assert.equal(task.terminal, true)
    assert.ok(['succeeded', 'partial'].includes(task.state))
    // Without an executor the task must not claim it completed anything.
    assert.equal(task.state, 'partial')
    assert.ok(task.limitations.some((note) => /no executor was supplied/.test(note)))
    assert.equal('controller' in task, false, 'the AbortController must never be exposed over HTTP')

    const fetched = await core.get(`/api/tasks/${task.id}`)
    assert.equal(fetched.status, 200)
    assert.equal(fetched.json.id, task.id)

    const listed = await core.get('/api/tasks?limit=10')
    assert.equal(listed.json.tasks.length, 1)

    const unknown = await core.get('/api/tasks/not-a-real-task')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error, 'unknown_task')
  } finally {
    await core.close()
  }
})

test('Chat: a task can be parked before it runs, then resumed and completed', async () => {
  const core = await startCore()
  try {
    const created = await core.post('/api/tasks', { prompt: 'a long task', run: false })
    assert.equal(created.status, 201)
    assert.equal(created.json.state, 'pending')

    // Parking a task that has not started is legitimate: it holds it at the top
    // of the lifecycle rather than losing it.
    const paused = await core.post(`/api/tasks/${created.json.id}/pause`, { reason: 'operator' })
    assert.equal(paused.status, 200)
    assert.equal(paused.json.state, 'paused')
    assert.equal(paused.json.task.state, 'paused')

    // Resuming runs the whole lifecycle, because nothing had executed yet.
    const resumed = await core.post(`/api/tasks/${created.json.id}/resume`, {})
    assert.equal(resumed.status, 200)
    assert.equal(resumed.json.task.terminal, true)
    assert.equal(resumed.json.task.steps.length, 8)
    assert.deepEqual(
      resumed.json.task.steps.map((step) => step.phase),
      ['understand', 'plan', 'retrieve', 'route', 'execute', 'observe', 'verify', 'synthesize'],
    )

    // A terminal task cannot be cancelled into a different state.
    const afterTerminal = await core.post(`/api/tasks/${created.json.id}/cancel`, { reason: 'too late' })
    assert.equal(afterTerminal.status, 200)
    assert.equal(afterTerminal.json.cancelled, false, 'a terminal task cannot be cancelled again')
    assert.equal(afterTerminal.json.task.state, resumed.json.task.state, 'cancelling a finished task must not rewrite history')
  } finally {
    await core.close()
  }
})

test('Chat: a parked task can be cancelled outright', async () => {
  const core = await startCore()
  try {
    const created = await core.post('/api/tasks', { prompt: 'never mind', run: false })
    const cancelled = await core.post(`/api/tasks/${created.json.id}/cancel`, { reason: 'changed my mind' })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.json.cancelled, true)
    assert.equal(cancelled.json.task.state, 'cancelled')
    assert.equal(cancelled.json.task.terminal, true)

    // Cancelling twice is a no-op, not an error.
    const again = await core.post(`/api/tasks/${created.json.id}/cancel`, { reason: 'again' })
    assert.equal(again.status, 200)
    assert.equal(again.json.cancelled, false)
    assert.equal(again.json.task.state, 'cancelled')
  } finally {
    await core.close()
  }
})

// ---------------------------------------------------------------------------
// Areas 2 and 3: Image and Video
// ---------------------------------------------------------------------------

test('Image: with no image-capable provider the API refuses rather than faking output', async () => {
  const core = await startCore()
  try {
    const reply = await core.post('/api/image/generate', { prompt: 'a red square' })
    assert.equal(reply.status, 503)
    assert.equal(reply.json.error, 'capability_unavailable')
    assert.match(reply.json.message, /image generation unavailable/)

    const jobs = await core.get('/api/image/jobs')
    assert.equal(jobs.status, 200)
    assert.deepEqual(jobs.json.jobs, [], 'a refused request must not create a job that looks like progress')
  } finally {
    await core.close()
  }
})

test('Video: a refusal states the limitation and never substitutes a still image', async () => {
  const core = await startCore()
  try {
    const reply = await core.post('/api/video/generate', { prompt: 'a cat walking' })
    assert.equal(reply.status, 503)
    assert.equal(reply.json.error, 'capability_unavailable')
    // This is the specific guarantee the directive asks for.
    assert.ok(reply.json.limitation, 'the response must carry an explicit limitation')
    assert.match(reply.json.limitation, /still image|not.*substitut|no video-capable provider/i)

    const jobs = await core.get('/api/video/jobs')
    assert.deepEqual(jobs.json.jobs, [])

    const ready = await core.get('/api/ready')
    assert.equal(ready.json.capabilities.videoGeneration, false)
  } finally {
    await core.close()
  }
})

// ---------------------------------------------------------------------------
// Area 4: Plugins
// ---------------------------------------------------------------------------

function manifest(overrides = {}) {
  return {
    id: 'acme.repo-inspector',
    name: 'Repository Inspector',
    version: '1.0.0',
    protocol: PROTOCOLS.LOCAL_TOOL,
    description: 'Reads repository metadata.',
    scopes: [SCOPES.FS_READ],
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarise a repository path.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', minLength: 1 }, depth: { type: 'integer', minimum: 1, maximum: 10, default: 2 } },
          required: ['path'],
          additionalProperties: false,
        },
        outputSchema: { type: 'object', properties: { files: { type: 'integer' }, summary: { type: 'string' } }, required: ['files', 'summary'] },
        requiredScopes: [SCOPES.FS_READ],
        readOnly: true,
      },
    ],
    ...overrides,
  }
}

test('Plugins: manifest validation reports every problem, over HTTP', async () => {
  const core = await startCore()
  try {
    const good = await core.post('/api/plugins/validate', manifest())
    assert.equal(good.status, 200)
    assert.equal(good.json.valid, true)

    // A manifest that gets the protocol field wrong is a 400 with specifics,
    // not a 500 and not a silent acceptance.
    const bad = await core.post('/api/plugins/validate', { name: 'no id', version: '1.0.0', kind: 'local_tool' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.valid, false)
    assert.ok(bad.json.details.length >= 2, 'all problems should be reported at once')
    assert.ok(bad.json.details.some((d) => /id must match/.test(d)))
    assert.ok(bad.json.details.some((d) => /protocol must be one of/.test(d)))

    // Version downgrade is rejected: a known-good plugin cannot be silently replaced.
    await core.post('/api/plugins/install', manifest())
    const downgrade = await core.post('/api/plugins/install', manifest({ version: '0.9.0' }))
    assert.ok(downgrade.status >= 400, 'installing an older version over a newer one must be refused')
  } finally {
    await core.close()
  }
})

test('Plugins: install, list, preflight and permission enforcement', async () => {
  const core = await startCore()
  try {
    const installed = await core.post('/api/plugins/install', manifest())
    assert.equal(installed.status, 201)

    const list = await core.get('/api/plugins')
    assert.equal(list.status, 200)
    // The registry is no longer empty at boot: two built-in plugins ship with the
    // product. Assert about the plugin this test installed, and separately that the
    // built-ins are present and enabled, instead of an incidental global count.
    const installedPlugin = list.json.plugins.find((entry) => entry.id === 'acme.repo-inspector')
    assert.ok(installedPlugin, 'the plugin installed over HTTP must appear in the list')
    assert.equal(installedPlugin.state, 'installed')
    assert.equal(installedPlugin.builtin, false)
    const builtins = list.json.plugins.filter((entry) => entry.builtin)
    assert.deepEqual(builtins.map((entry) => entry.id).sort(), ['aetheris.insight', 'aetheris.knowledge'])
    assert.ok(builtins.every((entry) => entry.state === 'enabled'), 'built-ins are enabled at boot')
    assert.ok(builtins.every((entry) => entry.capabilities.every((capability) => capability.bound)), 'every built-in capability has a real handler bound')
    assert.equal(list.json.plugins.length, builtins.length + 1)

    const preflight = await core.post('/api/plugins/acme.repo-inspector/preflight', { capability: 'summarize' })
    assert.equal(preflight.status, 200)

    // A plugin installed over HTTP has no bound handler, so invoking it must fail
    // loudly rather than pretend to run.
    const invoked = await core.post('/api/plugins/acme.repo-inspector/invoke', {
      capability: 'summarize',
      input: { path: '/repo' },
    })
    assert.ok(invoked.status >= 400, `expected a refusal, got ${invoked.status}: ${invoked.text}`)

    // preflight answers a question, so it returns 200 with a negative verdict
    // rather than an HTTP error. The verdict is what matters.
    const unknownCapability = await core.post('/api/plugins/acme.repo-inspector/preflight', { capability: 'deleteEverything' })
    assert.equal(unknownCapability.status, 200)
    assert.equal(unknownCapability.json.allowed, false, 'an undeclared capability must not be allowed')

    // Invoking it is a different matter: that must be refused outright.
    const invokeUnknown = await core.post('/api/plugins/acme.repo-inspector/invoke', {
      capability: 'deleteEverything',
      input: {},
    })
    assert.ok(invokeUnknown.status >= 400, `invoking an undeclared capability must fail, got ${invokeUnknown.status}`)

    const disabled = await core.post('/api/plugins/acme.repo-inspector/disable', {})
    assert.equal(disabled.status, 200)
    const afterDisable = await core.post('/api/plugins/acme.repo-inspector/invoke', { capability: 'summarize', input: { path: '/repo' } })
    assert.ok(afterDisable.status >= 400, 'a disabled plugin must not be invocable')

    // Uninstalling keeps an auditable record rather than erasing it: that is what
    // stops an older version being silently reinstalled over a known-good one.
    const uninstalled = await core.post('/api/plugins/acme.repo-inspector/uninstall', {})
    assert.equal(uninstalled.status, 200)
    assert.equal(uninstalled.json.state, 'uninstalled')

    const everything = await core.get('/api/plugins')
    const retained = everything.json.plugins.find((entry) => entry.id === 'acme.repo-inspector')
    assert.ok(retained, 'the history record is retained')
    assert.equal(retained.state, 'uninstalled')
    // Built-ins survive an unrelated uninstall and stay enabled.
    assert.deepEqual(
      everything.json.plugins.filter((entry) => entry.builtin).map((entry) => entry.state),
      ['enabled', 'enabled'],
    )

    const enabledOnly = await core.get('/api/plugins?state=enabled')
    assert.ok(enabledOnly.json.plugins.every((entry) => entry.builtin), 'the state filter must actually filter')
    assert.ok(
      !enabledOnly.json.plugins.some((entry) => entry.id === 'acme.repo-inspector'),
      'an uninstalled plugin must not be listed as enabled',
    )

    const uninstalledOnly = await core.get('/api/plugins?state=uninstalled')
    assert.deepEqual(uninstalledOnly.json.plugins.map((entry) => entry.id), ['acme.repo-inspector'])

    // It is no longer offered as a capability, and its handlers are gone.
    const capabilities = await core.get('/api/plugins/capabilities')
    assert.deepEqual(capabilities.json.capabilities.filter((c) => c.pluginId === 'acme.repo-inspector'), [])

    const afterUninstall = await core.post('/api/plugins/acme.repo-inspector/invoke', { capability: 'summarize', input: { path: '/repo' } })
    assert.ok(afterUninstall.status >= 400, 'an uninstalled plugin must not be invocable')

    // Built-ins ship with the product: the refusal is explicit and audited, so the
    // interface disables the button rather than the user discovering a 4xx.
    const builtinUninstall = await core.post('/api/plugins/aetheris.insight/uninstall', {})
    assert.ok(builtinUninstall.status >= 400, `a builtin must not be uninstallable, got ${builtinUninstall.status}`)
    assert.match(builtinUninstall.text, /builtin/)
  } finally {
    await core.close()
  }
})

// ---------------------------------------------------------------------------
// Area 5: MCP
// ---------------------------------------------------------------------------

test('MCP: a registered server is discoverable and its tool validates arguments', async () => {
  const core = await startCore()
  try {
    core.app.mcp.registerServer({
      id: 'workspace',
      name: 'Workspace server',
      kind: SERVER_KINDS.IN_PROCESS,
      version: '1.0.0',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file from the workspace.',
          risk: RISK.READ_ONLY,
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string', minLength: 1 } },
            required: ['path'],
            additionalProperties: false,
          },
          outputSchema: { type: 'object', properties: { content: { type: 'string' }, bytes: { type: 'integer' } }, required: ['content', 'bytes'] },
          handler: async (args) => ({ content: `contents of ${args.path}`, bytes: 10 + args.path.length }),
        },
      ],
    })

    const servers = await core.get('/api/mcp/servers')
    assert.equal(servers.status, 200)
    // The in-process built-in server is registered at boot, so filter to the server
    // this test registered and assert the built-in separately.
    const workspace = servers.json.servers.find((entry) => entry.id === 'workspace')
    assert.ok(workspace, 'the registered server must be discoverable')
    assert.equal(workspace.tools.length, 1)
    const builtinServer = servers.json.servers.find((entry) => entry.id === 'aetheris.local')
    assert.ok(builtinServer, 'the built-in in-process server is registered at boot')
    assert.equal(builtinServer.kind, SERVER_KINDS.IN_PROCESS)
    assert.equal(servers.json.servers.length, 2)

    const tools = await core.get('/api/mcp/tools')
    assert.equal(tools.status, 200)
    const workspaceTools = tools.json.tools.filter((entry) => entry.serverId === 'workspace')
    assert.equal(workspaceTools.length, 1)
    assert.equal(workspaceTools[0].name, 'read_file')
    // Discovery can be scoped to one server, which is how the five areas avoid
    // mixing built-in tools with a caller's own.
    const scoped = await core.get('/api/mcp/tools?server=workspace')
    assert.equal(scoped.status, 200)
    assert.equal(scoped.json.tools.length, 1)

    const preflight = await core.post('/api/mcp/preflight', { server: 'workspace', tool: 'read_file' })
    assert.equal(preflight.status, 200)

    const ok = await core.post('/api/mcp/call', { server: 'workspace', tool: 'read_file', arguments: { path: '/notes.md' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.output.content, 'contents of /notes.md')
    assert.equal(ok.json.output.bytes, 19)
    // Tool output is data, never an instruction source.
    assert.equal(ok.json.untrusted, true)
    assert.equal(ok.json.outputValidated, true)

    // Schema violations are rejected before the handler runs.
    const missingRequired = await core.post('/api/mcp/call', { server: 'workspace', tool: 'read_file', arguments: {} })
    assert.equal(missingRequired.status, 400)
    assert.equal(missingRequired.json.error, 'invalid_arguments')

    const wrongType = await core.post('/api/mcp/call', { server: 'workspace', tool: 'read_file', arguments: { path: 42 } })
    assert.equal(wrongType.status, 400)

    const extraProperty = await core.post('/api/mcp/call', {
      server: 'workspace',
      tool: 'read_file',
      arguments: { path: '/x', isAdmin: true },
    })
    assert.equal(extraProperty.status, 400, 'additionalProperties:false must be enforced')
  } finally {
    await core.close()
  }
})

test('MCP: unknown servers and tools are 404s, not 500s', async () => {
  const core = await startCore()
  try {
    const unknownServer = await core.post('/api/mcp/call', { server: 'nope', tool: 'x', arguments: {} })
    assert.equal(unknownServer.status, 404)
    assert.equal(unknownServer.json.error, 'unknown_server')

    core.app.mcp.registerServer({
      id: 'workspace',
      name: 'Workspace server',
      kind: SERVER_KINDS.IN_PROCESS,
      version: '1.0.0',
      tools: [
        {
          name: 'ping',
          description: 'Ping.',
          risk: RISK.READ_ONLY,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          handler: async () => ({ pong: true }),
        },
      ],
    })
    const unknownTool = await core.post('/api/mcp/call', { server: 'workspace', tool: 'missing', arguments: {} })
    assert.equal(unknownTool.status, 404)
    assert.equal(unknownTool.json.error, 'unknown_tool')

    // A disabled server refuses calls.
    const toggled = await core.post('/api/mcp/servers/workspace/toggle', { enabled: false })
    assert.equal(toggled.status, 200)
    const afterDisable = await core.post('/api/mcp/call', { server: 'workspace', tool: 'ping', arguments: {} })
    assert.ok(afterDisable.status >= 400, 'a disabled MCP server must not answer calls')
  } finally {
    await core.close()
  }
})

test('MCP: destructive tools stop at the approval gate', async () => {
  const core = await startCore()
  try {
    let ran = false
    core.app.mcp.registerServer({
      id: 'fs',
      name: 'Filesystem',
      kind: SERVER_KINDS.IN_PROCESS,
      version: '1.0.0',
      tools: [
        {
          name: 'delete_all',
          description: 'Delete everything.',
          risk: RISK.DESTRUCTIVE,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
          handler: async () => {
            ran = true
            return { deleted: 1 }
          },
        },
      ],
    })

    const preflight = await core.post('/api/mcp/preflight', { server: 'fs', tool: 'delete_all' })
    assert.equal(preflight.status, 200)
    assert.equal(preflight.json.needsApproval, true)

    const call = await core.post('/api/mcp/call', { server: 'fs', tool: 'delete_all', arguments: { path: '/data' } })
    assert.equal(call.status, 409, 'an unapproved destructive call must not run')
    assert.equal(call.json.error, 'approval_required')
    assert.equal(ran, false, 'the handler must never execute without approval')
  } finally {
    await core.close()
  }
})

// ---------------------------------------------------------------------------
// Cross-cutting: audit and secrets
// ---------------------------------------------------------------------------

test('every area leaves an audit trail', async () => {
  const core = await startCore()
  try {
    await core.get('/api/health')
    await core.post('/api/chat', { prompt: 'audit me' })
    await core.post('/api/knowledge/ingest', { title: 'Audit', text: 'Something auditable about the contactor.' })
    await core.post('/api/image/generate', { prompt: 'a blue circle' })

    const audit = await core.get('/api/audit?limit=200')
    assert.equal(audit.status, 200)
    const actions = audit.json.events.map((event) => event.action)
    assert.ok(actions.some((action) => /chat/.test(action)), `no chat audit entry in ${actions.join(', ')}`)
    assert.ok(actions.some((action) => /knowledge|ingest/.test(action)), 'no knowledge audit entry')
    assert.ok(actions.some((action) => /image/.test(action)), 'a refused image request is still worth recording')
    assert.ok(audit.json.events.every((event) => typeof event.seq === 'number'), 'audit entries must be ordered')
  } finally {
    await core.close()
  }
})

test('no route leaks a configured credential', async () => {
  const secret = 'sk-super-secret-value-do-not-log'
  const core = await startCore({
    env: {
      LLAMACPP_ENABLED: 'true',
      LLAMACPP_API_KEY: secret,
    },
  })
  try {
    for (const path of ['/api/config', '/api/ready', '/api/health', '/api/models', '/api/events', '/api/audit?limit=200', '/api/hardware']) {
      const response = await core.get(path)
      assert.equal(response.text.includes(secret), false, `${path} leaked the credential`)
      assert.equal(response.text.includes('sk-super'), false, `${path} leaked a credential prefix`)
    }
    // The config view says a key exists without revealing it.
    const config = await core.get('/api/config')
    assert.equal(config.json.llamaCpp.keyConfigured, true)
    assert.equal(config.json.llamaCpp.baseUrl, 'http://127.0.0.1:8080/v1')

    // strict_offline still refuses to reach out, even though a runtime holding a
    // credential is configured.
    const chat = await core.post('/api/chat', { prompt: 'go online' })
    assert.ok([200, 503].includes(chat.status))
    assert.equal(chat.json.sentExternally ?? false, false, 'nothing may be sent externally under strict_offline')
  } finally {
    await core.close()
  }
})

// --- memory and session recall over real HTTP ------------------------------------

test('memory: a candidate proposed over HTTP never reaches the prompt until approved', async () => {
  const core = await startCore()
  try {
    const created = await core.post('/api/memory', { text: 'Release builds are cut on Tuesdays.', kind: 'constraint' })
    assert.equal(created.status, 201)
    assert.equal(created.json.memory.approvedBy, 'user')
    assert.equal(created.json.memory.trainingUse, 'prohibited')

    const proposed = await core.post('/api/memory/candidates', {
      text: 'The reviewer prefers small pull requests.',
      rationale: 'stated while rejecting a large diff',
      proposedFrom: 'conversation',
    })
    assert.equal(proposed.json.status, 'pending')

    const listed = await core.get('/api/memory')
    assert.equal(listed.json.memories.length, 1, 'the candidate is not a memory yet')
    assert.equal(listed.json.candidates.length, 1)
    assert.equal(listed.json.stats.pendingCandidates, 1)

    // Search must not surface the candidate either.
    assert.equal((await core.get('/api/memory/search?q=reviewer')).json.results.length, 0)

    const decided = await core.post(`/api/memory/candidates/${proposed.json.id}/decide`, { approve: true })
    assert.equal(decided.json.approved, true)
    assert.equal(decided.json.memory.approvedBy, 'user')
    assert.equal((await core.get('/api/memory/search?q=reviewer')).json.results.length, 1)
  } finally {
    await core.close()
  }
})

test('memory: edit, then real deletion with a tombstone that does not quote it', async () => {
  const core = await startCore({ withModel: false })
  try {
    const created = await core.post('/api/memory', { text: 'Uses Node 20.' })
    const edited = await core.patch(`/api/memory/${created.json.memory.id}`, { text: 'Uses Node 22.' })
    assert.equal(edited.json.text, 'Uses Node 22.')

    const forgotten = await core.del(`/api/memory/${created.json.memory.id}`, { reason: 'wrong version' })
    assert.equal(forgotten.json.deleted, true)
    const listed = await core.get('/api/memory')
    assert.equal(listed.json.memories.length, 0)
    assert.equal(listed.json.stats.deletionsRecorded, 1)
    assert.ok(!JSON.stringify(listed.json).includes('Uses Node 22'), 'the deletion log must not quote the memory')

    const missing = await core.del(`/api/memory/${created.json.memory.id}`)
    assert.equal(missing.status, 404, 'forgetting a memory twice is reported, not ignored')
  } finally {
    await core.close()
  }
})

test('memory: a full wipe clears memories and candidates and says how many', async () => {
  const core = await startCore({ withModel: false })
  try {
    await core.post('/api/memory', { text: 'one' })
    await core.post('/api/memory', { text: 'two' })
    await core.post('/api/memory/candidates', { text: 'pending', proposedFrom: 'conversation' })
    const wiped = await core.del('/api/memory/forget-all')
    assert.deepEqual(wiped.json, { deletedMemories: 2, deletedCandidates: 1 })
    assert.equal((await core.get('/api/memory')).json.stats.memories, 0)
  } finally {
    await core.close()
  }
})

test('sessions: a chat with a session records turns that recall can find with their origin', async () => {
  const core = await startCore()
  try {
    const session = await core.post('/api/sessions', { title: 'Ingest troubleshooting' })
    assert.equal(session.status, 201)
    assert.equal(session.json.turnCount, 0)

    const chat = await core.post('/api/chat', {
      prompt: 'Which delimiter does the ingest job expect?',
      sessionId: session.json.id,
    })
    assert.ok(chat.json.text.length > 0, 'the fixture model answered')

    const stored = await core.get(`/api/sessions/${session.json.id}`)
    assert.equal(stored.json.turnCount, 2)
    assert.equal(stored.json.turns[0].role, 'user')
    assert.equal(stored.json.turns[1].role, 'assistant')
    assert.match(stored.json.turns[0].content, /delimiter/)

    const recall = await core.get('/api/sessions/recall?q=delimiter')
    // Both turns can match -- the fixture model echoes the question -- so the assertion
    // is about provenance rather than about a count: every hit says which session it came
    // from, and the user's own question is among them.
    assert.ok(recall.json.hits.length >= 1, 'the turn should be findable')
    for (const hit of recall.json.hits) {
      assert.equal(hit.sessionId, session.json.id)
      assert.equal(hit.sessionTitle, 'Ingest troubleshooting')
      assert.ok(hit.excerpt.text.includes('delimiter'))
      assert.ok(['user', 'assistant'].includes(hit.role))
    }
    assert.ok(recall.json.hits.some((h) => h.role === 'user'))

    const removed = await core.del(`/api/sessions/${session.json.id}`)
    assert.equal(removed.json.turnsRemoved, 2)
    assert.equal((await core.get('/api/sessions/recall?q=delimiter')).json.hits.length, 0)
    assert.equal((await core.get(`/api/sessions/${session.json.id}`)).status, 404)
  } finally {
    await core.close()
  }
})

test('chat: useMemory injects approved memory and raises the classification of the request', async () => {
  const core = await startCore()
  try {
    await core.post('/api/memory', { text: 'The internal codename is Falcon.', dataClass: 'confidential' })
    const chat = await core.post('/api/chat', { prompt: 'What is the codename?', useMemory: true })
    assert.equal(chat.json.memory.used, true)
    assert.equal(chat.json.memory.count, 1)
    assert.deepEqual(chat.json.memory.dataClasses, ['confidential'])
    // A public question plus a confidential memory is a confidential request. This is
    // the assertion that stops memory injection becoming an exfiltration path.
    assert.equal(chat.json.classification, 'confidential')
    assert.equal(chat.json.sentExternally, false)
  } finally {
    await core.close()
  }
})

test('chat: without useMemory nothing from the store is injected', async () => {
  const core = await startCore()
  try {
    await core.post('/api/memory', { text: 'The internal codename is Falcon.', dataClass: 'confidential' })
    const chat = await core.post('/api/chat', { prompt: 'What is the codename?' })
    assert.equal(chat.json.memory, null)
    assert.equal(chat.json.classification, 'public')
    assert.equal(chat.json.sentExternally, false, 'still local: the fixture serves it')
  } finally {
    await core.close()
  }
})

test('every field the web panels read comes back from the routes they call', async () => {
  // ChatArea.jsx's MemoryPanel and HistoryPanel read named fields off these responses. The
  // two ways that goes wrong are both silent: a field renamed on the server renders as a
  // blank cell, and a nested field read as if it were flat renders as three blank cells.
  // Both have happened in this repository (models lost `availability`; memory search
  // results are hits with the memory under `.memory`), so the client's field list is
  // asserted here rather than left to whoever clicks through the UI next.
  const core = await startCore()
  try {
    // --- the memory panel's first call ------------------------------------
    let memory = (await core.get('/api/memory')).json
    assert.deepEqual(Object.keys(memory).sort(), ['candidates', 'memories', 'stats'])
    assert.ok(Array.isArray(memory.memories) && Array.isArray(memory.candidates))
    assert.equal(typeof memory.stats.memories, 'number')
    assert.equal(typeof memory.stats.pendingCandidates, 'number')
    assert.equal(typeof memory.stats.supersededMemories, 'number')
    assert.equal(typeof memory.stats.deletionsRecorded, 'number')
    // The panel states its capacity from this, and falls back to generic wording without it.
    assert.equal(typeof memory.stats.limits.maxMemories, 'number')

    // --- "Ask Aetheris to remember something" -----------------------------
    const remembered = (await core.post('/api/memory', {
      text: 'Prefers responses in British English.',
      kind: 'preference',
      subject: 'writing style',
      dataClass: 'internal',
    })).json
    // The 201 is an envelope, not the row: `duplicate` is what lets the panel say "that is
    // already remembered" instead of silently adding a second copy of the same statement.
    assert.deepEqual(Object.keys(remembered).sort(), ['duplicate', 'memory'])
    assert.equal(remembered.duplicate, false)
    for (const field of ['id', 'text', 'kind', 'subject', 'dataClass']) {
      assert.ok(field in remembered.memory, `remembering must return '${field}'; the row renders it`)
    }

    // --- "Find a memory" --------------------------------------------------
    const search = (await core.get('/api/memory/search?q=British')).json
    assert.deepEqual(Object.keys(search).sort(), ['query', 'results'])
    assert.ok(search.results.length >= 1)
    // The panel renders result.memory.text, not result.text: these are BM25 hits with the
    // row hydrated underneath them.
    const hit = search.results.find((entry) => entry.memory)
    assert.ok(hit, 'a search result must carry its memory under `.memory`')
    for (const field of ['id', 'text', 'kind', 'dataClass']) {
      assert.ok(field in hit.memory, `the rendered memory must carry '${field}'`)
    }

    // --- propose, then approve from the panel -----------------------------
    const proposed = (await core.post('/api/memory/candidates', {
      text: 'I deploy on Fridays.',
      rationale: 'stated while planning a release',
      proposedFrom: 'conversation',
    })).json
    // Proposing returns the bare row it created; the card the user decides on is built
    // from the pending list, which is where the four fields it renders come from.
    assert.deepEqual(Object.keys(proposed).sort(), ['id', 'status', 'text'])
    memory = (await core.get('/api/memory')).json
    const card = memory.candidates.find((candidate) => candidate.id === proposed.id)
    assert.ok(card, 'a proposed candidate must appear in the pending list')
    for (const field of ['id', 'text', 'rationale', 'proposedFrom']) {
      assert.ok(field in card, `the candidate card renders '${field}'`)
    }

    const decision = (await core.post(`/api/memory/candidates/${proposed.id}/decide`, { approve: true })).json
    assert.equal(decision.approved, true)
    assert.ok(decision.memory.id, 'approving must return the memory it created')
    memory = (await core.get('/api/memory')).json
    assert.equal(memory.stats.memories, 2, 'approving must produce a memory')
    assert.equal(memory.stats.pendingCandidates, 0)
    assert.ok(!memory.candidates.some((candidate) => candidate.id === proposed.id),
      'a decided candidate must leave the pending list the card was rendered from')

    // --- edit in place, then delete ---------------------------------------
    const edited = (await core.patch(`/api/memory/${remembered.memory.id}`, { text: 'Prefers British spelling.' })).json
    assert.equal(edited.text, 'Prefers British spelling.')

    const forgotten = (await core.del(`/api/memory/${remembered.memory.id}`, { reason: 'removed from the memory panel' })).json
    assert.equal(forgotten.deleted, true)
    // The tombstone the panel promises: a record that it happened, never what it said.
    const after = (await core.get('/api/memory')).json
    assert.ok(!after.memories.some((entry) => entry.id === remembered.memory.id))

    // --- the conversation's session ---------------------------------------
    const session = (await core.post('/api/sessions', { title: null })).json
    assert.ok(session.id, 'starting a session must return its id; the composer stores it')
    const chat = (await core.post('/api/chat', {
      prompt: 'What do I deploy on?',
      sessionId: session.id,
      useMemory: true,
      stream: false,
    })).json
    // The reply chip reads meta.memory.used and meta.memory.count.
    assert.equal(chat.memory.used, true)
    assert.ok(chat.memory.count >= 1)

    const sessions = (await core.get('/api/sessions')).json
    const listed = sessions.sessions.find((entry) => entry.id === session.id)
    for (const field of ['id', 'title', 'turnCount', 'lastAt']) {
      assert.ok(field in listed, `the history table renders '${field}'`)
    }
    assert.equal(listed.turnCount, 2, 'the question and the answer are both turns')

    const recall = (await core.get('/api/sessions/recall?q=deploy')).json
    assert.equal(typeof recall.searchedTurns, 'number')
    assert.ok(recall.hits.length >= 1, 'recall must find the turn it stored')
    for (const field of ['turnId', 'sessionId', 'sessionTitle', 'role', 'at']) {
      assert.ok(field in recall.hits[0], `a recall hit must carry '${field}'`)
    }
    // The panel prints excerpt.text. It is a quotation of the user's own turn, which is
    // why it must exist: a generated summary presented as a quotation is not acceptable.
    assert.equal(typeof recall.hits[0].excerpt.text, 'string')
    assert.ok(recall.hits.some((entry) => entry.role === 'user'))

    // An empty query reports a reason instead of a searchedTurns count, and the panel
    // branches on that rather than printing "Searched undefined turns".
    const empty = (await core.get('/api/sessions/recall?q=')).json
    assert.ok(empty.reason, 'an empty query must explain itself')
    assert.ok(!('searchedTurns' in empty), 'and must not imply a search happened')

    // --- "Download a copy" -------------------------------------------------
    const exported = (await core.get('/api/memory/export')).json
    assert.equal(exported.format, 'aetheris-memory-export/v1')
    // The confirmation the panel shows is built from these four.
    assert.equal(exported.consent, 'user_approved')
    assert.equal(exported.trainingUse, 'prohibited')
    assert.ok(Array.isArray(exported.memories) && exported.memories.length >= 1)
    assert.ok(Array.isArray(exported.sessions) && exported.sessions.length >= 1)
    // The restriction travels with each record, not only in the envelope.
    assert.equal(exported.memories[0].trainingUse, 'prohibited')
    // And the export is of everything, not of what is left after a wipe.
    assert.equal(exported.sessions[0].turns.length, 2)

    // --- deleting a session from the history table -------------------------
    const removed = (await core.del(`/api/sessions/${session.id}`)).json
    assert.equal(removed.deleted, true)
    const remaining = (await core.get('/api/sessions')).json
    assert.ok(!remaining.sessions.some((entry) => entry.id === session.id))
    const orphaned = (await core.get('/api/sessions/recall?q=deploy')).json
    assert.equal(orphaned.hits.length, 0, 'recall must not resurrect a deleted session')

    // --- "Delete everything" ----------------------------------------------
    const wiped = (await core.del('/api/memory/forget-all')).json
    // The panel's confirmation states these two numbers, so they have to exist and be
    // right. One memory remains at this point -- the one the approved proposal produced --
    // and the wipe removes the candidate row it came from too, so that number is one and
    // not zero: a decided proposal holds the same user text a pending one does.
    assert.deepEqual(wiped, { deletedMemories: 1, deletedCandidates: 1 })
    const cleared = (await core.get('/api/memory')).json
    assert.equal(cleared.stats.memories, 0)
    assert.equal(cleared.stats.pendingCandidates, 0)
  } finally {
    await core.close()
  }
})

// --- plugin signing and the MCP allowlist, over the real HTTP surface ----------------

test('a signed plugin installs over HTTP once its key is trusted, and not before', async () => {
  const core = await startCore({ withModel: false })
  try {
    const { generateKeyPair, signManifest } = await import('../src/plugins/signing.mjs')
    const publisher = generateKeyPair()
    const manifest = {
      id: 'acme.repo-inspector',
      name: 'Repository Inspector',
      version: '1.0.0',
      protocol: PROTOCOLS.LOCAL_TOOL,
      description: 'Reads repository metadata.',
      scopes: [SCOPES.FS_READ],
      capabilities: [{
        name: 'summarize',
        description: 'Summarise a path.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
        requiredScopes: [SCOPES.FS_READ],
        readOnly: true,
      }],
    }
    const signed = signManifest(manifest, publisher.privateKeyPem)

    // The key is not trusted yet, so presenting this signature is worse than presenting
    // none: it claims a publisher this host cannot check.
    const refused = await core.post('/api/plugins/install', signed)
    // 403, not 500: presenting a key this host does not know is a refusal, and reporting
    // it as a server fault would hide a security decision inside an error page. The error
    // envelope carries a code and a message, so the message has to say which key and why --
    // there is no field for the client to read, and inventing one here would leave every
    // other refusal with an empty version of it.
    assert.equal(refused.status, 403)
    assert.equal(refused.json.error, 'plugin_signature_rejected')
    assert.match(refused.json.message, /is not in the trust store/)
    assert.ok(refused.json.message.includes(publisher.keyId), 'the message must name the key')

    // Trust the key. The route reports the id it derived, never the key material.
    const trusted = await core.post('/api/plugins/trust', { pem: publisher.publicKeyPem, label: 'Acme' })
    assert.equal(trusted.status, 201)
    assert.equal(trusted.json.keyId, publisher.keyId)

    const listed = (await core.get('/api/plugins/trust')).json
    assert.deepEqual(listed.keys, [{ keyId: publisher.keyId, label: 'Acme', addedAt: listed.keys[0].addedAt }])
    assert.ok(!JSON.stringify(listed).includes('PUBLIC KEY'), 'the route must not return key material')

    const installed = await core.post('/api/plugins/install', signed)
    assert.equal(installed.status, 201)
    assert.equal(installed.json.signature.state, 'verified')
    assert.equal(installed.json.signature.keyId, publisher.keyId)

    // Removing the key does not retroactively bless the plugin: installing again now fails,
    // and the refusal is the same one as before the key was ever added.
    assert.equal((await core.del(`/api/plugins/trust/${publisher.keyId}`)).status, 200)
    const afterRemoval = await core.post('/api/plugins/install', { ...signed, version: '1.0.1' })
    assert.equal(afterRemoval.status, 403)
    assert.equal(afterRemoval.json.error, 'plugin_signature_rejected')
    assert.match(afterRemoval.json.message, /is not in the trust store/)

    // Both changes to the root of trust are in the ledger.
    const audit = (await core.get('/api/audit?limit=200')).json
    const actions = audit.events.map((entry) => entry.action)
    assert.ok(actions.includes('trust_key_added'), 'adding a key must be audited')
    assert.ok(actions.includes('trust_key_removed'), 'removing a key must be audited')
  } finally {
    await core.close()
  }
})

test('the MCP allowlist governs host-reached servers, and the service reports it that way', async () => {
  const core = await startCore({ withModel: false, env: { AETHERIS_MCP_ALLOWLIST: 'id:notes,origin:https://mcp.example.com' } })
  try {
    // Reported as a configured restriction, with the entries as given.
    const config = (await core.get('/api/config')).json
    assert.equal(config.mcp.restricted, true)
    assert.deepEqual(config.mcp.allowlist, ['id:notes', 'origin:https://mcp.example.com'])

    // In-process servers the product ships keep working: they are code in this process, not
    // a host this service reaches, and a host allowlist is not the control for them.
    const servers = (await core.get('/api/mcp/servers')).json.servers
    assert.ok(servers.length >= 1)
    assert.ok(servers.every((server) => server.kind === 'in_process'))

    // A transport server has to be named, by id or by the origin of its endpoint.
    const list = core.app.mcp.allowlist
    const permit = (spec) => core.app.mcp.permitServer(spec)
    assert.equal(permit({ id: 'notes', kind: 'transport', endpoint: 'https://mcp.example.com/rpc' }).allowed, true)
    assert.equal(permit({ id: 'anything', kind: 'transport', endpoint: 'https://mcp.example.com/rpc' }).allowed, true)
    // Suffix and prefix lookalikes are not admitted: an allowlist that matches on a string
    // prefix is how `mcp.example.com.attacker.net` gets in.
    for (const endpoint of ['https://mcp.example.com.attacker.net/rpc', 'https://evil.net/mcp.example.com', 'http://mcp.example.com/rpc']) {
      assert.equal(permit({ id: 'x', kind: 'transport', endpoint }).allowed, false, `${endpoint} must not be admitted`)
    }
    assert.equal(permit({ id: 'unlisted', kind: 'transport', endpoint: 'https://other.example.com/rpc' }).allowed, false)
    assert.equal(list.size, 2)
  } finally {
    await core.close()
  }
})

test('an unparseable allowlist is refused instead of being skipped', () => {
  // '\*' is not a shorthand for "everything" here: a control that can be disabled by a
  // character the operator thought meant more access is a control that fails open.
  assert.throws(() => parseAllowlist('*'), /not an allowlist entry/)
  assert.throws(() => parseAllowlist('notes'), /must be 'id:/)
  assert.throws(() => parseAllowlist('id:'), /has no value/)
  assert.throws(() => parseAllowlist('origin:not-a-url'), /is not a URL/)
  assert.throws(() => parseAllowlist('whatever:notes'), /unknown kind/)
  assert.equal(parseAllowlist(''), null)
  assert.equal(parseAllowlist('id:notes,origin:https://example.com').size, 2)
})

// ---------------------------------------------------------------------------
// Procedural skills over HTTP
// ---------------------------------------------------------------------------

const SKILL_DOCUMENT = `---
name: fix-stale-docker-cache
description: Fixes a stale Docker build cache.
version: 1.0.0
createdBy: agent
author: Aetheris experience capture
license: MIT
tags:
  - docker
  - build
---

## When to Use

When a Docker build does not pick up a changed dependency.

## Prerequisites

- Docker is installed.

## Procedure

1. Reproduce the stale build.
2. Rebuild without cache.
3. Confirm the change is present.

## Pitfalls

- Clearing the cache also removes layers you wanted.

## Verification

Rebuild twice and confirm the second run is reproducible.
`

test('skills persist, promote only on evidence, and are served over HTTP', async () => {
  const first = await startCore({ withModel: false })
  let dataDir = null
  try {
    // An empty store is empty, and says where it looked. A skill listing that cannot be
    // distinguished from a broken one is not a usable listing.
    const empty = await first.get('/api/skills')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.skills, [])
    assert.equal(empty.json.stats.total, 0)
    assert.match(empty.json.store.dir, /skills$/)
    dataDir = first.app.config.dataDir

    // Installing is untrusted input: it lands as a candidate, never as a validated skill.
    const installed = await first.post('/api/skills', { document: SKILL_DOCUMENT })
    assert.equal(installed.status, 201)
    assert.equal(installed.json.name, 'fix-stale-docker-cache')
    assert.equal(installed.json.state, 'candidate')
    assert.equal(installed.json.loadable, false)

    // Text that is not a skill document is refused with a reason rather than stored.
    const rejected = await first.post('/api/skills', { document: '# just a heading\n' })
    assert.equal(rejected.status, 400)
    assert.ok(rejected.json.message.length > 0, 'the refusal must say what was wrong')

    // A candidate is not offered as relevant, and cannot be loaded as a procedure.
    const listing = await first.get('/api/skills?q=stale%20docker%20build%20cache')
    assert.equal(listing.json.method, 'bm25')
    assert.deepEqual(listing.json.matches, [], 'an unverified procedure must not be offered as relevant')
    const refused = await first.post('/api/skills/fix-stale-docker-cache/load', {})
    assert.equal(refused.status, 409)
    assert.match(refused.json.message, /has not been validated/)

    // Reviewing a proposal is a deliberate act, and the response says what it is.
    const reviewed = await first.post('/api/skills/fix-stale-docker-cache/load', { allowCandidate: true })
    assert.equal(reviewed.status, 200)
    assert.equal(reviewed.json.validated, false)
    assert.equal(reviewed.json.loadable, false)
    assert.match(reviewed.json.text, /Rebuild without cache/)
    assert.deepEqual(reviewed.json.sections,
      ['When to Use', 'Prerequisites', 'Procedure', 'Pitfalls', 'Verification'],
      'a review must show the document structure, not a serialised Map')

    // Promotion needs evidence, and a failing check is not evidence.
    const noEvidence = await first.post('/api/skills/fix-stale-docker-cache/validate', {})
    assert.equal(noEvidence.status, 409)
    const failedCheck = await first.post('/api/skills/fix-stale-docker-cache/validate', {
      evidence: { checks: [{ name: 'reproduced', passed: true }, { name: 'corrected', passed: false }] },
    })
    assert.equal(failedCheck.status, 409)
    assert.match(failedCheck.json.message, /corrected/)

    const validated = await first.post('/api/skills/fix-stale-docker-cache/validate', {
      evidence: { checks: [{ name: 'reproduced', passed: true }, { name: 'corrected', passed: true }], verifiedBy: 'user' },
    })
    assert.equal(validated.status, 200)
    assert.equal(validated.json.state, 'validated')

    // Promotion is written when it happens, and not as a side effect of loading later:
    // restarting here must already see a validated procedure. This ordering is deliberate.
    // An earlier version of this test loaded first, which meant the load route's write
    // covered for a missing write on the validate route, and removing that write failed
    // nothing at all.
    const second = await startCore({ withModel: false, env: { AETHERIS_DATA_DIR: dataDir } })
    let third = null
    try {
      const restored = await second.get('/api/skills')
      assert.deepEqual(restored.json.store.restored, ['fix-stale-docker-cache'])
      assert.deepEqual(restored.json.store.failures, [])
      assert.equal(restored.json.skills[0].state, 'validated')
      // Reviewing a proposal is reading it, not using it, so no counter moved.
      assert.equal(restored.json.skills[0].usage.useCount, 0)

      // Now it is relevant, and loading it records the use.
      const matched = await second.get('/api/skills?q=stale%20docker%20build%20cache')
      assert.equal(matched.json.matches.length, 1)
      assert.equal(matched.json.matches[0].name, 'fix-stale-docker-cache')
      assert.ok(!matched.json.matches[0].text, 'the listing carries short fields, not the procedure')
      const loaded = await second.post('/api/skills/fix-stale-docker-cache/load', { reason: 'task' })
      assert.equal(loaded.status, 200)
      assert.match(loaded.json.text, /Rebuild without cache/)
      assert.equal(loaded.json.usage.useCount, 1)

      // And the use is written at the moment of use, for the same reason.
      third = await startCore({ withModel: false, env: { AETHERIS_DATA_DIR: dataDir } })
      const after = await third.get('/api/skills')
      assert.equal(after.json.skills[0].state, 'validated')
      assert.equal(after.json.skills[0].usage.useCount, 1, 'usage decides what the curator archives, so it survives')

      // Every transition is in the audit trail.
      const audit = await third.get('/api/audit?limit=200')
      const actions = audit.json.events.filter((entry) => entry.category === 'skill').map((entry) => entry.action)
      for (const action of ['skill_installed', 'skill_validated', 'skill_candidate_reviewed', 'skill_loaded']) {
        assert.ok(actions.includes(action), `${action} must be audited`)
      }
    } finally {
      if (third) await third.close()
      await second.close()
    }
  } finally {
    await first.close()
  }
})

test('deleting a skill removes the procedure and reports what was removed', async () => {
  const core = await startCore({ withModel: false })
  try {
    await core.post('/api/skills', { document: SKILL_DOCUMENT })
    await core.post('/api/skills/fix-stale-docker-cache/validate', {
      evidence: { checks: [{ name: 'reproduced', passed: true }] },
    })

    const removed = await core.del('/api/skills/fix-stale-docker-cache', { reason: 'no longer accurate' })
    assert.equal(removed.status, 200)
    assert.equal(removed.json.deleted, true)
    assert.equal(removed.json.versionsRemoved, 1)

    assert.equal((await core.get('/api/skills')).json.skills.length, 0)
    assert.equal((await core.get('/api/skills/fix-stale-docker-cache')).status, 404)

    const deletions = await core.get('/api/skills/deletions')
    assert.equal(deletions.json.deletions.length, 1)
    assert.equal(deletions.json.deletions[0].reason, 'no longer accurate')
    // The tombstone records that a deletion happened and never what was deleted.
    assert.ok(!JSON.stringify(deletions.json.deletions).includes('Docker'))

    const again = await core.del('/api/skills/fix-stale-docker-cache')
    assert.equal(again.status, 404, 'deleting a skill that is not there is a 404, not a success')
  } finally {
    await core.close()
  }
})
