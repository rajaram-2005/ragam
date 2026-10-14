import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelCatalog, normalizeRecord, CATALOG_SCHEMA } from '../src/catalog/registry.mjs'
import { httpCatalogSource, configuredCatalogSources } from '../src/catalog/sources.mjs'
import { createEgressGuard } from '../src/policy/egress.mjs'
import { AetherisOmniApp, createHttpServer } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'

const source = (load, extra = {}) => ({ id: 'test', kind: 'test/1', load, ...extra })
const snapshot = (records) => ({ records, coverage: 'complete_response' })
async function server(t, handler) {
  const instance = createServer(handler)
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)) })
  return `http://127.0.0.1:${instance.address().port}`
}
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
function dir(t) {
  const path = mkdtempSync(join(tmpdir(), 'aetheris-catalog-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
async function appServer(t, env = {}) {
  const app = new AetherisOmniApp({ config: loadConfig({ AETHERIS_DATA_DIR: dir(t), OLLAMA_ENABLED: 'false', LLAMACPP_ENABLED: 'false', ...env }) })
  const instance = createHttpServer(app)
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => { instance.closeAllConnections(); await new Promise((resolve) => instance.close(resolve)); await app.close() })
  const url = `http://127.0.0.1:${instance.address().port}`
  const post = (body) => fetch(url + '/api/models/catalog/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { app, url, post }
}

test('catalog normalization preserves unknowns, ignores readiness claims and requires licence review', () => {
  const record = normalizeRecord({ id: 'publisher/model', capabilities: ['video'], inferenceReadiness: 'ready', licence: 'MIT', toolCalling: false }, 'test')
  assert.equal(record.schema, CATALOG_SCHEMA)
  assert.equal(record.inferenceReadiness, 'unverified')
  assert.equal(record.installation, 'unknown')
  assert.equal(record.licence.review, 'not_reviewed')
  assert.equal(record.licence.restrictions, null)
  assert.equal(record.toolCalling, false)
  assert.equal(record.structuredOutput, null)
  assert.equal(record.hardwareRequirements, null)
  assert.equal(record.pricing, null)
  assert.deepEqual(record.tasks, [])
  assert.equal(record.lastVerifiedAt, null)
})

test('identity includes source and revision; returned data cannot mutate the catalog', async () => {
  const catalog = new ModelCatalog()
  catalog.addSource(source(async () => snapshot([{ id: 'same', revision: 'a' }, { id: 'same', revision: 'b' }])))
  catalog.addSource(source(async () => snapshot([{ id: 'same', revision: 'a' }]), { id: 'other' }))
  await catalog.refresh('test'); await catalog.refresh('other')
  const result = catalog.search()
  assert.equal(new Set(result.records.map((r) => r.key)).size, 3)
  result.records[0].licence.review = 'approved'
  assert.ok(catalog.search().records.every((r) => r.licence.review === 'not_reviewed'))
})

test('failed refresh is atomic, retains last-good records and marks them stale', async () => {
  let records = [{ id: 'good' }]
  const catalog = new ModelCatalog()
  catalog.addSource(source(async () => snapshot(records)))
  await catalog.refresh('test')
  const digest = catalog.sources()[0].snapshotSha256
  records = [{ id: 'new' }, { id: '' }]
  await assert.rejects(catalog.refresh('test'), { code: 'invalid_catalog' })
  assert.equal(catalog.search().records[0].id, 'good')
  assert.equal(catalog.search().records[0].stale, true)
  assert.equal(catalog.sources()[0].snapshotSha256, digest)
})

test('TTL expiry, successful replacement and empty snapshots are explicit', async () => {
  let time = 0, records = [{ id: 'old' }]
  const catalog = new ModelCatalog({ now: () => time })
  catalog.addSource(source(async () => snapshot(records), { ttlMs: 1000 }))
  await catalog.refresh('test')
  assert.equal(catalog.sources()[0].stale, false)
  time = 1000
  assert.equal(catalog.sources()[0].stale, true)
  records = []
  await catalog.refresh('test')
  assert.equal(catalog.search().total, 0)
  assert.equal(catalog.sources()[0].stale, false)
  assert.equal(catalog.sources()[0].coverage, 'complete_response')
})

test('search is local, paginated and filtered by declared task and source', async () => {
  const catalog = new ModelCatalog()
  let calls = 0
  catalog.addSource(source(async () => { calls += 1; return snapshot([{ id: 'Publisher/One', tasks: ['text-generation'] }, { id: 'Publisher/Two', tasks: ['image-to-text'] }]) }))
  await catalog.refresh('test')
  assert.equal(catalog.search({ q: 'publisher', task: 'image-to-text', sourceId: 'test' }).records[0].id, 'Publisher/Two')
  assert.equal(catalog.search({ limit: 1, offset: 1 }).records.length, 1)
  assert.equal(calls, 1)
  for (const query of [{ limit: 101 }, { offset: -1 }, { limit: NaN }, { q: 'x'.repeat(257) }]) assert.throws(() => catalog.search(query), { code: 'invalid_query' })
})

test('invalid strings, unsafe links, duplicate revisions and oversized lists are refused', async () => {
  for (const bad of [{ id: 'x', modelCard: 'javascript:alert(1)' }, { id: 'x', modelCard: 'https://u:p@x.test/card' }, { id: 'x', artifactBytes: -1 }, { id: 'x', tasks: [null] }]) assert.throws(() => normalizeRecord(bad, 'test'))
  for (const records of [[{ id: 'x' }, { id: 'x' }], Array.from({ length: 501 }, (_, i) => ({ id: `${i}` }))]) {
    const catalog = new ModelCatalog(); catalog.addSource(source(async () => snapshot(records)))
    await assert.rejects(catalog.refresh('test'), { code: 'invalid_catalog' })
    assert.equal(catalog.search().total, 0)
  }
})

test('source registration never fetches; external refresh requires explicit boolean authorization', async () => {
  let calls = 0
  const catalog = new ModelCatalog()
  catalog.addSource(source(async () => { calls += 1; return snapshot([]) }, { network: 'external' }))
  catalog.search()
  assert.equal(calls, 0)
  for (const authorizeNetwork of [undefined, false, 'true']) await assert.rejects(catalog.refresh('test', { authorizeNetwork }), { code: 'catalog_consent_required' })
  assert.equal(calls, 0)
  assert.equal((await catalog.refresh('test', { authorizeNetwork: true })).refreshing, false)
  assert.equal(calls, 1)
})

test('Strict Offline blocks external catalog sources including loopback gateways before fetch', async () => {
  let calls = 0
  const guard = createEgressGuard({ policy: 'strict_offline', fetch: async () => { calls += 1; return new Response('{}') } })
  for (const kind of ['litellm', 'huggingface', 'openai-compatible']) {
    const catalog = new ModelCatalog()
    catalog.addSource(httpCatalogSource({ id: 'test', kind, baseUrl: 'http://127.0.0.1:9999/v1' }, guard))
    await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }), { code: 'EGRESS_BLOCKED' })
  }
  assert.equal(calls, 0)
})

