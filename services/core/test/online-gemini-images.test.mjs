// Contract tests for the Gemini image wire and its product path.
//
// The fixture returns the shape the Gemini API documents for an image model: a generateContent
// response whose image part is `inlineData: { mimeType, data }`, with the model list in the
// ordinary `{ models: [...] }` envelope. Nothing here calls Google.
//
// The product tests prove the second image vendor is reachable from the same Image area and the
// same durable job path, and that the connection is chosen by the wire's modality rather than by
// a hard-coded vendor id.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { OnlineGateway } from '../src/online/gateway.mjs'
import { wireFor } from '../src/providers/wires/index.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

const KEY = 'synthetic-gemini-key'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg=='

const config = (baseUrl) => ({ baseUrl, apiKey: KEY, id: 'gemini-images', wire: 'gemini_images' })
const gatewayFor = (url, trusted) => {
  const gateway = new OnlineGateway({ timeoutMs: 3000, trustedOrigins: trusted ?? [url] })
  return gateway.request.bind(gateway)
}

test('the Gemini image wire lists image models and sends an image-only generateContent request', async (t) => {
  const calls = []
  const vendor = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    calls.push({ path: req.url, headers: req.headers, body })
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/v1beta/models?') || req.url === '/v1beta/models') {
      return res.end(JSON.stringify({ models: [
        { name: 'models/gemini-2.5-flash-image' },
        { name: 'models/gemini-3.1-flash-image' },
        { name: 'models/gemini-2.5-pro' },
        { name: 'models/imagen-4.0-generate-001' },
      ] }))
    }
    return res.end(JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'Here is the image.' },
      { inlineData: { mimeType: 'image/png', data: PNG } },
    ] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }))
  })
  const url = await listen(vendor)
  t.after(() => close(vendor))
  const transport = gatewayFor(url)
  const wire = wireFor('gemini_images')

  const models = await wire.models(transport, config(`${url}/v1beta`))
  assert.deepEqual(models, ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'], 'Imagen and chat models are not image models for this wire')
  assert.equal(calls.at(-1).headers['x-goog-api-key'], KEY, 'the key is sent as the Gemini header')
  assert.equal(calls.at(-1).headers.authorization, undefined, 'no Bearer credential is invented')

  const result = await wire.generate(transport, config(`${url}/v1beta`), { model: 'gemini-2.5-flash-image', prompt: 'A red circle', size: '1536x1024' })
  assert.deepEqual(result.bytes, Buffer.from(PNG, 'base64'))
  assert.equal(result.model, 'gemini-2.5-flash-image')
  assert.equal(result.usage.totalTokenCount, 10)
  const sent = calls.at(-1)
  assert.equal(sent.path, '/v1beta/models/gemini-2.5-flash-image:generateContent')
  assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'A red circle' }] }])
  assert.deepEqual(sent.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3' } })

  // `auto` sends no imageConfig, so the model's own default applies rather than a guessed shape.
  await wire.generate(transport, config(`${url}/v1beta`), { model: 'gemini-2.5-flash-image', prompt: 'A red circle', size: 'auto' })
  assert.deepEqual(calls.at(-1).body.generationConfig, { responseModalities: ['IMAGE'] })
})

test('the Gemini image wire refuses a missing image, a URL, a wrong type and a bad size', async (t) => {
  let reply = { candidates: [{ content: { parts: [{ text: 'no image' }] } }] }
  let status = 200
  const vendor = createServer((req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply)) })
  const url = await listen(vendor)
  t.after(() => close(vendor))
  const wire = wireFor('gemini_images')
  const transport = gatewayFor(url)
  const base = `${url}/v1beta`

  await assert.rejects(wire.generate(transport, config(base), { model: 'm', prompt: 'p' }), (error) => error.code === 'invalid_completion')
  reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'text/html', data: PNG } }] } }] }
  await assert.rejects(wire.generate(transport, config(base), { model: 'm', prompt: 'p' }), (error) => error.code === 'invalid_response')
  reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'not base64 !!!' } }] } }] }
  await assert.rejects(wire.generate(transport, config(base), { model: 'm', prompt: 'p' }), (error) => error.code === 'invalid_response')
  await assert.rejects(wire.generate(transport, config(base), { model: 'm', prompt: 'p', size: '512x512' }), (error) => error.code === 'invalid_parameters')

  // A safety refusal is reported by name instead of pretending the model returned nothing.
  reply = { promptFeedback: { blockReason: 'SAFETY' } }
  await assert.rejects(wire.generate(transport, config(base), { model: 'm', prompt: 'p' }), (error) => error.code === 'invalid_completion' && /SAFETY/.test(error.message))
})

