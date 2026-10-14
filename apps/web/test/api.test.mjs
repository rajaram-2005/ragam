// API client tests.
//
// Two things are worth testing here, and neither is obvious from reading the code:
//
//   1. Every request goes to a RELATIVE path. The browser is not the sandbox, so an
//      absolute http://127.0.0.1:8790 would resolve against the user's own machine
//      and fail behind a preview proxy. The fake fetch records the exact URL string
//      handed to it and the tests assert it never contains a host.
//   2. The paths the client produces still exist on the server. A renamed route
//      fails silently in a UI (everything becomes a red "request failed" box), so
//      the route table is pinned against the real router source in
//      services/core/src/app.mjs. If the server drops or renames a route, this file
//      fails — which is the point.
//
// Error normalisation matters too: the UI distinguishes "no model installed" from
// "backend unreachable" only because ApiError carries the server's own code.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { api, ApiError, streamChat } from '../src/api.js'

const here = dirname(fileURLToPath(import.meta.url))
const APP_MJS = join(here, '..', '..', '..', 'services', 'core', 'src', 'app.mjs')
// The ACTIVE product. `npm run core` boots online/app.mjs, not the legacy app.mjs above,
// so a client path can be pinned to a router that is no longer the one being served --
// which is a green test and a red UI. Both are checked: the legacy table for the routes
// the retained components use, and the online table for every route this product serves.
const ONLINE_APP_MJS = join(here, '..', '..', '..', 'services', 'core', 'src', 'online', 'app.mjs')
const ONLINE_CONTEXT_MJS = join(here, '..', '..', '..', 'services', 'core', 'src', 'online', 'context-routes.mjs')
const WEB_SRC = join(here, '..', 'src')

/** A minimal Response stand-in: the client only uses ok/status/text/body. */
function fakeResponse({ ok = true, status = 200, body = {}, raw = null } = {}) {
  const text = raw ?? JSON.stringify(body)
  return { ok, status, text: async () => text }
}

/** A fake SSE stream, chunked so frame-splitting across reads is exercised. */
function fakeStream(frames, { chunkEvery = 1 } = {}) {
  const encoded = frames.map((frame) => new TextEncoder().encode(frame))
  // Re-slice into chunks that deliberately split frames mid-way.
  const joined = frames.join('')
  const bytes = new TextEncoder().encode(joined)
  const size = Math.max(1, Math.ceil(bytes.length / Math.max(1, chunkEvery)))
  const chunks = []
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size))
  let index = 0
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      pull(controller) {
        if (index >= chunks.length) controller.close()
        else controller.enqueue(chunks[index++])
      },
    }),
    text: async () => '',
    _encoded: encoded,
  }
}

/** Install a recording fetch and return the log plus a restore function. */
function installFetch(responder) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null, headers: init?.headers ?? {}, signal: init?.signal })
    return responder(calls[calls.length - 1])
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// ---------------------------------------------------------------------------
// Relative paths only
// ---------------------------------------------------------------------------

