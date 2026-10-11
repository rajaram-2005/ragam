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
    FREELLMAPI_ENABLED: 'false',
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
      FREELLMAPI_ENABLED: 'true',
      FREELLMAPI_BASE_URL: 'https://gateway.freellmapi.co/v1',
      FREELLMAPI_API_KEY: secret,
      AETHERIS_ONLINE_ALLOWLIST: 'gateway.freellmapi.co',
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
    assert.equal(config.json.freellmapi.keyConfigured, true)
    assert.equal(config.json.freellmapi.endpoint, 'https://gateway.freellmapi.co/v1')

    // strict_offline still blocks the gateway even though it is configured.
    const chat = await core.post('/api/chat', { prompt: 'go online' })
    assert.ok([200, 503].includes(chat.status))
    assert.equal(chat.json.sentExternally ?? false, false, 'nothing may be sent externally under strict_offline')
  } finally {
    await core.close()
  }
})
