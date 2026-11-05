// Klyvaron tiers are model-independent processing profiles. External provider/model choice is separate.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg==', 'base64')

async function chatServer(t, models) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    calls.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization ?? null })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: `Synthetic reply from ${body.model}.` } }] }))
  })
  const base = await listen(server)
  t.after(() => close(server))
  return { base, calls }
}

async function imageServer(t) {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization ?? null, accept: req.headers.accept ?? null })
    res.writeHead(200, { 'content-type': 'image/png', 'finish-reason': 'SUCCESS' })
    res.end(PNG)
  })
  const base = await listen(server)
  t.after(() => close(server))
  return { base, calls }
}

async function fixture(t, trustedOrigins = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-klyvaron-test-'))
  const f = { dir }
  f.app = new OnlineApp({ dataDir: dir, trustedOrigins, timeoutMs: 3000 })
  const server = f.app.server(); f.url = await listen(server)
  f.request = async (method, path, body, opts = {}) => {
    const payload = body ? { localOnly: false, ...body } : body
    const response = await fetch(f.url + path, {
      method,
      headers: { cookie: opts.cookie ?? '', ...(payload ? { 'content-type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-aetheris-request': '1' }) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  f.login = async (email = 'owner@example.test') => {
    let r = await f.request('POST', '/api/auth/register', { email, password: 'a-long-owner-password' })
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', { email, password: 'a-long-owner-password' })
    f.cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.owner = (method, path, body) => f.request(method, path, body, { cookie: f.cookie })
  t.after(async () => { await close(server); f.app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

async function saveConnection(f, id, baseUrl, apiKey = 'synthetic-key') {
  const saved = await f.owner('PUT', `/api/providers/${id}`, { baseUrl, apiKey })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  const tested = await f.owner('POST', `/api/providers/${id}/test`)
  assert.equal(tested.status, 200, JSON.stringify(tested.data))
  return tested.data
}

test('model-independent Klyvaron processor works without a provider and keeps user data account-local', async (t) => {
  const f = await fixture(t)
  await f.login()
  const info = await f.owner('GET', '/api/klyvaron/processor')
  assert.equal(info.status, 200)
  assert.equal(info.data.engine, 'klyvaron-deterministic-v1')
  assert.equal(info.data.modelUsed, false)
  assert.equal(info.data.weightsUsed, false)
  assert.equal(info.data.networkUsed, false)
  assert.deepEqual(Object.keys(info.data.profiles), ['lite', 'pro', 'max'])

  const session = await f.owner('POST', '/api/sessions', { title: 'Local Klyvaron processing' })
  assert.equal(session.status, 201)
  const processed = await f.owner('POST', '/api/klyvaron/process', {
    tier: 'lite', input: 'Klyvaron stores user-selected text locally. Retrieval is deterministic.',
    tasks: ['summarize'], sessionId: session.data.id, principal: 'attacker-controlled',
  })
  assert.equal(processed.status, 200, JSON.stringify(processed.data))
  assert.equal(processed.data.modelUsed, false)
  assert.equal(processed.data.networkUsed, false)
  assert.match(processed.data.text, /Klyvaron stores user-selected text locally/)
  const accountId = f.app.accounts.list()[0].id
  const context = await f.app.contextFor(accountId)
  const savedSession = await context.memory.getSession(session.data.id)
  assert.equal(savedSession.turns.length, 2)
  assert.equal(savedSession.turns[0].role, 'user')
  assert.equal(savedSession.turns[1].role, 'assistant')

  const persisted = await f.owner('POST', '/api/klyvaron/process', {
    tier: 'lite', input: 'The operator explicitly saved this fact.', tasks: ['inspect'],
    saveToKnowledge: true, title: 'Explicit local save',
  })
  assert.equal(persisted.status, 200)
  assert.equal(persisted.data.persistence.requested, true)
  assert.equal(context.knowledge.stats().store.documents, 1)
})

test('Klyvaron overview exposes resource profiles without assigning provider models', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('GET', '/api/klyvaron')).status, 401)
  await f.login()
  const view = await f.owner('GET', '/api/klyvaron')
  assert.equal(view.status, 200)
  assert.equal(view.data.product, 'klyvaron')
  assert.equal(view.data.modelIndependentProcessor.weightsRequired, false)
  assert.match(view.data.note, /model-independent processing profiles/)
  assert.match(view.data.note, /External provider\/model selection is separate and is not tier-bound/)
  assert.deepEqual(view.data.modelIndependentProcessor.profiles && Object.keys(view.data.modelIndependentProcessor.profiles), ['lite', 'pro', 'max'])
  assert.deepEqual(view.data.tiers.map((tier) => tier.id), ['lite', 'pro', 'max'])
  assert.ok(view.data.tiers.every((tier) => !Object.hasOwn(tier, 'presets')))
  const retired = await f.owner('GET', '/api/klyvaron/models')
  assert.equal(retired.status, 410)
  assert.equal(retired.data.error, 'model_independent_architecture')
})

test('legacy tier-to-provider mapping routes return Gone for every method', async (t) => {
  const f = await fixture(t)
  await f.login()
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await f.owner(method, '/api/klyvaron/lite', method === 'PUT' ? { modality: 'chat', connectionId: 'openai', model: 'gpt-test' } : undefined)
    assert.equal(response.status, 410, `${method} must not create or expose a tier-specific external model`)
    assert.equal(response.data.error, 'model_independent_tier')
  }
})

test('external Chat model selection stays direct; a Klyvaron tier cannot reroute it', async (t) => {
  const provider = await chatServer(t, ['model-a'])
  const f = await fixture(t, [provider.base])
  await f.login()
  await saveConnection(f, 'openai', `${provider.base}/v1`)
  const revision = f.app.store.state.revision

  const rejected = await f.owner('POST', '/api/chat', {
    prompt: 'tiered question', tier: 'lite',
    authorization: { confirmed: true, providerRevision: revision },
  })
  assert.equal(rejected.status, 410)
  assert.equal(rejected.data.error, 'model_independent_tier')
  assert.equal(provider.calls.filter((call) => call.path.endsWith('/chat/completions')).length, 0)

  const reply = await f.owner('POST', '/api/chat', {
    prompt: 'direct provider question', model: 'model-a',
    authorization: { confirmed: true, providerRevision: revision },
  })
  assert.equal(reply.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.modelId, 'model-a')
  assert.equal(reply.data.klyvaron, null)
  assert.equal(provider.calls.filter((call) => call.path.endsWith('/chat/completions')).length, 1)
})

test('external image provider selection is direct and cannot be overridden by a Klyvaron tier', async (t) => {
  const img = await imageServer(t)
  const f = await fixture(t, [img.base])
  await f.login()
  const provider = await saveConnection(f, 'stability', img.base, 'synthetic-stability-key')
  assert.ok(provider.connections.find((connection) => connection.id === 'stability').models.includes('core'))

  const rejected = await f.owner('POST', '/api/image/generate', { prompt: 'a small red square', tier: 'pro' })
  assert.equal(rejected.status, 410)
  assert.equal(rejected.data.error, 'model_independent_tier')
  assert.equal(img.calls.length, 0, 'tier rejection must happen before any image provider request')

  const queued = await f.owner('POST', '/api/image/generate', { prompt: 'a small red square', size: '1024x1024', model: 'core' })
  assert.equal(queued.status, 202, JSON.stringify(queued.data))
  assert.equal(queued.data.params.tier, null)
  assert.equal(queued.data.params.provider, 'stability')
  assert.equal(queued.data.params.model, 'core')
  let job
  for (let attempt = 0; attempt < 50; attempt++) {
    job = await f.owner('GET', `/api/image/jobs/${queued.data.id}`)
    if (job.data.state === 'succeeded' || job.data.state === 'failed') break
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.equal(job.data.state, 'succeeded', JSON.stringify(job.data))
  assert.equal(job.data.result.model, 'core')
  assert.equal(img.calls.at(-1).authorization, 'Bearer synthetic-stability-key')
  assert.equal(img.calls.at(-1).accept, 'image/*')
})

test('external video provider selection also refuses a Klyvaron tier argument', async (t) => {
  const f = await fixture(t)
  await f.login()
  const rejected = await f.owner('POST', '/api/video/generate', { prompt: 'a short clip', tier: 'max' })
  assert.equal(rejected.status, 410)
  assert.equal(rejected.data.error, 'model_independent_tier')
})