test('every API call uses a relative path, never an absolute host', async () => {
  const { calls, restore } = installFetch(() => fakeResponse({ body: { ok: true, models: [], plugins: [], servers: [], tools: [], resources: [], prompts: [], jobs: [], tasks: [], documents: [], events: [] } }))
  try {
    const samples = [
      () => api.health(), () => api.ready(), () => api.config(), () => api.hardware(),
      () => api.models(), () => api.models(true), () => api.probeModels(), () => api.events(), () => api.audit(10),
      () => api.chat({ prompt: 'hi' }), () => api.knowledgeSearch({ query: 'q' }),
      () => api.knowledgeIngest({ title: 't', text: 'x' }), () => api.knowledgeStats(),
      () => api.knowledgeDocuments(), () => api.knowledgeReindex(),
      () => api.tasks(5), () => api.task('abc'), () => api.createTask({ prompt: 'p' }),
      () => api.pauseTask('abc', 'r'), () => api.resumeTask('abc'), () => api.cancelTask('abc', 'r'),
      () => api.approveTask('abc', { approvals: [] }),
      () => api.generateImage({ prompt: 'p' }), () => api.imageJobs(5),
      () => api.generateVideo({ prompt: 'p' }), () => api.videoJobs(5),
      () => api.mediaJobs(5), () => api.cancelMediaJob('job-1'),
      () => api.plugins(), () => api.plugins('enabled'), () => api.pluginCapabilities(),
      () => api.validateManifest({ manifest: {} }), () => api.installPlugin({ manifest: {} }),
      () => api.pluginPreflight('p', 'c'), () => api.pluginInvoke('p', 'c', { a: 1 }),
      () => api.setPluginState('p', 'enable'),
      () => api.mcpServers(), () => api.mcpTools({ server: 's' }), () => api.mcpResources(),
      () => api.mcpPrompts(), () => api.mcpPreflight('s', 't'), () => api.mcpCall('s', 't', { a: 1 }),
      () => api.mcpToggle('s', true),
    ]
    for (const call of samples) await call()

    assert.ok(calls.length >= samples.length, `expected at least ${samples.length} calls, recorded ${calls.length}`)
    for (const call of calls) {
      assert.ok(call.url.startsWith('/api/'), `request went to a non-relative URL: ${call.url}`)
      assert.ok(!/^https?:\/\//.test(call.url), `request contained an absolute host: ${call.url}`)
      assert.ok(!call.url.includes('localhost') && !call.url.includes('127.0.0.1'), `request leaked a loopback host: ${call.url}`)
    }
  } finally {
    restore()
  }
})

test('the artifact URL is relative so an <img>/<video> tag resolves through the proxy', () => {
  const url = api.artifactUrl('job-123')
  assert.equal(url, '/api/media/artifact/job-123')
  assert.ok(!url.includes('localhost'))
})

test('path parameters are percent-encoded', () => {
  const { calls, restore } = installFetch(() => fakeResponse({ body: {} }))
  try {
    api.task('a b/c?d').catch(() => {})
    return Promise.resolve().then(() => {
      assert.ok(calls[0].url.includes('a%20b'), `expected an encoded space, got ${calls[0].url}`)
      assert.ok(!calls[0].url.includes('?d'), 'a query string in an id must not become a real query string')
      restore()
    })
  } catch (error) {
    restore()
    throw error
  }
})

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

test('a server error envelope becomes an ApiError carrying code, limitation and route', async () => {
  const { restore } = installFetch(() =>
    fakeResponse({
      ok: false,
      status: 503,
      body: {
        error: 'no_model_available',
        message: 'no model can satisfy this request',
        limitation: 'no local chat model is installed',
        route: { explanation: 'all candidates rejected', rejected: [{ id: 'ollama:x', reason: 'not installed' }] },
      },
    }),
  )
  try {
    await assert.rejects(api.chat({ prompt: 'hi' }), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 503)
      assert.equal(error.code, 'no_model_available')
      assert.equal(error.message, 'no model can satisfy this request')
      assert.equal(error.limitation, 'no local chat model is installed')
      assert.equal(error.route.explanation, 'all candidates rejected')
      assert.equal(error.unavailable, true, 'the UI renders this as a capability gap, not a crash')
      return true
    })
  } finally {
    restore()
  }
})

test('a non-JSON error body still produces a usable ApiError', async () => {
  const { restore } = installFetch(() => fakeResponse({ ok: false, status: 502, raw: '<html>bad gateway</html>' }))
  try {
    await assert.rejects(api.health(), (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.code, 'http_error')
      assert.match(error.message, /HTTP 502/)
      return true
    })
  } finally {
    restore()
  }
})

test('an unreachable backend is reported as network_error, not as a server fault', async () => {
  const { restore } = installFetch(() => {
    throw new TypeError('fetch failed')
  })
  try {
    await assert.rejects(api.ready(), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'network_error')
      assert.equal(error.status, 0)
      assert.match(error.message, /cannot reach the core service/)
      assert.equal(error.unavailable, false, 'unreachable is not the same as unavailable')
      return true
    })
  } finally {
    restore()
  }
})

test('an aborted request propagates the AbortError unchanged', async () => {
  const { restore } = installFetch(() => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  })
  try {
    await assert.rejects(api.chat({ prompt: 'hi' }), (error) => {
      assert.equal(error.name, 'AbortError')
      assert.ok(!(error instanceof ApiError), 'a user cancellation must not be dressed up as an API failure')
      return true
    })
  } finally {
    restore()
  }
})