test('Hugging Face adapter reads advertised metadata without inferring chat, price or hardware', async (t) => {
  const requests = []
  const url = await server(t, (req, res) => {
    requests.push(req.url)
    res.setHeader('link', '<https://untrusted.invalid/next>; rel="next"')
    json(res, [{ id: 'org/model', sha: 'exact-revision', pipeline_tag: 'text-generation', cardData: { license: 'apache-2.0', base_model: 'org/base' } }])
  })
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'hf', kind: 'huggingface', baseUrl: url }, createEgressGuard({ policy: 'hybrid' })))
  await catalog.refresh('hf', { authorizeNetwork: true })
  const record = catalog.search().records[0]
  assert.equal(record.revision, 'exact-revision')
  assert.equal(record.licence.id, 'apache-2.0')
  assert.deepEqual(record.baseModels, ['org/base'])
  assert.deepEqual(record.tasks, ['text-generation'])
  assert.equal(record.toolCalling, null)
  assert.equal(record.pricing, null)
  assert.equal(record.hardwareRequirements, null)
  assert.equal(catalog.sources()[0].coverage, 'bounded_page')
  assert.deepEqual(requests, ['/api/models?limit=100&full=true&cardData=true'])
})

test('LiteLLM listing uses only GET /models with server-side credentials and unknown capabilities', async (t) => {
  const requests = []
  const url = await server(t, (req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization })
    json(res, { object: 'list', data: [{ id: 'configured-alias', owned_by: 'publisher', tool_calling: true }] })
  })
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'gateway', kind: 'litellm', baseUrl: url + '/v1', token: 'test-only-credential' }, createEgressGuard({ policy: 'hybrid' })))
  await catalog.refresh('gateway', { authorizeNetwork: true })
  assert.deepEqual(requests, [{ method: 'GET', path: '/v1/models', authorization: 'Bearer test-only-credential' }])
  assert.equal(catalog.search().records[0].toolCalling, null)
  assert.doesNotMatch(JSON.stringify(catalog.search()), /test-only-credential/)
})

