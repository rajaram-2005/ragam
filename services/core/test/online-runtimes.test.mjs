// Ollama and llama.cpp reach the online entry through the same transport as LiteLLM.
//
// Every fixture here is synthetic: a loopback server that speaks the OpenAI-compatible
// `/v1/models` and `/v1/chat/completions` routes, which is what both runtimes expose. No
// real Ollama, llama.cpp or provider is contacted, and no completion is invented by the
// product -- the fixture returns a fixed string and says so.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { RUNTIMES, runtimeFor } from '../src/online/gateway.mjs'

const listen = (s) => new Promise((done) => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise((done) => { s.closeAllConnections(); s.close(done) })

/** A synthetic runtime. `calls` records what the product actually sent it. */
async function runtime(t, { models = ['local-a', 'local-b'] } = {}) {
  const f = { calls: [], stream: false }
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    f.calls.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization ?? null })
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: models.map((id) => ({ id })) }))
    if (body?.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Synthetic runtime reply.' } }] })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    return res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'Synthetic runtime reply.' } }] }))
  })
  f.base = await listen(server)
  f.v1 = `${f.base}/v1`
  t.after(() => close(server))
  return f
}

async function fixture(t, { trustedOrigins = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aetheris-runtime-test-'))
  const f = {}
  f.app = new OnlineApp({ dataDir: dir, trustedOrigins, timeoutMs: 2000 })
  const server = f.app.server(); f.url = await listen(server)
  f.request = async (method, path, body, opts = {}) => {
    const response = await fetch(f.url + path, { method, headers: { cookie: opts.cookie ?? f.cookie ?? '', ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const text = await response.text(); let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, data, headers: response.headers }
  }
  f.login = async (email = 'owner@example.test') => {
    let r = await f.request('POST', '/api/auth/register', { email, password: 'a-long-owner-password' })
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', { email, password: 'a-long-owner-password' })
    f.cookie = r.headers.get('set-cookie').split(';')[0]; return r
  }
  f.dir = dir
  f.restart = () => { f.app.close(); f.app = new OnlineApp({ dataDir: dir, trustedOrigins, timeoutMs: 2000 }) }
  t.after(async () => { await close(server); f.app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

const chat = (f, extra = {}) => ({ prompt: 'ordinary question', model: 'local-a', authorization: { confirmed: true, providerRevision: f.app.store.state.revision }, ...extra })

test('the runtime table is closed: unknown kinds are refused, not defaulted', () => {
  assert.deepEqual(Object.keys(RUNTIMES).sort(), ['litellm', 'llamacpp', 'ollama'])
  assert.equal(runtimeFor('litellm').keyRequired, true)
  assert.equal(runtimeFor('ollama').keyRequired, false)
  assert.equal(runtimeFor('llamacpp').keyRequired, false)
  assert.throws(() => runtimeFor('vllm'), (e) => e.code === 'invalid_runtime')
  assert.throws(() => runtimeFor('__proto__'), (e) => e.code === 'invalid_runtime')
})

test('an Ollama connection is saved with no key, lists its models and chats without sending credentials', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  const saved = await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  assert.equal(saved.data.kind, 'ollama'); assert.equal(saved.data.name, 'Ollama')
  assert.equal(saved.data.keyConfigured, false); assert.equal(saved.data.configured, true)
  assert.equal(saved.data.keyRequired, false)

  const probed = await f.request('POST', '/api/providers/ollama/test', {})
  assert.equal(probed.status, 200); assert.deepEqual(probed.data.models, ['local-a', 'local-b'])
  assert.equal(up.calls.at(-1).path, '/v1/models')
  assert.equal(up.calls.at(-1).authorization, null, 'no key stored means no Authorization header')

  const reply = await f.request('POST', '/api/chat', chat(f))
  assert.equal(reply.status, 200, JSON.stringify(reply.data))
  assert.equal(reply.data.provider, 'Ollama'); assert.equal(reply.data.sentExternally, true)
  assert.equal(up.calls.at(-1).path, '/v1/chat/completions')
  assert.equal(up.calls.at(-1).authorization, null)
})

test('a llama.cpp server with --api-key receives the stored key, which is encrypted and never returned', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  const saved = await f.request('PUT', '/api/providers/llamacpp', { baseUrl: up.v1, apiKey: 'synthetic-llamacpp-key' })
  assert.equal(saved.status, 200); assert.equal(saved.data.name, 'llama.cpp server'); assert.equal(saved.data.keyConfigured, true)
  assert.ok(!JSON.stringify(saved.data).includes('synthetic-llamacpp-key'))
  assert.ok(!readFileSync(join(f.dir, 'provider.json'), 'utf8').includes('synthetic-llamacpp-key'))
  await f.request('POST', '/api/providers/llamacpp/test', {})
  assert.equal(up.calls.at(-1).authorization, 'Bearer synthetic-llamacpp-key')
})

test('a loopback runtime is refused without an exact trusted origin, and nothing is stored', async (t) => {
  const up = await runtime(t)
  for (const trustedOrigins of [[], ['http://localhost:11434']]) {
    const f = await fixture(t, { trustedOrigins }); await f.login()
    const refused = await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
    assert.equal(refused.status, 400); assert.equal(refused.data.error, 'endpoint_blocked')
    assert.match(refused.data.message, /trusted origin/)
    const state = (await f.request('GET', '/api/providers')).data
    assert.equal(state.baseUrl, ''); assert.equal(state.configured, false)
    assert.equal(up.calls.length, 0, 'nothing was contacted')
  }
})

test('switching runtime or endpoint never forwards the stored key to the new destination', async (t) => {
  const up = await runtime(t)
  const other = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base, other.base] }); await f.login()
  await f.request('PUT', '/api/providers/llamacpp', { baseUrl: up.v1, apiKey: 'synthetic-llamacpp-key' })

  // Same runtime and endpoint, no key supplied: the key is kept, because it is the same recipient.
  const same = await f.request('PUT', '/api/providers/llamacpp', { baseUrl: up.v1 })
  assert.equal(same.status, 200); assert.equal(same.data.keyConfigured, true)

  // Same endpoint, different runtime: the key is not carried, and an Ollama connection needs none.
  const switched = await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  assert.equal(switched.status, 200); assert.equal(switched.data.keyConfigured, false)
  await f.request('POST', '/api/providers/ollama/test', {})
  assert.equal(up.calls.at(-1).authorization, null, 'the llama.cpp key did not follow the connection')

  // A different endpoint for the same runtime is a new recipient too.
  await f.request('PUT', '/api/providers/llamacpp', { baseUrl: up.v1, apiKey: 'synthetic-llamacpp-key' })
  const moved = await f.request('PUT', '/api/providers/llamacpp', { baseUrl: other.v1 })
  assert.equal(moved.status, 200); assert.equal(moved.data.keyConfigured, false)
  assert.equal(other.calls.length, 0)
})

test('LiteLLM still requires a key, and a runtime route cannot act on a different saved runtime', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  const noKey = await f.request('PUT', '/api/providers/litellm', { baseUrl: up.v1 })
  assert.equal(noKey.status, 400); assert.equal(noKey.data.error, 'key_required')

  await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  const mismatch = await f.request('POST', '/api/providers/litellm/test', {})
  assert.equal(mismatch.status, 409); assert.equal(mismatch.data.error, 'provider_mismatch')
  assert.equal(up.calls.filter((c) => c.path.endsWith('/models')).length, 0, 'a mismatched test contacts nothing')
  const removeMismatch = await f.request('DELETE', '/api/providers/llamacpp', {})
  assert.equal(removeMismatch.status, 409); assert.equal(f.app.store.state.baseUrl, up.v1)
})

