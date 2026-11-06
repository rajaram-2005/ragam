// The formerly exposed local training/worker API is intentionally retired: Klyvaron tiers are
// resource profiles of one model-independent processor, and user-authorized data belongs in
// knowledge and memory. This integration guard prevents legacy worker routes from being revived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnlineApp } from '../src/online/app.mjs'
import { runWorkerExec } from '../src/klyvaron/worker-exec.mjs'

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'klyvaron-retired-worker-'))
  const app = new OnlineApp({ dataDir, secureCookie: false, cookieSameSite: 'lax' })
  const server = app.server()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let cookie = ''
  const request = async (method, path, body) => {
    const headers = { 'x-aetheris-request': '1' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(`${origin}${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    return { status: response.status, body: await response.json() }
  }
  const registration = await request('POST', '/api/auth/register', {
    email: 'owner@ragam.local', password: 'StrongOwnerPassword!2026',
  })
  assert.equal(registration.status, 201)
  t.after(async () => {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) })
    app.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { app, request }
}

test('retired model, qualification and worker routes fail closed without training or fallback', async (t) => {
  const { app, request } = await fixture(t)
  assert.equal(app.nativeKlyvaron.enableLegacyArtifacts, false)
  assert.equal(app.multimodalHost.enableLegacyArtifacts, false)
  assert.equal(app.nativeKlyvaron.providers.size, 0)

  const profile = await request('GET', '/api/klyvaron')
  assert.equal(profile.status, 200)
  assert.deepEqual(profile.body.tiers.map((tier) => tier.id), ['lite', 'pro', 'max'])
  assert.equal(profile.body.modelIndependentProcessor.modelRequired, false)
  assert.equal(profile.body.modelIndependentProcessor.weightsRequired, false)

  const retired = [
    ['GET', '/api/klyvaron/manifests'],
    ['GET', '/api/klyvaron/qualification'],
    ['POST', '/api/klyvaron/qualification/run'],
    ['GET', '/api/klyvaron/models'],
    ['POST', '/api/klyvaron/models/verify'],
    ['GET', '/api/klyvaron/worker'],
    ['POST', '/api/klyvaron/worker/pair/request'],
    ['POST', '/api/klyvaron/worker/execute'],
    ['POST', '/api/klyvaron/worker/start'],
  ]
  for (const [method, path] of retired) {
    const result = await request(method, path, method === 'GET' ? undefined : {})
    assert.equal(result.status, 410, `${method} ${path}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.error, 'model_independent_architecture')
  }
})

test('voice routes fail closed without claiming separate voice model weights', async (t) => {
  const { request } = await fixture(t)
  for (const path of ['/api/voice/synthesize', '/api/voice/transcribe']) {
    const result = await request('POST', path, { text: 'hello' })
    assert.equal(result.status, 410, `${path}: ${JSON.stringify(result.body)}`)
    assert.equal(result.body.error, 'capability_unavailable')
    assert.match(result.body.message, /No separate voice model weights are loaded/)
  }
})

test('optional Python worker cancellation starts no child on pre-abort and terminates a running child', async (t) => {
  // Regression: the job AbortSignal never reached the worker process. A
  // cancelled generation could keep computing, and a worker that ignored
  // SIGTERM could outlive its timeout. These checks use a real child process
  // but no model artifacts or provider credentials.
  const dir = mkdtempSync(join(tmpdir(), 'ragam-worker-cancel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'worker.mjs')
  const started = join(dir, 'started')
  const stopped = join(dir, 'stopped')
  writeFileSync(script, [
    "import { writeFileSync } from 'node:fs'",
    "import { readFile } from 'node:fs/promises'",
    "const spec = JSON.parse(await readFile(process.argv[3], 'utf8'))",
    "writeFileSync(spec.started, 'started')",
    "process.on('SIGTERM', () => { writeFileSync(spec.stopped, 'stopped'); process.exit(0) })",
    "setInterval(() => {}, 1000)",
  ].join('\n'))
  const spec = { started, stopped }
  const options = {
    pythonBinary: process.execPath,
    workerExecScript: script,
    timeoutMs: 5_000,
    killGraceMs: 200,
  }

  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    runWorkerExec('cancel-test', spec, { ...options, signal: preAborted.signal }),
    { code: 'aborted' },
  )
  assert.equal(existsSync(started), false, 'a pre-aborted job must not start a child')

  const controller = new AbortController()
  const pending = runWorkerExec('cancel-test', spec, { ...options, signal: controller.signal })
  const deadline = Date.now() + 5_000
  while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(existsSync(started), 'the worker child started')
  controller.abort()
  await assert.rejects(pending, { code: 'aborted' })
  assert.ok(existsSync(stopped), 'SIGTERM reached the running child before the promise settled')
})

test('optional Python worker spawn failures settle with a coded error', async () => {
  const missing = join(tmpdir(), `ragam-missing-python-${process.pid}-${Date.now()}`)
  await assert.rejects(
    runWorkerExec('spawn-test', {}, { pythonBinary: missing, workerExecScript: missing, timeoutMs: 1_000 }),
    { code: 'multimodal_exec_failed' },
  )
})