test('Ollama listing preserves cloud provenance but does not assert inference readiness', async (t) => {
  const url = await server(t, (_req, res) => json(res, { models: [{ name: 'cloud', remote_host: 'https://remote.invalid', size: 0 }, { name: 'disk', size: 42, details: { quantization_level: 'Q4_K_M' } }] }))
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'ollama', kind: 'ollama', baseUrl: url }, createEgressGuard()))
  await catalog.refresh('ollama')
  assert.equal(catalog.search({ q: 'cloud' }).records[0].executionLocation, 'online')
  assert.equal(catalog.search({ q: 'disk' }).records[0].executionLocation, null)
  assert.ok(catalog.search().records.every((record) => record.inferenceReadiness === 'unverified'))
})

test('body and record limits apply before adapter record expansion', async () => {
  for (const headers of [{ 'content-length': `${3 * 1024 * 1024}` }, {}]) {
    const guard = createEgressGuard({ policy: 'hybrid', onlineAllowlist: ['catalog.test'], fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers }) })
    const catalog = new ModelCatalog()
    catalog.addSource(httpCatalogSource({ id: 'test', kind: 'litellm', baseUrl: 'https://catalog.test/v1' }, guard))
    await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }), { code: 'catalog_too_large' })
  }
  const guard = createEgressGuard({ policy: 'hybrid', onlineAllowlist: ['catalog.test'], fetch: async () => Response.json({ data: Array.from({ length: 501 }, (_, i) => ({ id: String(i) })) }) })
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'test', kind: 'litellm', baseUrl: 'https://catalog.test/v1' }, guard))
  await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }), { code: 'invalid_catalog' })
})

test('deadline covers response-body reads, not just response headers', async (t) => {
  const url = await server(t, (_req, res) => { res.writeHead(200); res.write('{"data":[') })
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'test', kind: 'litellm', baseUrl: url, timeoutMs: 50 }, createEgressGuard({ policy: 'hybrid' })))
  await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }), { code: 'timeout', status: 504 })
  assert.equal(catalog.sources()[0].refreshing, false)
})

test('busy refresh is bounded, caller abort and catalog close reject without publishing', async () => {
  const catalog = new ModelCatalog()
  let started
  const begun = new Promise((resolve) => { started = resolve })
  catalog.addSource(source(({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))); started() })))
  const controller = new AbortController()
  const failed = assert.rejects(catalog.refresh('test', { signal: controller.signal }), { code: 'cancelled' })
  await begun
  await assert.rejects(catalog.refresh('test'), { code: 'catalog_busy' })
  controller.abort(); await failed
  const closed = assert.rejects(catalog.refresh('test'), { code: 'cancelled' })
  catalog.close()
  await closed
  await assert.rejects(catalog.refresh('test'), { code: 'catalog_closed' })
  assert.equal(catalog.search().total, 0)
})

test('provider errors and credential echoes cannot leak into public metadata or telemetry', async () => {
  for (const echo of [false, true]) {
    const events = []
    const guard = createEgressGuard({ policy: 'hybrid', onlineAllowlist: ['catalog.test'], fetch: async () => {
      if (!echo) throw new Error('unsafe-error test-only-secret')
      return Response.json({ data: [{ id: 'test-only-secret' }] })
    } })
    const catalog = new ModelCatalog({ onEvent: (event) => events.push(event) })
    catalog.addSource(httpCatalogSource({ id: 'test', kind: 'litellm', baseUrl: 'https://catalog.test/v1', token: 'test-only-secret' }, guard))
    await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }), (error) => !error.message.includes('test-only-secret'))
    assert.doesNotMatch(JSON.stringify([catalog.search(), events]), /test-only-secret|unsafe-error/)
  }
})

test('redirects are refused and no linked page can receive a credential', async (t) => {
  let forwarded = 0
  const other = await server(t, (_req, res) => { forwarded += 1; json(res, { data: [] }) })
  const url = await server(t, (_req, res) => { res.writeHead(302, { location: other }); res.end() })
  const catalog = new ModelCatalog()
  catalog.addSource(httpCatalogSource({ id: 'test', kind: 'litellm', baseUrl: url, token: 'test-only-secret' }, createEgressGuard({ policy: 'hybrid' })))
  await assert.rejects(catalog.refresh('test', { authorizeNetwork: true }))
  assert.equal(forwarded, 0)
})

