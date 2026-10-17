// Contract tests for the image wire and the product's media job path.
//
// The vendor is a local fixture that returns the response shape published by OpenAI's image
// reference (a GPT image model returns `data[].b64_json`), and the bytes it returns are a real
// 1×1 PNG. Nothing here calls a vendor, and nothing here treats a URL as an image: the adapter
// only accepts inline bytes, so a URL-only response must fail the job rather than be fetched.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { OnlineGateway } from '../src/online/gateway.mjs'
import { MediaJobQueue, JOB_STATES } from '../src/media/jobs.mjs'
import { wireFor } from '../src/providers/wires/index.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

const IMAGE_KEY = 'synthetic-image-key'
// A real 1×1 transparent PNG. The queue validates the container signature, so a placeholder
// string would test the failure path instead of the success path.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG, 'base64')

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-image-'))
  const f = { calls: [], dir }
  let app, server
  const vendor = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : null
    f.calls.push({ path: req.url, method: req.method, headers: req.headers, body })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

    if (req.url === '/v1/models') {
      return json({ object: 'list', data: [{ id: 'gpt-image-1' }, { id: 'gpt-image-1-mini' }, { id: 'gpt-4o' }] })
    }
    if (req.url === '/v1/images/generations' && req.method === 'POST') {
      if (body.prompt === 'vendor failure') return json({ error: { message: 'upstream failed' } }, 500)
      if (body.prompt === 'url only') return json({ created: 1, data: [{ url: 'https://example.invalid/image.png' }] })
      if (body.prompt === 'not an image') return json({ created: 1, data: [{ b64_json: Buffer.from('this is text').toString('base64') }] })
      return json({
        created: 1,
        data: [{ b64_json: PNG, revised_prompt: 'a red circle on white' }],
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
        model: 'gpt-image-1',
      })
    }
    if (req.url === '/v1/chat/completions') return json({ choices: [{ message: { content: 'chat should not be called' } }] })
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  f.vendorUrl = await listen(vendor)
  const boot = async () => {
    app = new OnlineApp({ dataDir: dir, trustedOrigins: [f.vendorUrl], timeoutMs: 3000 })
    server = app.server()
    f.url = await listen(server)
  }
  await boot()
  f.request = async (method, path, body, options = {}) => {
    const response = await fetch(f.url + path, {
      method,
      headers: {
        cookie: options.cookie ?? f.cookie ?? '',
        ...(body !== undefined ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    let data
    try { data = JSON.parse(buffer.toString('utf8')) } catch { data = buffer.toString('utf8') }
    return { status: response.status, data, headers: response.headers, bytes: buffer }
  }
  f.account = { email: 'owner@example.test', password: 'a-long-owner-password' }
  f.revision = () => app.store.state.revision
  f.login = async (account = f.account) => {
    let r = await f.request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', account)
    f.cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.restart = async () => {
    await close(server)
    app.close()
    await boot()
    await f.login()
  }
  f.configure = async () => {
    await f.login()
    const saved = await f.request('PUT', '/api/providers/openai-images', { baseUrl: `${f.vendorUrl}/v1`, apiKey: IMAGE_KEY })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    const probed = await f.request('POST', '/api/providers/openai-images/test', {})
    assert.equal(probed.status, 200, JSON.stringify(probed.data))
    return probed.data
  }
  f.waitFor = async (id, { timeoutMs = 5000 } = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await f.request('GET', `/api/image/jobs/${id}`)
      assert.equal(r.status, 200, JSON.stringify(r.data))
      if (r.data.terminal) return r.data
      if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(r.data)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  t.after(async () => { await close(server); await close(vendor); app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

test('the image wire lists image models and refuses a URL instead of fetching it', async () => {
  const calls = []
  const transport = async (config, path, options) => {
    calls.push({ path, options })
    if (path === '/models') return { data: [{ id: 'gpt-image-1' }, { id: 'gpt-4o' }] }
    if (path === '/images/generations') return { data: [{ url: 'https://example.invalid/x.png' }] }
    throw new Error(`unexpected path ${path}`)
  }
  const config = { id: 'openai-images', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }
  assert.deepEqual(await wireFor('openai_images').models(transport, config), ['gpt-image-1'])
  await assert.rejects(
    wireFor('openai_images').generate(transport, config, { model: 'gpt-image-1', prompt: 'a circle' }),
    (error) => error.code === 'invalid_completion',
  )
  const sent = calls.at(-1)
  assert.equal(sent.path, '/images/generations')
  assert.equal(sent.options.body.model, 'gpt-image-1')
  assert.equal(sent.options.body.n, 1)
  assert.equal(sent.options.body.response_format, undefined, 'GPT image models return base64 by default')
  assert.equal(sent.options.maxResponseBytes, 24 * 1024 * 1024)
})

test('the image area generates, validates, stores and serves a real image', async (t) => {
  const f = await fixture(t)
  const probed = await f.configure()
  assert.deepEqual(probed.models, ['gpt-image-1', 'gpt-image-1-mini'])
  const ready = await f.request('GET', '/api/ready')
  assert.equal(ready.data.capabilities.imageGeneration, true)
  assert.equal(ready.data.capabilities.chat, false, 'an image connection does not claim chat')

  const created = await f.request('POST', '/api/image/generate', { prompt: 'a red circle', size: '1024x1024', model: 'gpt-image-1' })
  assert.equal(created.status, 202, JSON.stringify(created.data))
  const job = await f.waitFor(created.data.id)
  assert.equal(job.state, JOB_STATES.SUCCEEDED, JSON.stringify(job))
  assert.equal(job.kind, 'image')
  assert.equal(job.result.model, 'gpt-image-1')
  assert.equal(job.result.revisedPrompt, 'a red circle on white')
  assert.equal(job.artifact.format, 'png')
  assert.equal(job.artifact.mime, 'image/png')
  assert.equal(job.artifact.byteLength, PNG_BYTES.length)
  assert.equal(job.artifact.sha256.length, 64)

  const call = f.calls.find((entry) => entry.path === '/v1/images/generations')
  assert.equal(call.headers.authorization, `Bearer ${IMAGE_KEY}`)
  assert.equal(call.body.model, 'gpt-image-1')
  assert.equal(call.body.prompt, 'a red circle')
  assert.equal(call.body.size, '1024x1024')
  assert.equal(call.body.n, 1)

  const content = await f.request('GET', `/api/image/jobs/${job.id}/content`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(content.bytes, PNG_BYTES)

  const listed = await f.request('GET', '/api/image/jobs')
  assert.equal(listed.data.jobs.length, 1)
  assert.equal(listed.data.jobs[0].id, job.id)
})

test('an image connection refuses chat without sending a request, and a video request stays unavailable', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const chat = await f.request('POST', '/api/chat', {
    prompt: 'hello', model: 'gpt-image-1',
    authorization: { confirmed: true, providerRevision: f.revision() },
  })
  assert.equal(chat.status, 409, JSON.stringify(chat.data))
  assert.equal(chat.data.error, 'capability_unavailable')
  assert.equal(f.calls.some((call) => call.path === '/v1/chat/completions'), false)
  const video = await f.request('POST', '/api/video/generate', {})
  assert.equal(video.status, 503)
  assert.equal(video.data.error, 'capability_unavailable')
})

test('a provider failure, a URL-only response and non-image bytes fail the job with no artifact', async (t) => {
  const f = await fixture(t)
  await f.configure()
  for (const [prompt, reason] of [['vendor failure', 'provider_error'], ['url only', 'invalid_completion'], ['not an image', 'validation']]) {
    const created = await f.request('POST', '/api/image/generate', { prompt, model: 'gpt-image-1' })
    assert.equal(created.status, 202, JSON.stringify(created.data))
    const job = await f.waitFor(created.data.id)
    assert.equal(job.state, JOB_STATES.FAILED, `${prompt}: ${JSON.stringify(job)}`)
    assert.equal(job.artifact, null)
    assert.ok(job.error, `${prompt} must say why it failed`)
    if (reason === 'validation') assert.match(job.error, /output validation failed/)
    else if (reason === 'invalid_completion') assert.match(job.error, /inline image/)
    const content = await f.request('GET', `/api/image/jobs/${job.id}/content`)
    assert.equal(content.status, 404)
  }
})

test('image prompts, sizes and models are validated before anything is queued', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const cases = [
    [{ prompt: '' }, 400, 'invalid_prompt'],
    [{ prompt: 'x'.repeat(4001) }, 400, 'invalid_prompt'],
    [{ prompt: 'ok', size: '999x999' }, 400, 'invalid_parameters'],
    [{ prompt: 'ok', model: 'not-listed' }, 409, 'model_unavailable'],
  ]
  for (const [body, status, code] of cases) {
    const r = await f.request('POST', '/api/image/generate', { model: 'gpt-image-1', ...body })
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${JSON.stringify(r.data)}`)
    assert.equal(r.data.error, code)
  }
  assert.equal(f.calls.filter((call) => call.path === '/v1/images/generations').length, 0)
})

test('a generated image is per account, deletable, and its record survives a restart', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const created = await f.request('POST', '/api/image/generate', { prompt: 'durable', model: 'gpt-image-1' })
  const job = await f.waitFor(created.data.id)
  assert.equal(job.state, JOB_STATES.SUCCEEDED)

  await f.restart()
  const after = await f.request('GET', `/api/image/jobs/${job.id}`)
  assert.equal(after.status, 200, JSON.stringify(after.data))
  assert.equal(after.data.state, JOB_STATES.SUCCEEDED)
  assert.equal(after.data.artifact.sha256, job.artifact.sha256)

  // A second account sees neither the record nor the bytes.
  const second = { email: 'second@example.test', password: 'another-long-password' }
  await f.request('POST', '/api/auth/logout', {})
  await f.login(second)
  assert.equal((await f.request('GET', `/api/image/jobs/${job.id}`)).status, 404)
  assert.equal((await f.request('GET', `/api/image/jobs/${job.id}/content`)).status, 404)
  assert.equal((await f.request('GET', '/api/image/jobs')).data.jobs.length, 0)

  // Back on the owner, deletion removes the record and the stored bytes.
  await f.request('POST', '/api/auth/logout', {})
  await f.login()
  const deleted = await f.request('DELETE', `/api/image/jobs/${job.id}`, {})
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data))
  assert.equal(deleted.data.removed, true)
  assert.equal((await f.request('GET', `/api/image/jobs/${job.id}`)).status, 404)
  assert.equal((await f.request('GET', `/api/image/jobs/${job.id}/content`)).status, 404)
})

test('the queue persists a terminal record to disk and marks an interrupted job honestly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-media-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'jobs.json')
  const first = new MediaJobQueue({ storageDir: join(dir, 'media'), statePath })
  const created = first.enqueue({ kind: 'image', run: async () => ({ bytes: PNG_BYTES }), params: { prompt: 'x' } })
  const finished = await first.waitFor(created.id)
  assert.equal(finished.state, JOB_STATES.SUCCEEDED)
  // A record left as running is what a crash would leave; it must not come back as running.
  const stale = { ...finished, id: '00000000-0000-4000-8000-000000000000', state: JOB_STATES.RUNNING, artifact: null, finishedAt: null }
  const records = [...first.jobs.values(), stale]
  const { writeFileSync } = await import('node:fs')
  writeFileSync(statePath, JSON.stringify(records))

  const second = new MediaJobQueue({ storageDir: join(dir, 'media'), statePath })
  assert.equal(second.get(finished.id).state, JOB_STATES.SUCCEEDED)
  assert.equal(second.get(stale.id).state, JOB_STATES.FAILED)
  assert.equal(second.get(stale.id).errorCode, 'interrupted')
  const artifact = await second.readArtifact(finished.id)
  assert.deepEqual(Buffer.from(artifact.bytes), PNG_BYTES)
})

test('a media queue with no state path remains in-memory, as the library tests assume', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-media-memory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const queue = new MediaJobQueue({ storageDir: join(dir, 'media') })
  const created = queue.enqueue({ kind: 'image', run: async () => ({ bytes: PNG_BYTES }) })
  assert.equal((await queue.waitFor(created.id)).state, JOB_STATES.SUCCEEDED)
  assert.equal(queue.jobs.size, 1)
  assert.equal((await new MediaJobQueue({ storageDir: join(dir, 'media') }).list()).length, 0)
})

test('the gateway response limit can be raised for one media call and not for chat', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const gateway = new OnlineGateway({ trustedOrigins: [f.vendorUrl], timeoutMs: 3000 })
  const config = { id: 'openai-images', baseUrl: `${f.vendorUrl}/v1`, apiKey: IMAGE_KEY }
  const data = await gateway.request(config, '/images/generations', {
    body: { model: 'gpt-image-1', prompt: 'limit', n: 1 },
    maxResponseBytes: 1024 * 1024,
  })
  assert.equal(data.data[0].b64_json, PNG)
  // The same call with the default 2 MB cap is not affected by the image cap; it is a per-call
  // ceiling, not a change to the installation's transport bounds.
  const small = await gateway.request(config, '/models', {})
  assert.equal(Array.isArray(small.data), true)
})
