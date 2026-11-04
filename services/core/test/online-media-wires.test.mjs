// Contract tests for the native media wires added for the online-only architecture.
//
// Every vendor here is a *shape*, not a live service: a local function or a local HTTP server
// returns the response the vendor's documentation publishes, and the bytes are real containers
// (a 1×1 PNG and a 9 KB ISO-BMFF file with a measurable duration). The tests assert the request
// this build actually sends, the credential header it uses, and — the invariant that matters most
// for secrets — that a provider-supplied delivery/polling URL never receives the key unless it is
// on the exact configured API origin.
//
// The final test drives the real routes with two saved connections, proving that the Image and
// Video areas follow the wire's modality and the connection's own controls, not a hard-coded
// vendor id.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OnlineApp } from '../src/online/app.mjs'
import { JOB_STATES } from '../src/media/jobs.mjs'
import { wireFor, IMPLEMENTED } from '../src/providers/wires/index.mjs'
import { readCredential } from '../src/providers/wires/firefly-images.mjs'

const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)))
const close = (server) => new Promise((done) => { server.closeAllConnections(); server.close(done) })

const KEY = 'synthetic-media-key'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg==', 'base64')
const box = (type, payload) => {
  const out = Buffer.alloc(8 + payload.length)
  out.writeUInt32BE(out.length, 0)
  out.write(type, 4, 'latin1')
  payload.copy(out, 8)
  return out
}
const MP4 = (() => {
  const ftyp = box('ftyp', Buffer.from('isom0000isommp42', 'latin1'))
  const mvhd = Buffer.alloc(100)
  mvhd.writeUInt8(0, 0)
  mvhd.writeUInt32BE(1000, 12)
  mvhd.writeUInt32BE(4000, 16)
  return Buffer.concat([ftyp, box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(9_000, 1))])
})()

/** A transport that records every call and answers from a function. */
function recorder(answer) {
  const calls = []
  const transport = async (config, path, options = {}) => {
    calls.push({ config, path, options })
    const value = await answer({ config, path, options, calls })
    if (value === undefined) throw new Error(`unexpected request ${config.baseUrl}${path}`)
    return value
  }
  return { calls, transport }
}

const WIRE_FOR_PROVIDER = Object.freeze({
  stability: 'stability_images',
  recraft: 'recraft_images',
  ideogram: 'ideogram_images',
  'black-forest-labs': 'bfl_images',
  fal: 'fal_images',
  'fal-video': 'fal_video',
  replicate: 'replicate_images',
  'replicate-video': 'replicate_video',
  runway: 'runway_video',
  luma: 'luma_video',
  firefly: 'firefly_images',
})
const configFor = (id, baseUrl, extra = {}) => ({
  id, kind: id, baseUrl, apiKey: KEY, wire: WIRE_FOR_PROVIDER[id], ...extra,
})

const isForeignPollingRefusal = (error) => error?.code === 'invalid_completion'
  && /configured API origin|invalid .*URL|credential/i.test(error.message)

test('the media wire registry names a modality, a credential kind and a non-empty model list', () => {
  const expected = {
    stability_images: ['image', 'api_key'],
    recraft_images: ['image', 'api_key'],
    ideogram_images: ['image', 'api_key'],
    bfl_images: ['image', 'api_key'],
    fal_images: ['image', 'api_key'],
    fal_video: ['video', 'api_key'],
    replicate_images: ['image', 'api_key'],
    replicate_video: ['video', 'api_key'],
    runway_video: ['video', 'api_key'],
    luma_video: ['video', 'api_key'],
    firefly_images: ['image', 'client_credentials'],
    comfyui_images: ['image', 'none'],
  }
  for (const [name, [modality, credential]] of Object.entries(expected)) {
    assert.ok(IMPLEMENTED.includes(name), `${name} must be registered`)
    const wire = wireFor(name)
    assert.equal(wire.modality, modality, name)
    assert.equal(wire.credential, credential, name)
    assert.ok(typeof wire.generate === 'function', name)
    assert.ok(Array.isArray(wire.SIZES) || Array.isArray(wire.ASPECT_RATIOS), `${name} must publish its controls`)
  }
  assert.equal(wireFor('replicate_images').SIZES.length, 0, 'no common size input across Replicate image models')
  assert.equal(wireFor('replicate_video').ASPECT_RATIOS.length, 0)
  assert.equal(wireFor('runway_video').RESOLUTIONS.length, 0, 'Runway does not document a resolution input here')
})

