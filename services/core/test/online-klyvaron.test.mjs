// Klyvaron product tiers are pointers, not models.
//
// Every assertion here is about provenance: a tier resolves to a saved connection and a model
// that connection already listed, the request goes to that connection (not merely the active
// one), and the answer names the third-party provider in machine-readable fields. No Klyvaron
// weights exist in this build, and nothing here may imply otherwise.

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

async function fixture(t, trustedOrigins) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-klyvaron-test-'))
  const f = { dir }
  f.app = new OnlineApp({ dataDir: dir, trustedOrigins, timeoutMs: 3000 })
  const server = f.app.server(); f.url = await listen(server)
  f.request = async (method, path, body, opts = {}) => {
    const response = await fetch(f.url + path, {
      method,
      // The same-origin marker is required on every mutating request, body or not.
      headers: { cookie: opts.cookie ?? '', ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-aetheris-request': '1' }) },
      ...(body ? { body: JSON.stringify(body) } : {}),
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

test('Klyvaron tiers are unconfigured until the owner assigns a saved connection', async (t) => {
  const a = await chatServer(t, ['model-a'])
  const f = await fixture(t, [a.base])
  assert.equal((await f.request('GET', '/api/klyvaron')).status, 401)
  await f.login()
  const view = await f.owner('GET', '/api/klyvaron')
  assert.equal(view.status, 200)
  assert.equal(view.data.product, 'klyvaron')
  assert.equal(view.data.independentWeights, false)
  assert.match(view.data.note, /product tiers, not first-party model weights/)
  assert.deepEqual(view.data.tiers.map((tier) => tier.id), ['lite', 'pro', 'max'])
  for (const tier of view.data.tiers) {
    assert.equal(tier.presets.chat.configured, false)
    assert.equal(tier.presets.image.provenance, null)
  }
  // Selecting an unconfigured tier refuses by name; it does not fall back to the active model.
  await saveConnection(f, 'litellm', `${a.base}/v1`, 'synthetic-key')
  const refused = await f.owner('POST', '/api/chat', { prompt: 'hello', tier: 'lite', authorization: { confirmed: true, providerRevision: f.app.store.state.revision } })
  assert.equal(refused.status, 409)
  assert.equal(refused.data.error, 'klyvaron_tier_unconfigured')
})

test('a preset must name a listed model and the right modality', async (t) => {
  const a = await chatServer(t, ['model-a'])
  const f = await fixture(t, [a.base])
  await f.login()
  await saveConnection(f, 'litellm', `${a.base}/v1`)

  const unlisted = await f.owner('PUT', '/api/klyvaron/lite', { modality: 'chat', connectionId: 'litellm', model: 'invented-model' })
  assert.equal(unlisted.status, 409)
  assert.equal(unlisted.data.error, 'model_unlisted')

  // A chat connection cannot back an image tier: the adapter says which modality it serves.
  const wrongModality = await f.owner('PUT', '/api/klyvaron/pro', { modality: 'image', connectionId: 'litellm', model: 'model-a' })
  assert.equal(wrongModality.status, 409)
  assert.equal(wrongModality.data.error, 'klyvaron_tier_modality')

  // An id no catalogue entry or saved record names is refused before anything is stored.
  const unknownConnection = await f.owner('PUT', '/api/klyvaron/lite', { modality: 'chat', connectionId: 'nope', model: 'model-a' })
  assert.equal(unknownConnection.status, 400)
  assert.equal(unknownConnection.data.error, 'invalid_runtime')

  // A member cannot re-point a shared product tier.
  const member = await f.request('POST', '/api/auth/register', { email: 'member@example.test', password: 'another-long-password' })
  const memberCookie = member.headers.get('set-cookie').split(';')[0]
  const denied = await f.request('PUT', '/api/klyvaron/lite', { modality: 'chat', connectionId: 'litellm', model: 'model-a' }, { cookie: memberCookie })
  assert.equal(denied.status, 403)
  assert.equal(denied.data.error, 'owner_required')
})

test('a chat tier routes to its own connection and reports third-party provenance', async (t) => {
  const a = await chatServer(t, ['model-a'])
  const b = await chatServer(t, ['model-b'])
  const f = await fixture(t, [a.base, b.base])
  await f.login()
  await saveConnection(f, 'litellm', `${a.base}/v1`)
  await saveConnection(f, 'openai', `${b.base}/v1`) // active, and a different destination

  const saved = await f.owner('PUT', '/api/klyvaron/lite', { modality: 'chat', connectionId: 'litellm', model: 'model-a' })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  const preset = saved.data.tiers.find((tier) => tier.id === 'lite').presets.chat
  assert.equal(preset.configured, true)
  assert.equal(preset.provider, 'LiteLLM')
  assert.equal(preset.model, 'model-a')
  assert.equal(preset.provenance.kind, 'third_party_api')
  assert.equal(preset.provenance.training, 'none_by_this_project')
  assert.equal(preset.provenance.firstPartyWeights, false)
  assert.match(preset.provenance.statement, /Served by LiteLLM .*model-a/)

  const revision = f.app.store.state.revision
  const reply = await f.owner('POST', '/api/chat', { prompt: 'tiered question', tier: 'lite', authorization: { confirmed: true, providerRevision: revision, providerId: 'litellm' } })
  assert.equal(reply.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.modelId, 'model-a')
  assert.equal(reply.data.klyvaron.tier, 'lite')
  assert.equal(reply.data.klyvaron.provenance.providerId, 'litellm')
  assert.equal(reply.data.klyvaron.provenance.model, 'model-a')
  // The preset, not the active connection, received the request.
  assert.equal(a.calls.filter((call) => call.path.endsWith('/chat/completions')).length, 1)
  assert.equal(b.calls.filter((call) => call.path.endsWith('/chat/completions')).length, 0)

  // Consent for a different provider than the tier uses is refused, not silently redirected.
  const mismatch = await f.owner('POST', '/api/chat', { prompt: 'tiered question', tier: 'lite', authorization: { confirmed: true, providerRevision: revision, providerId: 'openai' } })
  assert.equal(mismatch.status, 409)
  assert.equal(mismatch.data.error, 'consent_provider_mismatch')

  // Without a tier, the active connection is still the destination.
  const plain = await f.owner('POST', '/api/chat', { prompt: 'plain question', model: 'model-b', authorization: { confirmed: true, providerRevision: revision } })
  assert.equal(plain.status, 200, JSON.stringify(plain.data))
  assert.equal(plain.data.modelId, 'model-b')
  assert.equal(plain.data.klyvaron, null)
})

test('an image tier queues its own provider and model, and reports provenance on the job', async (t) => {
  const a = await chatServer(t, ['model-a'])
  const img = await imageServer(t)
  const f = await fixture(t, [a.base, img.base])
  await f.login()
  await saveConnection(f, 'litellm', `${a.base}/v1`)
  const stability = await saveConnection(f, 'stability', img.base, 'synthetic-stability-key')
  assert.ok(stability.connections.find((connection) => connection.id === 'stability').models.includes('core'))

  const chatPreset = await f.owner('PUT', '/api/klyvaron/lite', { modality: 'chat', connectionId: 'litellm', model: 'model-a' })
  assert.equal(chatPreset.status, 200)
  const preset = await f.owner('PUT', '/api/klyvaron/pro', { modality: 'image', connectionId: 'stability', model: 'core' })
  assert.equal(preset.status, 200, JSON.stringify(preset.data))
  const imagePreset = preset.data.tiers.find((tier) => tier.id === 'pro').presets.image
  assert.equal(imagePreset.provider, 'Stability AI')
  assert.equal(imagePreset.provenance.training, 'none_by_this_project')

  const queued = await f.owner('POST', '/api/image/generate', { prompt: 'a small red square', size: '1024x1024', tier: 'pro' })
  assert.equal(queued.status, 202, JSON.stringify(queued.data))
  assert.equal(queued.data.params.tier, 'pro')
  assert.equal(queued.data.params.provider, 'stability')
  assert.equal(queued.data.params.provenance.provider, 'Stability AI')
  assert.equal(queued.data.params.provenance.model, 'core')

  let job
  for (let attempt = 0; attempt < 50; attempt++) {
    job = await f.owner('GET', `/api/image/jobs/${queued.data.id}`)
    if (job.data.state === 'succeeded' || job.data.state === 'failed') break
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.equal(job.data.state, 'succeeded', JSON.stringify(job.data))
  // Provenance travels on the job's own parameters, not inferred from the active connection.
  assert.equal(job.data.params.provenance.provider, 'Stability AI')
  assert.equal(job.data.params.provenance.model, 'core')
  assert.equal(job.data.params.provenance.training, 'none_by_this_project')
  assert.equal(job.data.result.model, 'core')
  // The key went to the configured API origin, and the adapter asked for an image representation.
  assert.equal(img.calls.length, 1)
  assert.equal(img.calls[0].authorization, 'Bearer synthetic-stability-key')
  assert.equal(img.calls[0].accept, 'image/*')
})

test('presets survive a restart and can be cleared without touching the connection', async (t) => {
  const a = await chatServer(t, ['model-a'])
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-klyvaron-restart-'))
  const options = (app) => ({ app, dir })
  let app = new OnlineApp({ dataDir: dir, trustedOrigins: [a.base], timeoutMs: 3000 })
  let server = app.server(); let url = await listen(server)
  const call = async (method, path, body, cookie = '') => {
    const response = await fetch(url + path, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'GET' ? {} : { 'x-aetheris-request': '1' }) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  t.after(async () => { await close(server); app.close(); rmSync(dir, { recursive: true, force: true }) })

  let registered = await call('POST', '/api/auth/register', { email: 'owner@example.test', password: 'a-long-owner-password' })
  let cookie = registered.headers.get('set-cookie').split(';')[0]
  let saved = await call('PUT', '/api/providers/litellm', { baseUrl: `${a.base}/v1`, apiKey: 'synthetic-key' }, cookie)
  assert.equal(saved.status, 200)
  let tested = await call('POST', '/api/providers/litellm/test', null, cookie)
  assert.equal(tested.status, 200)
  let preset = await call('PUT', '/api/klyvaron/max', { modality: 'chat', connectionId: 'litellm', model: 'model-a' }, cookie)
  assert.equal(preset.status, 200)

  await close(server); app.close()
  app = new OnlineApp({ dataDir: dir, trustedOrigins: [a.base], timeoutMs: 3000 })
  server = app.server(); url = await listen(server)
  const logged = await call('POST', '/api/auth/login', { email: 'owner@example.test', password: 'a-long-owner-password' })
  cookie = logged.headers.get('set-cookie').split(';')[0]
  const view = await call('GET', '/api/klyvaron', null, cookie)
  assert.equal(view.status, 200)
  assert.equal(view.data.tiers.find((tier) => tier.id === 'max').presets.chat.model, 'model-a')

  const removed = await call('DELETE', '/api/klyvaron/max/chat', null, cookie)
  assert.equal(removed.status, 200)
  assert.equal(removed.data.tiers.find((tier) => tier.id === 'max').presets.chat.configured, false)
  // Clearing the preset leaves the connection and its model list intact.
  const provider = await call('GET', '/api/providers', null, cookie)
  assert.equal(provider.data.connections.find((connection) => connection.id === 'litellm').configured, true)
  assert.ok(options(app).dir)
})