test('unavailable codes are exactly the ones the UI treats as capability gaps', () => {
  const unavailable = ['no_model_available', 'capability_unavailable', 'offline_capability_unavailable', 'needs_hardware', 'not_implemented']
  for (const code of unavailable) {
    assert.equal(new ApiError('x', { code }).unavailable, true, `${code} should read as a capability gap`)
  }
  for (const code of ['network_error', 'http_error', 'invalid_request', 'approval_required', 'plugin_permission_denied', 'unknown_task']) {
    assert.equal(new ApiError('x', { code }).unavailable, false, `${code} is a failure, not a missing capability`)
  }
})

test('POST bodies are JSON-serialised and GET requests send no body', async () => {
  const { calls, restore } = installFetch(() => fakeResponse({ body: {} }))
  try {
    await api.chat({ prompt: 'hi', temperature: 0.5 })
    await api.hardware()
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].body), { prompt: 'hi', temperature: 0.5 })
    assert.equal(calls[0].headers['content-type'], 'application/json')
    assert.equal(calls[1].method, 'GET')
    assert.equal(calls[1].body, null, 'a GET must not carry a body')
    assert.deepEqual(calls[1].headers, {})
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

test('streamChat parses frames split across network chunks', async () => {
  const frames = [
    'event: delta\ndata: {"text":"The "}\n\n',
    'event: delta\ndata: {"text":"coolant "}\n\n',
    'event: redaction\ndata: {"findings":[{"kind":"api_key"}]}\n\n',
    'event: done\ndata: {"text":"The coolant loop is nominal.","modelId":"ollama:tiny:latest","sentExternally":false,"classification":"internal","durationMs":12,"grounding":{"method":"bm25","hasEvidence":false,"evidenceCount":0,"citations":[]}}\n\n',
  ]
  const { restore } = installFetch(() => fakeStream(frames, { chunkEvery: 12 }))
  const seen = []
  try {
    await streamChat({ prompt: 'hi', stream: true }, { onEvent: (event) => seen.push(event) })
    assert.deepEqual(seen.map((event) => event.name), ['delta', 'delta', 'redaction', 'done'])
    assert.equal(seen[0].data.text, 'The ')
    assert.equal(seen[1].data.text, 'coolant ')
    assert.equal(seen[2].data.findings.length, 1, 'a redaction frame is surfaced, not swallowed')
    assert.equal(seen[3].data.modelId, 'ollama:tiny:latest')
    assert.equal(seen[3].data.sentExternally, false)
    assert.equal(seen[3].data.grounding.hasEvidence, false)
  } finally {
    restore()
  }
})

test('streamChat surfaces an in-stream error frame', async () => {
  const frames = [
    'event: delta\ndata: {"text":"partial "}\n\n',
    'event: error\ndata: {"message":"the provider stopped mid-stream","error":"provider_error","status":502}\n\n',
  ]
  const { restore } = installFetch(() => fakeStream(frames, { chunkEvery: 3 }))
  const seen = []
  try {
    await streamChat({ prompt: 'hi' }, { onEvent: (event) => seen.push(event) })
    assert.equal(seen.at(-1).name, 'error')
    assert.equal(seen.at(-1).data.error, 'provider_error')
    assert.equal(seen.at(-1).data.status, 502)
  } finally {
    restore()
  }
})

test('a stream that fails before it starts becomes an ApiError with the server code', async () => {
  const { restore } = installFetch(() =>
    fakeResponse({
      ok: false,
      status: 503,
      body: { error: 'no_model_available', message: 'no model can satisfy this request', limitation: 'nothing installed' },
    }),
  )
  try {
    await assert.rejects(streamChat({ prompt: 'hi' }, { onEvent: () => {} }), (error) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'no_model_available')
      assert.equal(error.limitation, 'nothing installed')
      assert.equal(error.unavailable, true)
      return true
    })
  } finally {
    restore()
  }
})

