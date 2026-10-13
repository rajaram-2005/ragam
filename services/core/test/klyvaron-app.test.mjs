// Klyvaron Lite as the app actually uses it: installed, loaded, routed, refused.
//
// The pieces are tested separately elsewhere -- the runtime against NumPy, the store
// against a real filesystem, the provider against its own contract. This file is about
// the joins, because the joins are where an honesty property usually dies: a base
// completion model that is loadable, routable and reachable from `/api/chat` will answer
// a question unless something explicitly says no. Here that "no" is exercised over real
// HTTP, together with the escape hatch that keeps the model usable.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AetherisOmniApp, createHttpServer } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { RUNTIME_POLICIES } from '../src/policy/egress.mjs'
import { CATEGORIES, MobileStorageBudget } from '../src/storage/budget.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-parity.json', import.meta.url), 'utf8'))
const ARTIFACT_ID = fixture.manifest.id

/** Install the parity artifact the way an operator would: files under the managed root. */
function installFixture(dataDir) {
  const budget = new MobileStorageBudget({ root: join(dataDir, 'klyvaron') })
  const directory = join(budget.pathFor(CATEGORIES.MODEL_WEIGHTS), ARTIFACT_ID)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, fixture.manifest.weights.file), Buffer.from(fixture.npzBase64, 'base64'))
  writeFileSync(join(directory, `${ARTIFACT_ID}.klyvaron.json`), JSON.stringify(fixture.manifest, null, 2))
  return directory
}

async function startCore({ install = true, env = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aetheris-klyvaron-'))
  if (install) installFixture(dataDir)
  const config = loadConfig({
    AETHERIS_RUNTIME_POLICY: RUNTIME_POLICIES.STRICT_OFFLINE,
    AETHERIS_DATA_DIR: dataDir,
    OLLAMA_ENABLED: 'false',
    LLAMACPP_ENABLED: 'false',
    ...env,
  })
  const app = new AetherisOmniApp({ config })
  const server = createHttpServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const response = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    return { status: response.status, json: text ? JSON.parse(text) : null, text }
  }
  return { dataDir, app, call, baseUrl, close: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(dataDir, { recursive: true, force: true }) } }
}

test('an installed artifact is loaded at startup, and readiness reports it honestly', async () => {
  const core = await startCore()
  try {
    const ready = await core.call('GET', '/api/ready')
    assert.equal(ready.status, 200)
    assert.equal(ready.json.status, 'ready')
    assert.equal(ready.json.klyvaron.loaded.length, 1)
    const loaded = ready.json.klyvaron.loaded[0]
    assert.equal(loaded.instructionTuned, false)
    assert.deepEqual(loaded.limitations, fixture.manifest.limitations)
    assert.equal(loaded.weightsSha256, fixture.manifest.weights.sha256)
    assert.ok(loaded.loadMs >= 0)

    // The app must not claim a chat capability it does not have. It has completion.
    assert.equal(ready.json.capabilities.chat, false, 'a base completion model is not a chat model')
    assert.equal(ready.json.capabilities.textCompletion, true)

    const models = await core.call('GET', '/api/models')
    const model = models.json.models.find((entry) => entry.id === `klyvaron:${ARTIFACT_ID}`)
    assert.ok(model, 'the loaded model must appear in the routing table')
    assert.equal(model.location, 'local')
    assert.ok(model.tags.includes('base_completion'))
    assert.equal(model.contextWindow, fixture.manifest.architecture.seq_len)
    assert.equal(model.measured.availability, 'ready', 'loaded and verified is the only reason it may be ready')
  } finally {
    await core.close()
  }
})

