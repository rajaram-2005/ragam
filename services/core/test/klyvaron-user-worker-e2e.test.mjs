// The formerly exposed local training/worker API is intentionally retired: Klyvaron tiers are
// resource profiles of one model-independent processor, and user-authorized data belongs in
// knowledge and memory. This integration guard prevents legacy worker routes from being revived.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OnlineApp } from '../src/online/app.mjs'

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
