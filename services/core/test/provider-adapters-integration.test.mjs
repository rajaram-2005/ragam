// End-to-end integration through authenticated Chat/provider routes and the real shared gateway.
// The in-process HTTP peer is a deterministic contract fixture, never a live vendor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { OnlineGateway } from '../src/online/gateway.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

async function appFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-provider-adapter-integration-'))
  const calls = []
  const peer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    const body = text ? JSON.parse(text) : null
    calls.push({ path: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET' && req.url.startsWith('/v1/accounts/')) return res.end(JSON.stringify({ models: [{ name: 'accounts/acct_test/models/fixture-a', displayName: 'Fixture Chat A' }] }))
    if (req.method === 'GET' && req.url === '/v1/language-models') return res.end(JSON.stringify({ models: [{ id: 'grok-fixture', input_modalities: ['text'], output_modalities: ['text'], context_length: 128000 }] }))
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'fixture/model-a' }, { id: 'fixture/model-b' }] }))
    if (req.url === '/v1/responses' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'xAI stream fixture.' })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { model: body.model, usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`)
      return res.end()
    }
    if (req.url === '/v1/responses') return res.end(JSON.stringify({ model: body.model, output_text: 'xAI Responses fixture only.', usage: { input_tokens: 2, output_tokens: 3 } }))
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Fixture-only answer.' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }))
  })
  const peerUrl = await listen(peer)
  const app = new OnlineApp({ dataDir: dir, trustedOrigins: [peerUrl], timeoutMs: 2000 })
  const server = app.server(), url = await listen(server)
  const request = async (method, path, body, currentCookie = null) => {
    const response = await fetch(url + path, { method, headers: { ...(currentCookie ? { cookie: currentCookie } : {}), ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const raw = await response.text(); let data
    try { data = JSON.parse(raw) } catch { data = raw }
    return { status: response.status, data, headers: response.headers }
  }
  const account = { email: 'adapter-owner@example.test', password: 'a-long-integration-password' }
  const auth = await request('POST', '/api/auth/register', account)
  assert.equal(auth.status, 201, JSON.stringify(auth.data))
  const sessionCookie = auth.headers.get('set-cookie').split(';')[0]
  const chat = (model, revision) => ({ prompt: 'Say hello.', model, authorization: { confirmed: true, providerRevision: revision } })
  t.after(async () => { await close(server); await close(peer); app.close(); rmSync(dir, { recursive: true, force: true }) })
  return { app, calls, dir, peerUrl, request: (method, path, body) => request(method, path, body, sessionCookie), chat }
}

test('OpenRouter adapter traverses owner-protected settings, model discovery and Chat without fallback', async (t) => {
  const f = await appFixture(t)
  const saved = await f.request('PUT', '/api/providers/openrouter', { baseUrl: `${f.peerUrl}/api/v1`, apiKey: 'synthetic-openrouter-key' })
  assert.equal(saved.status, 200)
  assert.equal(saved.data.keyConfigured, true)
  assert.equal(JSON.stringify(saved.data).includes('synthetic-openrouter-key'), false)
  const tested = await f.request('POST', '/api/providers/openrouter/test', {})
  assert.equal(tested.status, 200, JSON.stringify(tested.data))
  assert.deepEqual(tested.data.models, ['fixture/model-a', 'fixture/model-b'])
  assert.equal(tested.data.modelDetails[0].capabilities.streaming, 'unknown')
  assert.equal(Object.keys(tested.data.verified).length, 0, 'catalogue success is not inference verification')
  assert.equal(f.calls[0].path, '/api/v1/models')
  assert.equal(f.calls[0].headers.authorization, 'Bearer synthetic-openrouter-key')
  const selected = await f.request('PUT', '/api/models/selection', { model: 'fixture/model-a' })
  assert.equal(selected.status, 200)
  const current = await f.request('GET', '/api/providers')
  const reply = await f.request('POST', '/api/chat', f.chat('fixture/model-a', current.data.revision))
  assert.equal(reply.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.text, 'Fixture-only answer.')
  assert.equal(reply.data.providerModel, 'fixture/model-a')
  const completion = f.calls.at(-1)
  assert.equal(completion.path, '/api/v1/chat/completions')
  assert.equal(completion.body.model, 'fixture/model-a')
  assert.equal(completion.body.stream, false)
  const state = await f.request('GET', '/api/providers')
  assert.equal(typeof state.data.verified['fixture/model-a'], 'string', 'only successful chat inference updates this marker')
  assert.equal(state.data.modelDetails[0].capabilities.tools, 'not_exposed_by_ragam')
  const catalogue = await f.request('GET', '/api/providers/catalog')
  const openrouter = catalogue.data.providers.find((row) => row.id === 'openrouter')
  assert.equal(openrouter.integrationType, 'gateway-routed')
  assert.equal(openrouter.adapterStatus, 'contract_tested')
  assert.equal(openrouter.liveVerification, 'pending', 'a fixture is not a live vendor call')
})

test('xAI is dispatched through native Responses endpoints, not an OpenAI Chat Completions fallback', async (t) => {
  const f = await appFixture(t)
  const saved = await f.request('PUT', '/api/providers/xai', { baseUrl: `${f.peerUrl}/v1`, apiKey: 'synthetic-xai-key' })
  assert.equal(saved.status, 200)
  const tested = await f.request('POST', '/api/providers/xai/test', {})
  assert.equal(tested.status, 200, JSON.stringify(tested.data))
  assert.deepEqual(tested.data.models, ['grok-fixture'])
  assert.equal(f.calls[0].path, '/v1/language-models')
  await f.request('PUT', '/api/models/selection', { model: 'grok-fixture' })
  const current = await f.request('GET', '/api/providers')
  const reply = await f.request('POST', '/api/chat', f.chat('grok-fixture', current.data.revision))
  assert.equal(reply.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.text, 'xAI Responses fixture only.')
  const completion = f.calls.at(-1)
  assert.equal(completion.path, '/v1/responses')
  assert.equal(completion.body.model, 'grok-fixture')
  assert.deepEqual(completion.body.input, [{ role: 'user', content: 'Say hello.' }])
  assert.equal(completion.body.max_output_tokens, 512)
  const afterInference = await f.request('GET', '/api/providers')
  const streamed = await f.request('POST', '/api/chat/stream', f.chat('grok-fixture', afterInference.data.revision))
  assert.equal(streamed.status, 200, String(streamed.data))
  assert.match(streamed.data, /xAI stream fixture[.]/)
  assert.match(streamed.data, /event: done/)
})

test('Fireworks account id is non-secret configuration and remains separate from the encrypted API key', async (t) => {
  const f = await appFixture(t)
  const configured = await f.request('PUT', '/api/providers/fireworks', {
    baseUrl: f.peerUrl, apiKey: 'synthetic-fireworks-key', options: { accountId: 'acct_test' },
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.data))
  assert.deepEqual(configured.data.options, { accountId: 'acct_test' })
  assert.equal(JSON.stringify(configured.data).includes('synthetic-fireworks-key'), false)
  assert.equal(f.calls.length, 0)
  const tested = await f.request('POST', '/api/providers/fireworks/test', {})
  assert.equal(tested.status, 200, JSON.stringify(tested.data))
  assert.equal(f.calls[0].path, '/v1/accounts/acct_test/models?pageSize=200')
  const persisted = readFileSync(join(f.dir, 'provider.json'), 'utf8')
  assert.equal(persisted.includes('synthetic-fireworks-key'), false, 'the provider key is encrypted at rest')
  assert.match(persisted, /acct_test/)
  const refusedChange = await f.request('PUT', '/api/providers/fireworks', { baseUrl: f.peerUrl, options: { accountId: 'acct_other' } })
  assert.equal(refusedChange.status, 400, 'changing the account recipient cannot silently forward the saved key')
})

test('shared gateway normalizes provider rate, quota and auth failures without returning raw bodies', async (t) => {
  let status = 429, raw = { error: { code: 'rate_limit_exceeded', message: 'do not disclose this response' } }
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '3' })
    res.end(JSON.stringify(raw))
  })
  const baseUrl = await listen(server)
  const gateway = new OnlineGateway({ trustedOrigins: [baseUrl], timeoutMs: 1000 })
  const config = { id: 'openrouter', kind: 'openrouter', wire: 'openrouter_chat', baseUrl, apiKey: 'synthetic-private-key' }
  t.after(async () => { await close(server) })
  await assert.rejects(() => gateway.request(config, '/chat/completions', { body: { model: 'exact-model' } }), (error) => {
    assert.equal(error.code, 'provider_rate_limited')
    assert.equal(error.retryAfterMs, 3000)
    assert.equal(error.message.includes('do not disclose'), false)
    assert.equal(error.message.includes('synthetic-private-key'), false)
    return true
  })
  status = 429; raw = { error: { code: 'insufficient_quota', message: 'billing content remains private' } }
  await assert.rejects(() => gateway.request(config, '/chat/completions', { body: { model: 'exact-model' } }), (error) => {
    assert.equal(error.code, 'provider_quota_exhausted')
    assert.equal(error.message.includes('billing content'), false)
    return true
  })
  status = 401; raw = { error: { code: 'invalid_api_key', message: 'synthetic-private-key' } }
  await assert.rejects(() => gateway.request(config, '/chat/completions', { body: { model: 'exact-model' } }), (error) => {
    assert.equal(error.code, 'provider_auth_failed')
    assert.equal(error.message.includes('synthetic-private-key'), false)
    return true
  })
})