test('the Image area generates through a saved Gemini Images connection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-gemini-image-'))
  const calls = []
  const vendor = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    calls.push({ path: req.url, body })
    res.setHeader('content-type', 'application/json')
    // The generate path also begins with `/v1beta/models`, so it is matched first: a fixture that
    // checks the prefix first answers a generation with the model list and tests nothing.
    if (req.url.includes(':generateContent')) {
      if (body.contents?.[0]?.parts?.[0]?.text === 'blocked') return res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }))
      return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }))
    }
    if (req.url.startsWith('/v1beta/models')) return res.end(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash-image' },
      { name: 'models/gemini-2.5-pro' },
    ] }))
    res.writeHead(404); res.end('{}')
  })
  const vendorUrl = await listen(vendor)
  const app = new OnlineApp({ dataDir: dir, trustedOrigins: [vendorUrl], timeoutMs: 3000 })
  const server = app.server(); const url = await listen(server)
  t.after(async () => { await close(server); await close(vendor); app.close(); rmSync(dir, { recursive: true, force: true }) })

  let cookie = ''
  const request = async (method, path, body) => {
    const response = await fetch(url + path, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const buffer = Buffer.from(await response.arrayBuffer()); let data
    try { data = JSON.parse(buffer.toString('utf8')) } catch { data = buffer.toString('utf8') }
    return { status: response.status, data, headers: response.headers, bytes: buffer }
  }
  const login = await request('POST', '/api/auth/register', { email: 'owner@example.test', password: 'a-long-owner-password' })
  cookie = login.headers.get('set-cookie').split(';')[0]

  const saved = await request('PUT', '/api/providers/gemini-images', { baseUrl: `${vendorUrl}/v1beta`, apiKey: KEY })
  assert.equal(saved.status, 200, JSON.stringify(saved.data))
  const tested = await request('POST', '/api/providers/gemini-images/test', {})
  assert.equal(tested.status, 200, JSON.stringify(tested.data))
  assert.deepEqual(tested.data.models, ['gemini-2.5-flash-image'])

  const started = await request('POST', '/api/image/generate', {
    prompt: 'A red circle',
    model: 'gemini-2.5-flash-image',
    size: '1024x1024',
    authorization: { confirmed: true, providerRevision: app.store.state.revision },
  })
  assert.equal(started.status, 202, JSON.stringify(started.data))
  let job = started.data
  for (let i = 0; i < 200 && !job.terminal; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    job = (await request('GET', `/api/image/jobs/${started.data.id}`)).data
  }
  assert.equal(job.state, 'succeeded', JSON.stringify(job))
  assert.equal(job.params.provider, 'gemini-images')
  assert.equal(job.result.model, 'gemini-2.5-flash-image')

  const content = await request('GET', `/api/image/jobs/${started.data.id}/content`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.deepEqual(content.bytes, Buffer.from(PNG, 'base64'))

  // A safety refusal is a failed job with the provider's reason, not a fake success.
  const blocked = await request('POST', '/api/image/generate', { prompt: 'blocked', model: 'gemini-2.5-flash-image' })
  assert.equal(blocked.status, 202)
  let failed = blocked.data
  for (let i = 0; i < 200 && !failed.terminal; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    failed = (await request('GET', `/api/image/jobs/${blocked.data.id}`)).data
  }
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /SAFETY/)
})
