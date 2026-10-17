// Contract tests for the video wire and the asynchronous job path.
//
// The vendor fixture returns the shape Google's Veo documentation publishes: a long-running
// operation name, a polled operation, and a file URI that must be downloaded as bytes. The bytes
// are a real ISO-BMFF file (ftyp + moov/mvhd + mdat) with a measurable 4-second duration, so the
// test exercises the same container check and duration probe the product uses at runtime.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { OnlineGateway } from '../src/online/gateway.mjs'
import { MediaJobQueue, JOB_STATES } from '../src/media/jobs.mjs'
import { probeMp4 } from '../src/media/validate.mjs'
import { wireFor } from '../src/providers/wires/index.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

const KEY = 'synthetic-veo-key'
const box = (type, payload) => {
  const out = Buffer.alloc(8 + payload.length)
  out.writeUInt32BE(out.length, 0)
  out.write(type, 4, 'latin1')
  payload.copy(out, 8)
  return out
}
function makeMp4() {
  const ftyp = box('ftyp', Buffer.from('isom0000isommp42', 'latin1'))
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt8(0, 0)
  mvhd.writeUInt32BE(1000, 12) // timescale
  mvhd.writeUInt32BE(4000, 16) // duration → 4 seconds
  const moov = box('moov', box('mvhd', mvhd))
  const mdat = box('mdat', Buffer.alloc(9_000, 1))
  return Buffer.concat([ftyp, moov, mdat])
}
const MP4 = makeMp4()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg==', 'base64')

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-video-'))
  const f = { calls: [], polls: 0, dir }
  let app, server
  const vendor = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : null
    f.calls.push({ path: req.url, method: req.method, headers: req.headers, body })
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const base = f.vendorUrl

    if (req.url.startsWith('/v1beta/models?')) {
      return json({
        models: [
          { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/veo-3.1-fast-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/veo-legacy', supportedGenerationMethods: ['generateContent'] },
        ],
      })
    }
    if (req.method === 'POST' && req.url === '/v1beta/models/veo-3.1-generate-preview:predictLongRunning') {
      f.currentPrompt = body.instances[0].prompt
      f.polls = 0
      return json({ name: 'models/veo-3.1-generate-preview/operations/op-1' })
    }
    if (req.method === 'GET' && req.url === '/v1beta/models/veo-3.1-generate-preview/operations/op-1') {
      f.polls += 1
      const prompt = f.currentPrompt
      if (prompt === 'operation failure') return json({ name: 'models/x/operations/op-1', done: true, error: { code: 13, message: 'internal boom' } })
      if (prompt === 'filtered') return json({ done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['blocked by policy'] } } })
      if (prompt === 'no samples') return json({ done: true, response: {} })
      if (prompt === 'slow' || f.polls <= 2) return json({ name: 'models/x/operations/op-1', done: false, metadata: { state: 'RUNNING' } })
      if (prompt === 'foreign') return json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${f.foreignUrl}/file.mp4` } }] } } })
      if (prompt === 'redirect') return json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${f.foreignUrl}/redirect.mp4` } }] } } })
      const file = prompt === 'still image' ? 'still' : 'video-1'
      return json({
        done: true,
        response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/v1beta/files/${file}:download?alt=media` } }] } },
      })
    }
    if (req.method === 'GET' && req.url.startsWith('/v1beta/files/')) {
      if (req.url.includes('still')) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(PNG) }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length }); return res.end(MP4)
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  f.vendorUrl = await listen(vendor)

  // A second public host: the file URI is not the API origin. The credential must not follow it.
  const foreign = createServer((req, res) => {
    f.foreignCalls.push({ path: req.url, headers: req.headers })
    if (req.url === '/redirect.mp4') { res.writeHead(302, { location: `${f.foreignUrl}/file.mp4` }); return res.end() }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length }); res.end(MP4)
  })
  f.foreignCalls = []
  f.foreignUrl = await listen(foreign)

  const boot = async () => {
    app = new OnlineApp({ dataDir: dir, trustedOrigins: [f.vendorUrl, f.foreignUrl], timeoutMs: 3000, mediaPoll: { initialMs: 1, maxMs: 2, factor: 1 } })
    server = app.server()
    f.url = await listen(server)
  }
  await boot()
  f.request = async (method, path, body, options = {}) => {
    const response = await fetch(f.url + path, {
      method,
      headers: {
        cookie: f.cookie ?? '',
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
  f.login = async (account = f.account) => {
    let r = await f.request('POST', '/api/auth/register', account)
    if (r.status !== 201) r = await f.request('POST', '/api/auth/login', account)
    f.cookie = r.headers.get('set-cookie').split(';')[0]
    return r
  }
  f.configure = async () => {
    await f.login()
    const saved = await f.request('PUT', '/api/providers/veo', { baseUrl: `${f.vendorUrl}/v1beta`, apiKey: KEY })
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    const probed = await f.request('POST', '/api/providers/veo/test', {})
    assert.equal(probed.status, 200, JSON.stringify(probed.data))
    return probed.data
  }
  f.waitFor = async (id, { timeoutMs = 8000 } = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const r = await f.request('GET', `/api/video/jobs/${id}`)
      assert.equal(r.status, 200, JSON.stringify(r.data))
      if (r.data.terminal) return r.data
      if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(r.data)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  t.after(async () => { await close(server); await close(vendor); await close(foreign); app.close(); rmSync(dir, { recursive: true, force: true }) })
  return f
}

test('the video wire lists only long-running video models and polls an operation to bytes', async () => {
  const calls = []
  const transport = async (config, path, options = {}) => {
    calls.push({ path, options })
    if (path.endsWith(':predictLongRunning')) return { name: 'models/veo-3.1-generate-preview/operations/op-9' }
    if (path.includes('/operations/')) {
      if (calls.filter((call) => call.path.includes('/operations/')).length < 2) return { done: false }
      return { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://files.example.test/v.mov' } }] } } }
    }
    if (path === '/v.mov') return { bytes: MP4, contentType: 'video/mp4' }
    if (path.startsWith('/models?')) return { models: [
      { name: 'models/veo-3.1-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    ] }
    throw new Error(`unexpected ${path}`)
  }
  const config = { id: 'veo', kind: 'veo', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'k' }
  assert.deepEqual(await wireFor('gemini_veo').models(transport, config), ['veo-3.1-generate-preview'])
  const result = await wireFor('gemini_veo').generate(transport, config, {
    model: 'veo-3.1-generate-preview', prompt: 'a wave', aspectRatio: '16:9', resolution: '720p',
    poll: { initialMs: 1, maxMs: 1, factor: 1 },
  })
  assert.equal(result.model, 'veo-3.1-generate-preview')
  assert.equal(result.durationSeconds, 4)
  assert.equal(result.aspectRatio, '16:9')
  assert.equal(result.resolution, '720p')
  assert.equal(result.video.length, MP4.length)
  const started = calls.find((call) => call.path.endsWith(':predictLongRunning'))
  assert.equal(started.options.headers['x-goog-api-key'], 'k')
  assert.deepEqual(started.options.body.instances, [{ prompt: 'a wave' }])
  assert.deepEqual(started.options.body.parameters, { sampleCount: 1, aspectRatio: '16:9', resolution: '720p' })
  // The file host is not the API origin: the key stays behind.
  const download = calls.find((call) => call.path === '/v.mov')
  assert.deepEqual(download.options.headers, {})
})

test('the video area renders the completed job and serves the stored MP4', async (t) => {
  const f = await fixture(t)
  assert.deepEqual((await f.configure()).models, ['veo-3.1-fast-generate-preview', 'veo-3.1-generate-preview'])
  const readiness = (await f.request('GET', '/api/ready')).data
  assert.equal(readiness.capabilities.videoGeneration, true)
  assert.equal(readiness.capabilities.imageGeneration, false, 'a video connection does not claim images')

  const created = await f.request('POST', '/api/video/generate', { prompt: 'a wave', model: 'veo-3.1-generate-preview', aspectRatio: '16:9', resolution: '720p' })
  assert.equal(created.status, 202, JSON.stringify(created.data))
  const job = await f.waitFor(created.data.id)
  assert.equal(job.state, JOB_STATES.SUCCEEDED, JSON.stringify(job))
  assert.equal(job.kind, 'video')
  assert.equal(job.result.model, 'veo-3.1-generate-preview')
  assert.equal(job.result.platform, 'Google Veo')
  assert.equal(job.result.durationSeconds, 4)
  assert.equal(job.result.aspectRatio, '16:9')
  assert.equal(job.artifact.format, 'mp4')
  assert.equal(job.artifact.mime, 'video/mp4')
  assert.equal(job.artifact.byteLength, MP4.length)

  const started = f.calls.find((call) => call.path.endsWith(':predictLongRunning'))
  assert.equal(started.headers['x-goog-api-key'], KEY)
  assert.equal(started.body.parameters.aspectRatio, '16:9')
  assert.ok(f.polls >= 3, `expected the operation to be polled until done, saw ${f.polls}`)

  const content = await f.request('GET', `/api/video/jobs/${job.id}/content`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'video/mp4')
  assert.equal(content.headers.get('accept-ranges'), 'none')
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(content.bytes, MP4)
  assert.deepEqual((await f.request('GET', '/api/video/jobs')).data.jobs.map((entry) => entry.id), [job.id])
})

test('a failed operation, a filtered result and a still image are failed jobs with no artifact', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const cases = [
    ['operation failure', /provider reported an error/],
    ['filtered', /filtered this generation/],
    ['no samples', /no video URI/],
    ['still image', /validation failed/],
  ]
  for (const [prompt, pattern] of cases) {
    const created = await f.request('POST', '/api/video/generate', { prompt, model: 'veo-3.1-generate-preview' })
    assert.equal(created.status, 202, JSON.stringify(created.data))
    const job = await f.waitFor(created.data.id)
    assert.equal(job.state, JOB_STATES.FAILED, `${prompt}: ${JSON.stringify(job)}`)
    assert.equal(job.artifact, null)
    assert.match(job.error, pattern, prompt)
    assert.equal((await f.request('GET', `/api/video/jobs/${job.id}/content`)).status, 404)
  }
})

test('video prompts, aspect ratios, resolutions and models are validated before a job exists', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const cases = [
    [{ prompt: '' }, 400, 'invalid_prompt'],
    [{ prompt: 'x'.repeat(4001) }, 400, 'invalid_prompt'],
    [{ prompt: 'ok', aspectRatio: '1:1' }, 400, 'invalid_parameters'],
    [{ prompt: 'ok', resolution: '4k' }, 400, 'invalid_parameters'],
    [{ prompt: 'ok', model: 'not-listed' }, 409, 'model_unavailable'],
  ]
  for (const [body, status, code] of cases) {
    const r = await f.request('POST', '/api/video/generate', { model: 'veo-3.1-generate-preview', ...body })
    assert.equal(r.status, status, `${JSON.stringify(body)}: ${JSON.stringify(r.data)}`)
    assert.equal(r.data.error, code)
  }
  assert.equal(f.calls.filter((call) => call.path.endsWith(':predictLongRunning')).length, 0)
})

test('a running video job can be cancelled, and cancellation is not a success', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const created = await f.request('POST', '/api/video/generate', { prompt: 'slow', model: 'veo-3.1-generate-preview' })
  assert.equal(created.status, 202)
  // Wait until the provider has actually been polled; cancelling before the run starts would
  // test the queue's pre-start path instead of an abort of a live request.
  for (let i = 0; i < 200 && f.polls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(f.polls > 0, 'the job never reached the provider')
  const cancelled = await f.request('POST', `/api/video/jobs/${created.data.id}/cancel`, {})
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data))
  assert.equal(cancelled.data.cancelled, true)
  const job = await f.waitFor(created.data.id)
  assert.equal(job.state, JOB_STATES.CANCELLED)
  assert.equal(job.artifact, null)
})

test('a file URI on another host is fetched without the API key, and a redirect is refused', async (t) => {
  const f = await fixture(t)
  await f.configure()
  const created = await f.request('POST', '/api/video/generate', { prompt: 'foreign', model: 'veo-3.1-generate-preview' })
  const job = await f.waitFor(created.data.id)
  assert.equal(job.state, JOB_STATES.SUCCEEDED, JSON.stringify(job))
  const call = f.foreignCalls.at(-1)
  assert.equal(call.headers['x-goog-api-key'], undefined, 'the credential must not follow a provider-supplied host')

  const redirected = await f.request('POST', '/api/video/generate', { prompt: 'redirect', model: 'veo-3.1-generate-preview' })
  const failed = await f.waitFor(redirected.data.id)
  assert.equal(failed.state, JOB_STATES.FAILED)
  assert.match(failed.error, /HTTP 302/)
})

test('the transport can return binary bytes and still enforces its per-call ceiling', async (t) => {
  const f = await fixture(t)
  const gateway = new OnlineGateway({ trustedOrigins: [f.foreignUrl], timeoutMs: 3000, maxBytes: 1024 })
  const config = { id: 'veo', kind: 'veo', baseUrl: `${f.foreignUrl}/v1beta`, apiKey: KEY }
  const ok = await gateway.request(config, '/file.mp4', { binary: true, maxResponseBytes: 1024 * 1024 })
  assert.deepEqual(ok.bytes, MP4)
  await assert.rejects(
    gateway.request(config, '/file.mp4', { binary: true, maxResponseBytes: 1024 }),
    (error) => error.code === 'provider_response_too_large',
  )
})

test('probeMp4 measures duration and refuses a truncated or foreign container', () => {
  assert.equal(probeMp4(MP4).durationSeconds, 4)
  assert.equal(probeMp4(PNG), null)
  assert.equal(probeMp4(MP4.subarray(0, 40)), null)
  assert.equal(probeMp4(Buffer.alloc(0)), null)
})

test('a video job with no state path still succeeds and is listed by kind', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-video-queue-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const queue = new MediaJobQueue({ storageDir: join(dir, 'media') })
  const created = queue.enqueue({ kind: 'video', run: async () => ({ video: MP4, model: 'veo-test' }), timeoutMs: 5000 })
  const job = await queue.waitFor(created.id)
  assert.equal(job.state, JOB_STATES.SUCCEEDED)
  assert.equal(job.result.model, 'veo-test')
  assert.equal(queue.list({ kind: 'video' }).length, 1)
  assert.equal(queue.list({ kind: 'image' }).length, 0)
})