test('a malformed data payload degrades to raw text instead of throwing', async () => {
  const frames = ['event: delta\ndata: {not json}\n\n', 'event: done\ndata: {}\n\n']
  const { restore } = installFetch(() => fakeStream(frames, { chunkEvery: 2 }))
  const seen = []
  try {
    await streamChat({ prompt: 'hi' }, { onEvent: (event) => seen.push(event) })
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[0].data, { text: '{not json}' })
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// The route contract, pinned against the real server source
// ---------------------------------------------------------------------------

/**
 * Literal routes the client depends on. Each must appear verbatim in the core
 * router; each must also be reachable from services/core's public HTTP surface.
 */
const REQUIRED_ROUTES = [
  '/api/health', '/api/ready', '/api/config', '/api/hardware', '/api/events', '/api/audit',
  '/api/models', '/api/models/probe',
  '/api/chat', '/api/chat/stream', '/api/tasks',
  '/api/image/generate', '/api/image/jobs', '/api/video/generate', '/api/video/jobs',
  '/api/knowledge/ingest', '/api/knowledge/search', '/api/knowledge/reindex', '/api/knowledge/stats', '/api/knowledge/documents',
  '/api/plugins', '/api/plugins/capabilities', '/api/plugins/install', '/api/plugins/validate',
  '/api/mcp/servers', '/api/mcp/tools', '/api/mcp/resources', '/api/mcp/prompts', '/api/mcp/preflight', '/api/mcp/call',
]

test('every route the client calls still exists in the core router', () => {
  const source = readFileSync(APP_MJS, 'utf8')
  const missing = REQUIRED_ROUTES.filter((route) => !source.includes(`'${route}'`))
  assert.deepEqual(missing, [], `the core router no longer mentions: ${missing.join(', ')}`)
})

test('parameterised routes are handled by the core router', () => {
  const source = readFileSync(APP_MJS, 'utf8')
  // These are matched on path segments rather than literals, so assert the segment
  // logic is present instead of a literal string.
  for (const fragment of [
    "segments[1] === 'tasks'",
    "segments[1] === 'plugins'",
    "segments[1] === 'mcp'",
    "segments[1] === 'media' && segments[2] === 'artifact'",
    "segments[4] === 'cancel'",
  ]) {
    assert.ok(source.includes(fragment), `the core router no longer handles ${fragment}`)
  }
})

test('no client path escapes the documented route table', async () => {
  const { calls, restore } = installFetch(() => fakeResponse({ body: { models: [], plugins: [], servers: [], tools: [], resources: [], prompts: [], jobs: [], tasks: [], documents: [], events: [] } }))
  try {
    await Promise.allSettled([
      api.health(), api.ready(), api.config(), api.hardware(), api.events(), api.audit(5),
      api.models(), api.probeModels(), api.chat({ prompt: 'x' }),
      api.tasks(3), api.task('id-1'), api.createTask({ prompt: 'x' }),
      api.pauseTask('id-1'), api.resumeTask('id-1'), api.cancelTask('id-1'), api.approveTask('id-1', {}),
      api.generateImage({ prompt: 'x' }), api.imageJobs(3), api.generateVideo({ prompt: 'x' }), api.videoJobs(3),
      api.mediaJobs(3), api.cancelMediaJob('job-1'),
      api.knowledgeIngest({ title: 't', text: 'x' }), api.knowledgeSearch({ query: 'q' }),
      api.knowledgeReindex(), api.knowledgeStats(), api.knowledgeDocuments(),
      api.plugins(), api.pluginCapabilities(), api.validateManifest({}), api.installPlugin({}),
      api.pluginPreflight('p', 'c'), api.pluginInvoke('p', 'c', {}), api.setPluginState('p', 'disable'),
      api.mcpServers(), api.mcpTools(), api.mcpResources(), api.mcpPrompts(),
      api.mcpPreflight('s', 't'), api.mcpCall('s', 't', {}), api.mcpToggle('s', false),
    ])

    // Normalise: drop query strings, collapse ids to :id. The action-bearing rules
    // run first and name their actions explicitly, so fixed sub-paths such as
    // /api/plugins/capabilities are never mistaken for /api/plugins/:id.
    const RULES = [
      [/^\/api\/tasks\/[^/]+\/(pause|resume|cancel|approve)$/, '/api/tasks/:id/:action'],
      [/^\/api\/tasks\/[^/]+$/, '/api/tasks/:id'],
      [/^\/api\/plugins\/[^/]+\/(enable|disable|uninstall|preflight|invoke)$/, '/api/plugins/:id/:action'],
      [/^\/api\/media\/jobs\/[^/]+\/cancel$/, '/api/media/jobs/:id/cancel'],
      [/^\/api\/mcp\/servers\/[^/]+\/toggle$/, '/api/mcp/servers/:id/toggle'],
    ]
    const normalise = (url) => {
      const path = url.split('?')[0]
      for (const [pattern, replacement] of RULES) if (pattern.test(path)) return replacement
      return path
    }
    const seen = new Set(calls.map((call) => normalise(call.url)))

    const allowed = new Set([
      ...REQUIRED_ROUTES,
      '/api/tasks/:id', '/api/tasks/:id/:action',
      '/api/plugins/:id/:action',
      '/api/media/jobs', '/api/media/jobs/:id/cancel', '/api/media/artifact/:id',
      '/api/mcp/servers/:id/toggle',
    ])
    const unknown = [...seen].filter((path) => !allowed.has(path))
    assert.deepEqual(unknown, [], `the client called routes the server does not document: ${unknown.join(', ')}`)
  } finally {
    restore()
  }
})

test('a truncated SSE body is not success and releases its reader', async () => {
  const response = fakeStream(['event: delta\ndata: {"text":"partial"}\n\n'])
  const { restore } = installFetch(() => response)
  const seen = []
  try {
    await assert.rejects(streamChat({ prompt: 'keep this draft' }, { onEvent: (event) => seen.push(event) }), { code: 'stream_interrupted' })
    assert.equal(seen[0].data.text, 'partial')
    assert.equal(response.body.locked, false)
  } finally { restore() }
})

test('an abandoned SSE consumer cancels the body and releases its reader', async () => {
  let cancelled = 0
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n')) },
    cancel() { cancelled += 1 },
  })
  const { restore } = installFetch(() => ({ ok: true, body }))
  try {
    await assert.rejects(streamChat({ prompt: 'hi' }, { onEvent() { throw new Error('view unmounted') } }), /view unmounted/)
    assert.equal(cancelled, 1)
    assert.equal(body.locked, false)
  } finally { restore() }
})