test('an ordinary chat request is refused, and the refusal carries the model’s own words', async () => {
  const core = await startCore()
  try {
    const response = await core.call('POST', '/api/chat', { messages: [{ role: 'user', content: 'What is the capital of France?' }] })
    assert.equal(response.status, 501)
    assert.equal(response.json.error, 'model_not_instruction_tuned')
    assert.match(response.json.message, /base completion model/)
    assert.deepEqual(response.json.limitations, fixture.manifest.limitations)

    // Pinning it by id is an explicit choice, so it is allowed -- and the response says
    // what the text is, rather than presenting a continuation as an answer.
    const pinned = await core.call('POST', '/api/chat', {
      messages: [{ role: 'user', content: 'Aetheris' }],
      model: `klyvaron:${ARTIFACT_ID}`,
      maxTokens: 8,
      // Greedy, so the text can be compared with what NumPy produced for the same
      // weights rather than merely being some continuation.
      temperature: 0,
    })
    assert.equal(pinned.status, 200)
    assert.equal(pinned.json.text, fixture.greedy[0].text.slice(0, 8))
    assert.equal(pinned.json.instructionTuned, false)
    assert.match(pinned.json.limitation, /does not follow instructions/)
    assert.equal(pinned.json.modelId, `klyvaron:${ARTIFACT_ID}`)
    assert.equal(pinned.json.sentExternally, false)
    assert.equal(pinned.json.usage.completionTokens, 8)
  } finally {
    await core.close()
  }
})

test('the streaming path refuses the same request the same way', async () => {
  const core = await startCore()
  try {
    // Server-sent events cannot carry an HTTP error status once the stream has begun, so
    // the refusal arrives as an `error` event. It must still be the same code and the
    // same message as the non-streaming refusal, or a client would have two behaviours
    // to handle and one of them would be wrong.
    const response = await fetch(`${core.baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'What is the capital of France?' }] }),
    })
    const text = await response.text()
    assert.match(text, /event: error/)
    assert.match(text, /model_not_instruction_tuned/)
    assert.match(text, /base completion model/)
  } finally {
    await core.close()
  }
})

test('the storage surface reports real bytes, verification, and what is loaded', async () => {
  const core = await startCore()
  try {
    const storage = await core.call('GET', '/api/storage')
    assert.equal(storage.status, 200)
    assert.ok(storage.json.installed.length === 1)
    assert.equal(storage.json.installed[0].id, ARTIFACT_ID)
    assert.ok(storage.json.installed[0].bytes >= fixture.manifest.weights.bytes)
    assert.deepEqual(storage.json.verification, [{ id: ARTIFACT_ID, version: fixture.manifest.version, ok: true, problems: [] }])
    assert.match(storage.json.summary.text, /Aetheris is using/)
    assert.equal(storage.json.withinBudget, true)
    assert.ok(storage.json.headroomBytes > 0)
  } finally {
    await core.close()
  }
})

test('a corrupted install is reported as broken rather than loaded or deleted', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aetheris-klyvaron-broken-'))
  const directory = installFixture(dataDir)
  const weights = join(directory, fixture.manifest.weights.file)
  const bytes = readFileSync(weights)
  bytes[0] ^= 0xff
  writeFileSync(weights, bytes)

  const config = loadConfig({ AETHERIS_DATA_DIR: dataDir, OLLAMA_ENABLED: 'false', LLAMACPP_ENABLED: 'false' })
  const app = new AetherisOmniApp({ config })
  try {
    assert.deepEqual(app.klyvaron.loaded, [])
    assert.equal(app.klyvaron.errors.length, 1)
    assert.equal(app.klyvaron.errors[0].code, 'digest_mismatch')
    // The bytes are still on disk: a failed verification is not a licence to delete a
    // user's download.
    assert.ok(readFileSync(weights).length > 0)
    const ready = app.readiness()
    assert.equal(ready.status, 'degraded')
    assert.equal(ready.capabilities.chat, false)
    assert.equal(ready.capabilities.textCompletion, false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('with no artifact installed the app still starts, and says so', async () => {
  const core = await startCore({ install: false })
  try {
    const ready = await core.call('GET', '/api/ready')
    assert.equal(ready.status, 200)
    assert.equal(ready.json.klyvaron.loaded.length, 0)
    assert.equal(ready.json.klyvaron.broken.length, 0)
    const chat = await core.call('POST', '/api/chat', { messages: [{ role: 'user', content: 'hello' }] })
    assert.equal(chat.status, 503)
    assert.equal(chat.json.error, 'no_model_available')
  } finally {
    await core.close()
  }
})