test('an unknown runtime path is not a route, and members cannot change the connection', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  assert.equal((await f.request('PUT', '/api/providers/vllm', { baseUrl: up.v1 })).status, 404)
  await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  await f.request('POST', '/api/auth/logout', {})
  await f.login('member@example.test')
  assert.equal((await f.request('PUT', '/api/providers/llamacpp', { baseUrl: up.v1, apiKey: 'x' })).status, 403)
  assert.equal((await f.request('DELETE', '/api/providers/ollama', {})).status, 403)
  assert.equal(f.app.store.kind(), 'ollama')
})

test('the active runtime and endpoint survive a restart; a pre-runtime record still reads as LiteLLM', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  f.restart()
  assert.equal(f.app.store.public().kind, 'ollama'); assert.equal(f.app.store.public().configured, true)

  // A record written before runtimes existed has no `kind` field and always meant LiteLLM.
  const legacy = JSON.parse(readFileSync(join(f.dir, 'provider.json'), 'utf8'))
  delete legacy.kind
  legacy.key = null
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(f.dir, 'provider.json'), JSON.stringify(legacy))
  f.restart()
  assert.equal(f.app.store.kind(), 'litellm'); assert.equal(f.app.store.public().configured, false)
  assert.throws(() => f.app.store.config(), (e) => e.code === 'provider_not_configured')
})

test('readiness and model listings name the active runtime and stay unverified until inference is observed', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  await f.request('POST', '/api/providers/ollama/test', {})
  const ready = f.app.readiness()
  assert.equal(ready.provider.kind, 'ollama'); assert.equal(ready.provider.name, 'Ollama')
  assert.equal(ready.status, 'configured'); assert.equal(ready.capabilities.chat, true)
  const models = (await f.request('GET', '/api/models')).data.models
  assert.ok(models.every((m) => m.provider === 'ollama' && m.location === 'online' && m.availability === 'listed_unverified'))
  await f.request('PUT', '/api/models/selection', { model: 'local-a' })
  await f.request('POST', '/api/chat', chat(f))
  assert.equal(f.app.store.state.verified['local-a'] !== undefined, true)
})

test('streaming works through a local runtime with the same completion requirement', async (t) => {
  const up = await runtime(t)
  const f = await fixture(t, { trustedOrigins: [up.base] }); await f.login()
  await f.request('PUT', '/api/providers/ollama', { baseUrl: up.v1 })
  assert.equal((await f.request('POST', '/api/providers/ollama/test', {})).status, 200)
  const r = await f.request('POST', '/api/chat/stream', chat(f))
  assert.equal(r.status, 200); assert.match(r.data, /event: delta/); assert.match(r.data, /event: done/)
  assert.equal(up.calls.at(-1).body.stream, true)
})