test('AbortSignal reaches streaming reads; cancellation releases the reader without a done event', async () => {
  const controller = new AbortController()
  let responseBody
  const { calls, restore } = installFetch(({ signal }) => {
    responseBody = new ReadableStream({
      start(stream) {
        signal.addEventListener('abort', () => stream.error(new DOMException('stopped', 'AbortError')), { once: true })
        stream.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'))
      },
    })
    return { ok: true, body: responseBody }
  })
  const seen = []
  try {
    await assert.rejects(streamChat({ prompt: 'hi' }, { signal: controller.signal, onEvent: (event) => { seen.push(event.name); controller.abort() } }), { name: 'AbortError' })
    assert.equal(calls[0].signal, controller.signal)
    assert.deepEqual(seen, ['delta'])
    assert.equal(responseBody.locked, false)
  } finally { restore() }
})

test('ordinary chat and lazy session creation accept the same cancellation signal', async () => {
  const controller = new AbortController()
  const { calls, restore } = installFetch(() => fakeResponse({ body: {} }))
  try {
    await api.startSession(null, { signal: controller.signal })
    await api.chat({ prompt: 'hi' }, { signal: controller.signal })
    assert.ok(calls.every((call) => call.signal === controller.signal))
  } finally { restore() }
})

test('catalog search stays on Core and metadata refresh consent is explicit', async () => {
  const { calls, restore } = installFetch(() => fakeResponse({ body: {} }))
  try {
    await api.modelCatalog('private search & model')
    await api.refreshCatalog('gateway')
    await api.refreshCatalog('gateway', true)
    assert.equal(calls[0].url, '/api/models/catalog?q=private%20search%20%26%20model')
    assert.deepEqual(JSON.parse(calls[1].body), { sourceId: 'gateway', authorizeNetwork: false })
    assert.deepEqual(JSON.parse(calls[2].body), { sourceId: 'gateway', authorizeNetwork: true })
    assert.ok(calls.every((call) => call.url.startsWith('/api/models/catalog')))
  } finally { restore() }
})