test('operator config is versioned, bounded and keeps credentials in server-side files', (t) => {
  const root = dir(t), file = join(root, 'sources.json')
  writeFileSync(join(root, 'token'), 'test-only-secret\n')
  writeFileSync(file, JSON.stringify({ schema: 'aetheris.catalog-sources/1', sources: [{ id: 'gw', kind: 'litellm', baseUrl: 'https://catalog.test/v1', tokenFile: 'token' }] }))
  const sources = configuredCatalogSources(file, createEgressGuard())
  assert.equal(sources.length, 1)
  assert.doesNotMatch(JSON.stringify(sources), /test-only-secret/)
  for (const baseUrl of ['http://remote.test', 'https://u:p@remote.test', 'https://remote.test?token=secret', 'file:///tmp/catalog']) assert.throws(() => httpCatalogSource({ id: 'bad', kind: 'litellm', baseUrl }, createEgressGuard()))
  writeFileSync(file, JSON.stringify({ schema: 'wrong', sources: [] }))
  assert.throws(() => configuredCatalogSources(file, createEgressGuard()), { code: 'invalid_source' })
  writeFileSync(file, 'x'.repeat(65537))
  assert.throws(() => configuredCatalogSources(file, createEgressGuard()), { code: 'invalid_source' })
})

test('real catalog API is searchable without registering models or contacting sources at startup', async (t) => {
  let calls = 0
  const upstream = await server(t, (_req, res) => { calls += 1; json(res, { data: [{ id: 'not-an-inference-proof' }] }) })
  const root = dir(t), file = join(root, 'sources.json')
  writeFileSync(file, JSON.stringify({ schema: 'aetheris.catalog-sources/1', sources: [{ id: 'gateway', kind: 'litellm', baseUrl: upstream + '/v1' }] }))
  const { app, url, post } = await appServer(t, { AETHERIS_RUNTIME_POLICY: 'hybrid', AETHERIS_MODEL_CATALOG_FILE: file })
  const before = app.registry.list()
  const initial = await (await fetch(url + '/api/models/catalog')).json()
  assert.equal(initial.sources.find((s) => s.id === 'gateway').fetchedAt, null)
  assert.equal(calls, 0)
  assert.equal((await post({ sourceId: 'gateway' })).status, 403)
  const refreshed = await post({ sourceId: 'gateway', authorizeNetwork: true })
  assert.equal(refreshed.status, 200)
  const result = await (await fetch(url + '/api/models/catalog?q=proof')).json()
  assert.equal(result.records[0].id, 'not-an-inference-proof')
  assert.deepEqual(app.registry.list(), before)
  assert.equal((await post({ sourceId: 'attacker', baseUrl: upstream })).status, 404)
  assert.equal(calls, 1)
})

test('real Strict Offline catalog API does not contact a configured gateway even with consent', async (t) => {
  let calls = 0
  const upstream = await server(t, (_req, res) => { calls += 1; json(res, { data: [] }) })
  const file = join(dir(t), 'sources.json')
  writeFileSync(file, JSON.stringify({ schema: 'aetheris.catalog-sources/1', sources: [{ id: 'gateway', kind: 'litellm', baseUrl: upstream }] }))
  const { post } = await appServer(t, { AETHERIS_MODEL_CATALOG_FILE: file })
  const response = await post({ sourceId: 'gateway', authorizeNetwork: true })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'EGRESS_BLOCKED')
  assert.equal(calls, 0)
})

test('Ollama cloud entries are excluded from local routing and stale discovered entries are removed', async (t) => {
  let models = [{ name: 'local' }, { name: 'cloud', remote_model: 'cloud' }]
  const upstream = await server(t, (_req, res) => json(res, { models }))
  const { app } = await appServer(t, { OLLAMA_ENABLED: 'true', OLLAMA_BASE_URL: upstream })
  await app.probeAll()
  assert.ok(app.registry.get('ollama:local'))
  assert.throws(() => app.registry.get('ollama:cloud'), /unknown model/)
  models = [{ name: 'local', remote_host: 'https://remote.invalid' }, { name: 'other' }]
  await app.probeAll()
  assert.throws(() => app.registry.get('ollama:local'), /unknown model/)
  assert.ok(app.registry.get('ollama:other'))
})