test('ComfyUI discovers installed checkpoints, submits a bounded stock workflow and validates the output path', async () => {
  const calls = []
  let historyReads = 0
  const transport = async (config, path, options = {}) => {
    calls.push({ config, path, options })
    if (path === '/object_info/CheckpointLoaderSimple') {
      return { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl-base.safetensors']] } } } }
    }
    if (path === '/prompt') return { prompt_id: 'prompt_123' }
    if (path === '/history/prompt_123') {
      historyReads += 1
      return historyReads === 1 ? {} : { prompt_123: { outputs: { '9': { images: [{ filename: 'ragam_00001_.png', subfolder: '', type: 'output' }] } } } }
    }
    if (path.startsWith('/view?') && options.binary) return { bytes: PNG, contentType: 'image/png' }
    return undefined
  }
  const config = { id: 'comfyui', kind: 'comfyui', wire: 'comfyui_images', baseUrl: 'http://comfyui:8188', apiKey: null }
  assert.deepEqual(await wireFor('comfyui_images').models(transport, config), ['sdxl-base.safetensors'])
  const hardwareTransport = recorder(() => ({
    system: { os: 'Windows', argv: ['private-launch-argument'], ram_total: 999 },
    devices: [
      { name: 'NVIDIA GeForce RTX fixture', type: 'cuda', vram_total: 12 * 1024 ** 3, vram_free: 10 * 1024 ** 3 },
      { name: 'AMD Radeon fixture', type: 'rocm', vram_total: 8 * 1024 ** 3, vram_free: 6 * 1024 ** 3 },
    ],
  }))
  const detected = await wireFor('comfyui_images').systemInfo(hardwareTransport.transport, config)
  assert.equal(hardwareTransport.calls[0].path, '/system_stats')
  assert.deepEqual(detected.devices, [
    { index: 0, name: 'NVIDIA GeForce RTX fixture', backend: 'cuda', vramTotalBytes: 12 * 1024 ** 3, vramFreeBytes: 10 * 1024 ** 3 },
    { index: 1, name: 'AMD Radeon fixture', backend: 'rocm', vramTotalBytes: 8 * 1024 ** 3, vramFreeBytes: 6 * 1024 ** 3 },
  ])
  assert.equal('system' in detected, false, 'OS, RAM, argv and paths are not exposed')
  await assert.rejects(
    wireFor('comfyui_images').systemInfo(async () => ({ devices: 'not a list' }), config),
    (error) => error.code === 'invalid_hardware_report',
  )
  const result = await wireFor('comfyui_images').generate(transport, config, {
    model: 'sdxl-base.safetensors', prompt: 'A green glass bird', size: '768x512',
    poll: { initialMs: 1, factor: 1, maxMs: 1, attempts: 3 },
  })
  assert.deepEqual(result.bytes, PNG)
  assert.equal(result.model, 'sdxl-base.safetensors')
  assert.equal(result.operation, 'prompt_123')
  const submit = calls.find((call) => call.path === '/prompt')
  assert.equal(submit.options.headers.authorization, undefined, 'ComfyUI has no credential by default')
  assert.deepEqual(submit.options.body.prompt['4'].inputs, { ckpt_name: 'sdxl-base.safetensors' })
  assert.deepEqual(submit.options.body.prompt['5'].inputs, { width: 768, height: 512, batch_size: 1 })
  assert.equal(submit.options.body.prompt['6'].inputs.text, 'A green glass bird')
  assert.equal(calls.find((call) => call.path.startsWith('/view?')).path, '/view?filename=ragam_00001_.png&subfolder=&type=output')
  assert.equal(calls.at(-1).options.maxResponseBytes, 24 * 1024 * 1024)

  const unsafe = recorder(({ path }) => path === '/prompt' ? { prompt_id: 'prompt_123' }
    : path === '/history/prompt_123' ? { prompt_123: { outputs: { '9': { images: [{ filename: '../secrets.png', subfolder: '', type: 'output' }] } } } }
      : undefined)
  await assert.rejects(wireFor('comfyui_images').generate(unsafe.transport, config, {
    model: 'sdxl-base.safetensors', prompt: 'p',
    poll: { initialMs: 1, factor: 1, maxMs: 1, attempts: 1 },
  }), (error) => error.code === 'invalid_completion')
})

test('the Stability wire posts multipart, asks for image bytes, and rejects anything else', async () => {
  const { calls, transport } = recorder(({ options }) => options.binary
    ? { bytes: PNG, contentType: 'image/png' }
    : undefined)
  const config = configFor('stability', 'https://api.stability.ai')
  const result = await wireFor('stability_images').generate(transport, config, { model: 'core', prompt: 'a red circle', size: '1536x1024' })
  assert.deepEqual(result.bytes, PNG)
  assert.equal(result.model, 'core')
  const sent = calls.at(-1)
  assert.equal(sent.path, '/v2beta/stable-image/generate/core')
  assert.equal(sent.options.headers.authorization, `Bearer ${KEY}`)
  assert.equal(sent.options.headers.accept, 'image/*')
  assert.match(sent.options.contentType, /^multipart\/form-data; boundary=/)
  assert.match(sent.options.body, /name="prompt"\r\n\r\na red circle/)
  assert.match(sent.options.body, /name="output_format"\r\n\r\npng/)
  assert.match(sent.options.body, /name="aspect_ratio"\r\n\r\n3:2/)
  assert.equal(sent.options.maxResponseBytes, 24 * 1024 * 1024)

  await assert.rejects(
    wireFor('stability_images').generate(transport, config, { model: 'sd3.5-large', prompt: 'p', size: '512x512' }),
    (error) => error.code === 'invalid_parameters',
  )
  await assert.rejects(
    wireFor('stability_images').generate(transport, config, { model: 'not-a-model', prompt: 'p' }),
    (error) => error.code === 'invalid_model',
  )
  const text = recorder(({ options }) => options.binary ? { bytes: Buffer.from('not a png'), contentType: 'image/png' } : undefined)
  await assert.rejects(
    wireFor('stability_images').generate(text.transport, config, { model: 'core', prompt: 'p' }),
    (error) => error.code === 'invalid_response',
  )
})

test('the Recraft wire requests inline base64 and refuses a URL-only answer', async () => {
  const { calls, transport } = recorder(() => ({ data: [{ b64_json: PNG.toString('base64') }], credits: 7, model: 'recraftv4_1' }))
  const config = configFor('recraft', 'https://external.api.recraft.ai/v1')
  const result = await wireFor('recraft_images').generate(transport, config, { model: 'recraftv4_1', prompt: 'a circle', size: '1024x1024' })
  assert.deepEqual(result.bytes, PNG)
  assert.deepEqual(result.usage, 7)
  const sent = calls.at(-1)
  assert.equal(sent.path, '/images/generations')
  assert.equal(sent.options.headers.authorization, `Bearer ${KEY}`)
  assert.equal(sent.options.body.response_format, 'b64_json')
  assert.equal(sent.options.body.image_format, 'png')
  assert.equal(sent.options.body.size, '1024x1024')
  assert.equal(sent.options.body.n, 1)

  const urlOnly = recorder(() => ({ data: [{ url: 'https://example.invalid/x.png' }] }))
  await assert.rejects(
    wireFor('recraft_images').generate(urlOnly.transport, config, { model: 'recraftv4_1', prompt: 'p' }),
    (error) => error.code === 'invalid_completion' && /inline image/.test(error.message),
  )
})

test('the Ideogram wire sends Api-Key multipart and handles both synchronous and asynchronous results', async () => {
  let phase = 0
  let generated = 0
  const { calls, transport } = recorder(({ path, options }) => {
    if (path === '/v2/image/generate/ideogram-4-5') {
      generated += 1
      return generated === 1
        ? { data: [{ url: 'https://ideogram.ai/files/sync.png', prompt: 'improved' }] }
        : { generation_id: 'gen-1', status: 'pending' }
    }
    if (path === '/v2/generations/gen-1') {
      phase += 1
      return phase === 1 ? { generation_id: 'gen-1', status: 'pending' } : { generation_id: 'gen-1', status: 'completed', data: [{ url: 'https://ideogram.ai/files/async.png' }], usage_cost_usd_micros: 1200 }
    }
    if (options.binary && path === '/files/sync.png') return { bytes: PNG, contentType: 'image/png' }
    if (options.binary && path === '/files/async.png') return { bytes: PNG, contentType: 'image/png' }
    return undefined
  })
  const config = configFor('ideogram', 'https://api.ideogram.ai')
  const sync = await wireFor('ideogram_images').generate(transport, config, { model: 'ideogram-4-5', prompt: 'a circle', size: '1024x1024' })
  assert.deepEqual(sync.bytes, PNG)
  assert.equal(sync.revisedPrompt, 'improved')
  const sent = calls.at(-2)
  assert.equal(sent.options.headers['Api-Key'], KEY)
  assert.match(sent.options.contentType, /^multipart\/form-data/)
  assert.match(sent.options.body, /name="size"\r\n\r\n1024x1024/)
  assert.equal(calls.at(-1).options.headers['Api-Key'], undefined, 'the delivery host does not receive the key')

  const asyncResult = await wireFor('ideogram_images').generate(transport, config, { model: 'ideogram-4-5', prompt: 'a circle' })
  assert.deepEqual(asyncResult.bytes, PNG)
  assert.deepEqual(asyncResult.usage, { usdMicros: 1200 })
})

test('the FLUX wire polls the provider-supplied URL and never sends x-key to the delivery host', async () => {
  const delivery = []
  const { calls, transport } = recorder(({ config, path, options }) => {
    if (path === '/v1/flux-2-pro') return { id: 'op-1', polling_url: 'https://api.bfl.ai/v1/get_result?id=op-1' }
    if (path === '/v1/get_result?id=op-1') return { status: 'Ready', result: { sample: 'https://delivery.bfl.ai/signed.png' } }
    if (config.baseUrl === 'https://delivery.bfl.ai' && options.binary) {
      delivery.push({ path, headers: options.headers })
      return { bytes: PNG, contentType: 'image/png' }
    }
    return undefined
  })
  const config = configFor('black-forest-labs', 'https://api.bfl.ai')
  const result = await wireFor('bfl_images').generate(transport, config, { model: 'flux-2-pro', prompt: 'a circle', size: '1536x1024' })
  assert.deepEqual(result.bytes, PNG)
  assert.equal(result.operation, 'op-1')
  const submit = calls.find((call) => call.path === '/v1/flux-2-pro')
  assert.equal(submit.options.headers['x-key'], KEY)
  assert.deepEqual(submit.options.body, { prompt: 'a circle', output_format: 'png', width: 1536, height: 1024 })
  assert.equal(delivery.length, 1)
  assert.equal(delivery[0].headers['x-key'], undefined, 'the signed delivery URL needs no credential')
  assert.equal(delivery[0].headers.authorization, undefined)

  const foreign = recorder(() => ({ id: 'op-2', polling_url: 'https://attacker.example/steal' }))
  await assert.rejects(
    wireFor('bfl_images').generate(foreign.transport, config, { model: 'flux-2-pro', prompt: 'p' }),
    isForeignPollingRefusal,
  )
})

test('the fal wires use the queue contract, poll their own URLs and keep the key off the CDN', async () => {
  const made = []
  const answer = ({ config, path, options }) => {
    if (config.baseUrl === 'https://queue.fal.run') {
      if (path === '/fal-ai/flux/dev') return { request_id: 'req-1', status_url: 'https://queue.fal.run/fal-ai/flux/dev/requests/req-1/status', response_url: 'https://queue.fal.run/fal-ai/flux/dev/requests/req-1', cancel_url: 'https://queue.fal.run/fal-ai/flux/dev/requests/req-1/cancel' }
      if (path.endsWith('/status')) return { status: 'COMPLETED' }
      if (path === '/fal-ai/flux/dev/requests/req-1') return { images: [{ url: 'https://fal.media/files/x.png' }] }
    }
    if (config.baseUrl === 'https://queue.fal.run' && path === '/fal-ai/veo3.1') {
      return { request_id: 'req-2', status_url: 'https://queue.fal.run/fal-ai/veo3.1/requests/req-2/status', response_url: 'https://queue.fal.run/fal-ai/veo3.1/requests/req-2' }
    }
    if (config.baseUrl === 'https://queue.fal.run' && path === '/fal-ai/veo3.1/requests/req-2/status') return { status: 'COMPLETED' }
    if (config.baseUrl === 'https://queue.fal.run' && path === '/fal-ai/veo3.1/requests/req-2') return { video: { url: 'https://fal.media/files/x.mp4' } }
    if (config.baseUrl === 'https://fal.media') {
      made.push({ path, headers: options.headers })
      return { bytes: path.endsWith('.mp4') ? MP4 : PNG, contentType: path.endsWith('.mp4') ? 'video/mp4' : 'image/png' }
    }
    return undefined
  }
  const { transport } = recorder(answer)
  const image = await wireFor('fal_images').generate(transport, configFor('fal', 'https://queue.fal.run'), { model: 'fal-ai/flux/dev', prompt: 'a circle', size: '1024x1024' })
  assert.deepEqual(image.bytes, PNG)
  const video = await wireFor('fal_video').generate(transport, configFor('fal-video', 'https://queue.fal.run'), { model: 'fal-ai/veo3.1', prompt: 'a wave', aspectRatio: '16:9', resolution: '1080p' })
  assert.deepEqual(video.video, MP4)
  assert.equal(made.length, 2)
  for (const call of made) {
    assert.equal(call.headers.authorization, undefined, 'the CDN is not the API origin')
  }
})

test('the Replicate wires poll the prediction URL and download output without the token', async () => {
  const deliveries = []
  const answer = ({ config, path, options }) => {
    if (path === '/models/google/veo-3/predictions') {
      return { id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1', cancel: 'https://api.replicate.com/v1/predictions/p1/cancel' } }
    }
    if (path === '/v1/predictions/p1') return { id: 'p1', status: 'succeeded', model: 'google/veo-3', output: ['https://replicate.delivery/pbxt/x.mp4'] }
    if (config.baseUrl === 'https://replicate.delivery') {
      deliveries.push({ path, headers: options.headers })
      return { bytes: MP4, contentType: 'video/mp4' }
    }
    return undefined
  }
  const { transport } = recorder(answer)
  const result = await wireFor('replicate_video').generate(transport, configFor('replicate-video', 'https://api.replicate.com/v1'), { model: 'google/veo-3', prompt: 'a wave' })
  assert.deepEqual(result.video, MP4)
  assert.equal(result.model, 'google/veo-3')
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].headers.authorization, undefined)

  const failing = recorder(({ path }) => path.endsWith('/predictions')
    ? { id: 'p2', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p2' } }
    : { id: 'p2', status: 'failed', error: 'model crashed' })
  await assert.rejects(
    wireFor('replicate_images').generate(failing.transport, configFor('replicate', 'https://api.replicate.com/v1'), { model: 'black-forest-labs/flux-schnell', prompt: 'p' }),
    (error) => error.code === 'provider_error' && /model crashed/.test(error.message),
  )
})

test('the Runway wire sends the documented headers and polls a task to a real clip', async () => {
  const { calls, transport } = recorder(({ config, path, options }) => {
    if (path === '/v1/text_to_video') return { id: 'task-1' }
    if (path === '/v1/tasks/task-1') return { status: 'SUCCEEDED', output: ['https://cdn.runwayml.com/task-1.mp4'] }
    if (config.baseUrl === 'https://cdn.runwayml.com' && options.binary) return { bytes: MP4, contentType: 'video/mp4' }
    return undefined
  })
  const config = configFor('runway', 'https://api.dev.runwayml.com')
  const result = await wireFor('runway_video').generate(transport, config, { model: 'gen4.5', prompt: 'a wave', aspectRatio: '16:9' })
  assert.deepEqual(result.video, MP4)
  assert.equal(result.platform, 'Runway')
  assert.equal(result.resolution, null)
  const submit = calls.find((call) => call.path === '/v1/text_to_video')
  assert.equal(submit.options.headers['x-runway-version'], '2024-11-06')
  assert.equal(submit.options.body.ratio, '1280:720')
  assert.equal(submit.options.body.duration, 5)
  const veo = recorder(({ config, path, options }) => {
    if (path === '/v1/text_to_video') return { id: 'task-2' }
    if (path === '/v1/tasks/task-2') return { status: 'SUCCEEDED', output: ['https://cdn.runwayml.com/task-2.mp4'] }
    if (config.baseUrl === 'https://cdn.runwayml.com' && options.binary) return { bytes: MP4, contentType: 'video/mp4' }
    return undefined
  })
  await wireFor('runway_video').generate(veo.transport, config, { model: 'veo3.1', prompt: 'p' })
  const veoSubmit = veo.calls.find((call) => call.path === '/v1/text_to_video')
  assert.equal(veoSubmit.options.body.duration, undefined, 'Veo models have their own durations')
})

test('the Luma wire posts a documented generation and downloads the completed clip', async () => {
  const { calls, transport } = recorder(({ config, path, options }) => {
    if (path === '/generations') return { id: 'gen-1' }
    if (path === '/generations/gen-1') return { state: 'completed', model: 'ray-2', assets: { video: 'https://cdn.lumalabs.ai/gen-1.mp4' } }
    if (config.baseUrl === 'https://cdn.lumalabs.ai' && options.binary) return { bytes: MP4, contentType: 'video/mp4' }
    return undefined
  })
  const result = await wireFor('luma_video').generate(transport, configFor('luma', 'https://api.lumalabs.ai/dream-machine/v1'), { model: 'ray-2', prompt: 'a wave', aspectRatio: '9:16', resolution: '1080p' })
  assert.deepEqual(result.video, MP4)
  assert.equal(result.platform, 'Luma AI')
  const submit = calls.find((call) => call.path === '/generations')
  assert.deepEqual(submit.options.body, { prompt: 'a wave', model: 'ray-2', aspect_ratio: '9:16', resolution: '1080p', duration: '5s' })
})

test('the Firefly wire exchanges the client credential for an IMS token and keeps it off the CDN', async () => {
  const client = { clientId: 'client-abc', clientSecret: 'secret-xyz' }
  assert.deepEqual(readCredential(JSON.stringify(client)), client)
  assert.throws(() => readCredential('no-json'), (error) => error.code === 'invalid_key')

  const deliveries = []
  const { calls, transport } = recorder(({ config, path, options }) => {
    if (config.baseUrl === 'https://ims-na1.adobelogin.com') return { access_token: 'ims-token', expires_in: 3600 }
    if (path === '/v3/images/generate') return { outputs: [{ image: { url: 'https://delivery.firefly.adobe.com/x.png' }, prompt: 'improved' }] }
    if (config.baseUrl === 'https://delivery.firefly.adobe.com') {
      deliveries.push({ path, headers: options.headers })
      return { bytes: PNG, contentType: 'image/png' }
    }
    return undefined
  })
  const config = configFor('firefly', 'https://firefly-api.adobe.io', { apiKey: JSON.stringify(client), wire: 'firefly_images' })
  const result = await wireFor('firefly_images').generate(transport, config, { model: 'image4', prompt: 'a circle', size: '1024x1024' })
  assert.deepEqual(result.bytes, PNG)
  assert.equal(result.revisedPrompt, 'improved')
  const tokenCall = calls.find((call) => call.config.baseUrl === 'https://ims-na1.adobelogin.com')
  assert.equal(tokenCall.path, '/ims/token/v3')
  assert.match(tokenCall.options.body, /grant_type=client_credentials/)
  assert.match(tokenCall.options.body, /client_id=client-abc/)
  const generate = calls.find((call) => call.path === '/v3/images/generate')
  assert.equal(generate.options.headers['x-api-key'], 'client-abc')
  assert.equal(generate.options.headers.authorization, 'Bearer ims-token')
  assert.equal(generate.options.headers['x-model-version'], 'image4')
  assert.equal(deliveries[0].headers['x-api-key'], undefined, 'the delivery host never sees the client id or token')
  assert.equal(deliveries[0].headers.authorization, undefined)
})

test('the Image and Video areas route to the configured wire, not a hard-coded vendor', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ragam-media-wires-'))
  const calls = []
  let base
  let comfyHistoryReads = 0
  const vendor = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = null
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null } catch { /* binary/multipart payload */ }
    calls.push({ path: req.url, method: req.method, headers: req.headers, body })
    if (req.url === '/object_info/CheckpointLoaderSimple') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl-base.safetensors']] } } } }))
    }
    if (req.url === '/prompt') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ prompt_id: 'comfy-prompt-1' }))
    }
    if (req.url === '/history/comfy-prompt-1') {
      comfyHistoryReads += 1
      const result = comfyHistoryReads < 2 ? {} : { 'comfy-prompt-1': { outputs: { '9': { images: [{ filename: 'ragam_00001_.png', subfolder: '', type: 'output' }] } } } }
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(result))
    }
    if (req.url === '/view?filename=ragam_00001_.png&subfolder=&type=output') {
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG)
    }
    if (req.url === '/v2beta/stable-image/generate/core') {
      res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG)
    }
    if (req.url === '/v1/text_to_video') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'task-1' }))
    }
    if (req.url === '/v1/tasks/task-1') {
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ status: 'SUCCEEDED', output: [`${base}/clip.mp4`] }))
    }
    if (req.url === '/clip.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(MP4)
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  base = await listen(vendor)
  const app = new OnlineApp({ dataDir: dir, trustedOrigins: [base], timeoutMs: 3000, mediaPoll: { initialMs: 1, factor: 1, maxMs: 1, attempts: 3 } })
  const server = app.server()
  const url = await listen(server)
  const request = async (method, path, body) => {
    const payload = body !== undefined ? { localOnly: false, ...body } : body
    const response = await fetch(url + path, {
      method,
      headers: { cookie, ...(payload !== undefined ? { 'content-type': 'application/json', 'x-aetheris-request': '1' } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    let data
    try { data = JSON.parse(buffer.toString('utf8')) } catch { data = buffer.toString('utf8') }
    return { status: response.status, data, headers: response.headers }
  }
  let cookie = ''
  t.after(async () => { await close(server); await close(vendor); app.close(); rmSync(dir, { recursive: true, force: true }) })
  const registered = await fetch(url + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aetheris-request': '1' }, body: JSON.stringify({ email: 'owner@example.test', password: 'a-long-owner-password' }) })
  cookie = registered.headers.get('set-cookie').split(';')[0]

  const savedImage = await request('PUT', '/api/providers/stability', { baseUrl: base, apiKey: KEY })
  assert.equal(savedImage.status, 200, JSON.stringify(savedImage.data))
  const testedImage = await request('POST', '/api/providers/stability/test', {})
  assert.equal(testedImage.status, 200, JSON.stringify(testedImage.data))
  assert.deepEqual(testedImage.data.models, ['core', 'ultra', 'sd3.5-large', 'sd3.5-medium'])

  const savedVideo = await request('PUT', '/api/providers/runway', { baseUrl: base, apiKey: KEY })
  assert.equal(savedVideo.status, 200, JSON.stringify(savedVideo.data))
  const testedVideo = await request('POST', '/api/providers/runway/test', {})
  assert.equal(testedVideo.status, 200, JSON.stringify(testedVideo.data))

  const ready = await request('GET', '/api/ready')
  assert.equal(ready.status, 200)
  assert.equal(ready.data.capabilities.imageGeneration, true)
  assert.equal(ready.data.capabilities.videoGeneration, true)
  assert.equal(ready.data.media.image.connectionId, 'stability')
  assert.equal(ready.data.media.image.wire, 'stability_images')
  assert.ok(ready.data.media.image.sizes.includes('1024x1024'))
  assert.equal(ready.data.media.video.connectionId, 'runway')
  assert.equal(ready.data.media.video.wire, 'runway_video')
  assert.deepEqual(ready.data.media.video.resolutions, [])

  const image = await request('POST', '/api/image/generate', { prompt: 'a circle', model: 'core', size: '1024x1024' })
  assert.equal(image.status, 202, JSON.stringify(image.data))
  const video = await request('POST', '/api/video/generate', { prompt: 'a wave', model: 'gen4.5', aspectRatio: '16:9' })
  assert.equal(video.status, 202, JSON.stringify(video.data))

  const wait = async (kind, id) => {
    const deadline = Date.now() + 5000
    for (;;) {
      const user = kind === 'image' ? 'image' : 'video'
      const r = await request('GET', `/api/${user}/jobs/${id}`)
      assert.equal(r.status, 200, JSON.stringify(r.data))
      if (r.data.terminal) return r.data
      if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(r.data)}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const imageJob = await wait('image', image.data.id)
  assert.equal(imageJob.state, JOB_STATES.SUCCEEDED, JSON.stringify(imageJob))
  assert.equal(imageJob.artifact.format, 'png')
  assert.equal(imageJob.params.provider, 'stability')
  const videoJob = await wait('video', video.data.id)
  assert.equal(videoJob.state, JOB_STATES.SUCCEEDED, JSON.stringify(videoJob))
  assert.equal(videoJob.artifact.format, 'mp4')
  assert.equal(videoJob.params.provider, 'runway')

  // ComfyUI is a real selectable local adapter: no key is required, model discovery uses its
  // checkpoint API, and the image route executes and validates the actual returned PNG bytes.
  const removedStability = await request('DELETE', '/api/providers/stability', {})
  assert.equal(removedStability.status, 200)
  const savedComfy = await request('PUT', '/api/providers/comfyui', { baseUrl: base })
  assert.equal(savedComfy.status, 200, JSON.stringify(savedComfy.data))
  assert.equal(savedComfy.data.keyRequired, false)
  assert.equal(savedComfy.data.keyConfigured, false)
  const testedComfy = await request('POST', '/api/providers/comfyui/test', {})
  assert.equal(testedComfy.status, 200, JSON.stringify(testedComfy.data))
  assert.deepEqual(testedComfy.data.models, ['sdxl-base.safetensors'])
  const comfyReady = await request('GET', '/api/ready')
  assert.equal(comfyReady.data.media.image.connectionId, 'comfyui')
  assert.equal(comfyReady.data.media.image.wire, 'comfyui_images')
  assert.ok(comfyReady.data.media.image.sizes.includes('768x512'))
  const comfyImage = await request('POST', '/api/image/generate', {
    prompt: 'a small blue paper kite', model: 'sdxl-base.safetensors', size: '768x512', localOnly: true,
  })
  assert.equal(comfyImage.status, 202, JSON.stringify(comfyImage.data))
  const comfyJob = await wait('image', comfyImage.data.id)
  assert.equal(comfyJob.state, JOB_STATES.SUCCEEDED, JSON.stringify(comfyJob))
  assert.equal(comfyJob.params.provider, 'comfyui')
  assert.equal(comfyJob.params.model, 'sdxl-base.safetensors')
  const comfySubmit = calls.find((call) => call.path === '/prompt')
  assert.equal(comfySubmit.body.prompt['6'].inputs.text, 'a small blue paper kite')
  assert.equal(comfySubmit.body.prompt['4'].inputs.ckpt_name, 'sdxl-base.safetensors')
  assert.equal(comfySubmit.headers.authorization, undefined, 'the local service receives no unrelated vendor credential')
  assert.equal(calls.some((call) => call.path === '/interrupt'), false, 'cancellation must not interrupt another user’s ComfyUI job')

  // The multipart image request carried the credential. The clip URL here is the same origin as
  // the API, so carrying the key is permitted; the unit tests above prove a foreign delivery host
  // never receives one.
  const imageCall = calls.find((call) => call.path === '/v2beta/stable-image/generate/core')
  assert.equal(imageCall.headers.authorization, `Bearer ${KEY}`)
  assert.equal(imageCall.headers.accept, 'image/*', 'the gateway must preserve a wire-selected representation')
})