// ---------------------------------------------------------------------------
// The active online router serves what the UI calls
// ---------------------------------------------------------------------------

/** Every `.js`/`.jsx` file under src/, so "what the UI calls" is read, not remembered. */
function walkSource(dir = WEB_SRC) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkSource(full))
    else if (/\.(jsx?)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * The static pathname a client definition requests.
 *
 * The definitions are template literals, so this is not a substring: `${id}` becomes a
 * path separator (keeping the static segments on both sides of it), an interpolation that
 * the capture cut short is dropped, the query string goes, and doubled separators
 * collapse. `/api/memory/candidates/${id}/decide` therefore checks the `decide` rule
 * rather than degenerating into `/api/memory`.
 */
function staticPath(raw) {
  return raw
    .replace(/\$\{[^{}]*\}/g, '/')
    .replace(/\$\{[^}]*$/, '')
    .split('?')[0]
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

/** method name -> the /api path it requests, read out of the client's own definitions. */
function clientPaths() {
  const lines = readFileSync(join(WEB_SRC, 'api.js'), 'utf8').split('\n')
  const starts = []
  lines.forEach((line, index) => {
    const match = /^  ([A-Za-z][\w]*):/.exec(line)
    if (match) starts.push({ name: match[1], index })
  })
  const paths = new Map()
  starts.forEach((start, position) => {
    const end = position + 1 < starts.length ? starts[position + 1].index : lines.length
    const block = lines.slice(start.index, end).join('\n')
    // Up to the next quote or backtick: a nested template inside `${}` ends the capture
    // early, which `staticPath` handles rather than the regex trying to parse JavaScript.
    const match = /(['`])(\/api\/[^'`]*)/.exec(block)
    if (match) paths.set(start.name, staticPath(match[2]))
  })
  return paths
}

/**
 * Is this path served by the online router?
 *
 * Literally, or by the segment rules the router actually uses: `/api/memory/search` is
 * not a string anywhere in the router, it is `segments[1] === 'memory'` plus
 * `segments[2] === 'search'`. Asserting only literals reported those as missing, which
 * is a claim about the mechanism rather than about the surface.
 */
function servedByOnlineRouter(path, router) {
  const parts = staticPath(path).split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts.length < 2) return false
  const literal = `/${parts.join('/')}`
  if (!literal.includes('${') && router.includes(`'${literal}'`)) return true
  if (!router.includes(`segments[1] === '${parts[1]}'`)) return false
  return parts.slice(2).filter((part) => part && !part.includes('${'))
    .every((part) => router.includes(`'${part}'`))
}

test('every endpoint the online UI calls is served by the active online router', () => {
  const router = `${readFileSync(ONLINE_APP_MJS, 'utf8')}\n${readFileSync(ONLINE_CONTEXT_MJS, 'utf8')}`
  const paths = clientPaths()

  // Which methods the UI calls is read from the UI. A hand-written list drifts the moment
  // a component starts calling something new, which is exactly when the check matters.
  const used = new Map()
  for (const file of walkSource()) {
    if (file.endsWith('api.js')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/\bapi\.([A-Za-z][\w]*)\s*\(/g)) {
      if (!used.has(match[1])) used.set(match[1], file.replace(WEB_SRC, 'src'))
    }
  }
  assert.ok(used.size >= 30, `expected the UI to call the client, found ${used.size} methods`)

  // Stated rather than hidden, and self-checking below: Jobs.jsx can build an artifact
  // URL, and the online router serves no artifacts -- because it reports no media jobs at
  // all. If media jobs ever become real, the assertion under this list fails first and
  // the entry has to be removed together with the reason.
  const EXCEPTIONS = new Map([
    ['artifactUrl', 'the online product reports no media jobs, so no artifact URL is rendered'],
  ])

  const missing = []
  for (const [method, file] of used) {
    if (EXCEPTIONS.has(method)) continue
    const path = paths.get(method)
    if (!path) { missing.push(`${method} (${file}: no /api path could be read from the client)`); continue }
    if (!servedByOnlineRouter(path, router)) missing.push(`${method} -> ${path} (${file})`)
  }
  assert.deepEqual(missing, [], `the online router does not serve: ${missing.join(', ')}`)

  // The exception is a fact about the router, not an opinion: every media list is empty
  // and there is no artifact route to serve.
  assert.match(router, /'\/api\/image\/jobs','\/api\/video\/jobs','\/api\/media\/jobs'\]\.includes\(path\)\) return sendJson\(res, 200, \{ jobs: \[\] \}\)/,
    'the media job lists must still be empty for the artifactUrl exception to hold')
  // Probing with a real id would pass or fail on the id rather than on the route, so the
  // check names the mechanism an artifact route would have to use.
  assert.ok(!router.includes("segments[2] === 'artifact'") && !router.includes("'/api/media/artifact"),
    'an artifact route now exists: remove the artifactUrl exception and the reason with it')

  // streamChat calls fetch directly rather than going through the client, so it is not in
  // the map above and is pinned on its own.
  assert.match(readFileSync(join(WEB_SRC, 'api.js'), 'utf8'), /fetch\('\/api\/chat\/stream'/)
  assert.ok(router.includes("'/api/chat/stream'"), 'the online router must serve the streaming chat route')
})

test('the sign-in payloads the client sends are the fields the online router reads', async () => {
  const { calls, restore } = installFetch(() => fakeResponse({
    body: { authenticated: true, account: { id: 'a1', email: 'owner@example.test', role: 'owner' }, requested: true, reset: true, changed: true },
  }))
  try {
    await Promise.allSettled([
      api.auth(),
      api.login({ email: 'owner@example.test', password: 'a-long-owner-password' }),
      api.register({ email: 'member@example.test', password: 'a-long-member-password' }),
      api.logout(),
      api.changePassword({ currentPassword: 'a-long-owner-password', newPassword: 'a-brand-new-password' }),
      api.requestPasswordReset('owner@example.test'),
      api.confirmPasswordReset({ email: 'owner@example.test', code: 'a-single-use-code', password: 'a-brand-new-password' }),
    ])

    const router = readFileSync(ONLINE_APP_MJS, 'utf8')
    const byPath = new Map(calls.map((call) => [call.url.split('?')[0], call]))

    // Every path the client produced exists in the router that is actually running.
    for (const path of byPath.keys()) {
      assert.ok(router.includes(`'${path}'`), `the online router does not serve ${path}`)
    }

    // And the body keys are the keys the server reads. A renamed field is a 400 with a
    // message about a missing email, which reads like a user error and is a code defect.
    const bodies = {
      '/api/auth/login': ['email', 'password'],
      '/api/auth/register': ['email', 'password'],
      '/api/auth/password': ['currentPassword', 'newPassword'],
      '/api/auth/password-reset/request': ['email'],
      '/api/auth/password-reset/confirm': ['email', 'code', 'password'],
    }
    for (const [path, fields] of Object.entries(bodies)) {
      const call = byPath.get(path)
      assert.ok(call, `the client never called ${path}`)
      assert.equal(call.method, 'POST', `${path} must be a mutation`)
      assert.deepEqual(Object.keys(JSON.parse(call.body)).sort(), [...fields].sort(), `the ${path} body drifted`)
      for (const field of fields) {
        assert.ok(router.includes(`body.${field}`), `the online router no longer reads body.${field} for ${path}`)
      }
      // Mutations carry the CSRF header the router requires, or they are refused.
      assert.equal(call.headers['x-aetheris-request'], '1', `${path} must send the non-simple header`)
      assert.equal(call.headers['content-type'], 'application/json')
    }

    // The status check is a read: no body, and no credential of any kind in it.
    assert.equal(byPath.get('/api/auth').method, 'GET')
    assert.equal(byPath.get('/api/auth').body, null)
    const sent = calls.map((call) => call.body).filter(Boolean).join(' ')
    assert.doesNotMatch(sent, /"token"|access[-_ ]?token/i, 'the client must not offer the removed token sign-in')
  } finally {
    restore()
  }
})
