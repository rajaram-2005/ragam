/**
 * Compatibility tests for archived Klyvaron artifacts and isolated local-worker tooling.
 *
 * Active Klyvaron uses one deterministic processor with Lite/Pro/Max resource profiles; these
 * artifact/worker fixtures are not loaded by the application or required for desktop packaging.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OnlineApp } from '../src/online/app.mjs'
import { createLocalWorkerServer } from '../src/klyvaron/local-worker.mjs'
import { UserTrainingController, TRAINING_MODES } from '../src/klyvaron/training-controller.mjs'
import {
  KLYVARON,
  PRODUCT_SUBSCRIPTION_TIERS,
  KLYVARON_MODEL_IDENTITIES,
  RUNTIME_READINESS_STATES,
  deriveRuntimeCapabilityReadiness,
  familyReport,
  ownedArtifacts,
  tierClaimFor,
} from '../src/klyvaron/tiers.mjs'
import { developmentPlan } from '../src/klyvaron/plan.mjs'
import { MEDIA_KINDS, assertGenuineVideo, probeMp4, validateMedia } from '../src/media/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const LIVE_MODELS_DIR = join(REPO_ROOT, '.aetheris-data', 'online', 'klyvaron', 'models')

const ALL_EIGHT_MODELS = [
  'klyvaron-pro-lm',
  'klyvaron-max-lm',
  'klyvaron-pro-image',
  'klyvaron-max-image',
  'klyvaron-pro-video',
  'klyvaron-max-video',
  'klyvaron-pro-voice',
  'klyvaron-max-voice',
]

// These live acceptance flows need operator-installed trained artifacts plus the optional Python
// runtime dependencies. A clean checkout does not contain those ignored artifacts, so report an
// explicit skip instead of turning their absence into a product-code test failure.
const missingModels = ALL_EIGHT_MODELS.filter((id) => !existsSync(join(LIVE_MODELS_DIR, id)))
const pythonE2e = spawnSync('python3', ['-c', 'import numpy; import PIL'], { encoding: 'utf8' })
const LIVE_ACCEPTANCE_SKIP = missingModels.length
  ? `requires ignored trained model packages: ${missingModels.join(', ')}`
  : pythonE2e.error || pythonE2e.status !== 0
    ? 'requires Python NumPy and Pillow for local multimodal inference'
    : false

function stageInstalledModels(targetModelsDir) {
  for (const modelId of ALL_EIGHT_MODELS) {
    const src = join(LIVE_MODELS_DIR, modelId)
    assert.equal(existsSync(src), true, `Expected live trained model package at ${src}`)
    cpSync(src, join(targetModelsDir, modelId), { recursive: true })
  }
}

async function createAuthedClient(baseUrl) {
  let cookie = ''
  const call = async (method, path, body) => {
    const headers = { origin: baseUrl }
    if (cookie) headers.cookie = cookie
    let payload
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['x-aetheris-request'] = '1'
      payload = JSON.stringify(body)
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const ctype = res.headers.get('content-type') || ''
    const data = ctype.includes('application/json')
      ? await res.json()
      : Buffer.from(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, data }
  }
  const signup = await call('POST', '/api/auth/register', {
    email: 'owner@example.com',
    password: 'correct-horse-battery-staple',
  })
  assert.equal(signup.status, 201)
  return { call }
}

async function waitForMediaJob(call, jobId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await call('GET', `/api/media/jobs/${jobId}`)
    assert.equal(res.status, 200)
    if (res.data.state === 'succeeded') return res.data
    if (res.data.state === 'failed' || res.data.state === 'cancelled') {
      throw new Error(`Media job ${jobId} ended in '${res.data.state}': ${JSON.stringify(res.data.error)}`)
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`Timed out waiting for media job ${jobId}`)
}

test('historical artifact records remain separate from active model-independent resource profiles', () => {
  assert.deepEqual(Object.keys(PRODUCT_SUBSCRIPTION_TIERS), ['lite', 'pro', 'max'])
  for (const plan of Object.values(PRODUCT_SUBSCRIPTION_TIERS)) {
    assert.equal(plan.kind, 'product_subscription_tier')
    assert.equal(plan.weightsImplied, false)
  }

  assert.deepEqual(Object.keys(KLYVARON_MODEL_IDENTITIES), ALL_EIGHT_MODELS)
  const digests = new Set()
  for (const [id, spec] of Object.entries(KLYVARON_MODEL_IDENTITIES)) {
    assert.match(spec.artifactSha256, /^[0-9a-f]{64}$/, `${id} must have a real 64-hex SHA-256`)
    assert.match(spec.weightsDigest, /^[0-9a-f]{64}$/, `${id} must have a real weights digest`)
    assert.equal(spec.baseCheckpoint, null, `${id} must be trained from random initialization`)
    assert.ok(spec.parameterCount > 0, `${id} must have positive parameter count`)
    digests.add(spec.artifactSha256)
  }
  assert.equal(digests.size, 8, 'Pro and Max across all 4 modalities must have 8 distinct weight digests')

  assert.ok(KLYVARON_MODEL_IDENTITIES['klyvaron-max-lm'].parameterCount > KLYVARON_MODEL_IDENTITIES['klyvaron-pro-lm'].parameterCount)
  assert.ok(KLYVARON_MODEL_IDENTITIES['klyvaron-max-image'].parameterCount > KLYVARON_MODEL_IDENTITIES['klyvaron-pro-image'].parameterCount)
  assert.ok(KLYVARON_MODEL_IDENTITIES['klyvaron-max-video'].parameterCount > KLYVARON_MODEL_IDENTITIES['klyvaron-pro-video'].parameterCount)
  assert.ok(KLYVARON_MODEL_IDENTITIES['klyvaron-max-voice'].parameterCount > KLYVARON_MODEL_IDENTITIES['klyvaron-pro-voice'].parameterCount)

  for (const key of ['READY', 'PARTIALLY_AVAILABLE', 'MISSING_ARTIFACT', 'RUNTIME_UNQUALIFIED', 'TRAINING_REQUIRED', 'UNSUPPORTED_HARDWARE']) {
    assert.equal(typeof RUNTIME_READINESS_STATES[key], 'string')
  }
  assert.equal(deriveRuntimeCapabilityReadiness({ hardwareSupported: false }), 'unsupported_hardware')
  assert.equal(deriveRuntimeCapabilityReadiness({ trainingRequired: true, artifactPresent: false }), 'training_required')
  assert.equal(deriveRuntimeCapabilityReadiness({ artifactPresent: false }), 'missing_artifact')
  assert.equal(deriveRuntimeCapabilityReadiness({ artifactPresent: true, digestVerified: true, qualification: null }), 'runtime_unqualified')
  assert.equal(
    deriveRuntimeCapabilityReadiness({ artifactPresent: true, digestVerified: true, qualification: { qualified: true }, openSubtasks: ['4k_video'] }),
    'partially_available',
  )
  assert.equal(
    deriveRuntimeCapabilityReadiness({ artifactPresent: true, digestVerified: true, qualification: { qualified: true }, openSubtasks: [] }),
    'ready',
  )

  const report = familyReport()
  assert.equal(report.valid, true)
  const byId = Object.fromEntries(report.tiers.map((t) => [t.id, t]))
  assert.equal(KLYVARON.pro.status, 'partial')
  assert.equal(KLYVARON.max.status, 'partial')
  assert.equal(byId.pro.status, 'partial')
  assert.equal(byId.max.status, 'partial')
  assert.equal(ownedArtifacts('pro').length, 4)
  assert.equal(ownedArtifacts('max').length, 4)
  assert.equal(tierClaimFor('third-party/small-instruct'), null)

  const plan = developmentPlan()
  assert.equal(plan.valid, true)
})

test('active Klyvaron HTTP surface uses shared resource profiles and retires modality-specific model APIs', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ragam-model-independent-http-'))
  const app = new OnlineApp({ dataDir: workDir, secureCookie: false })
  const server = app.server()
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    const { call } = await createAuthedClient(baseUrl)

    // Active startup has no first-party model hosts, even when historical artifacts exist elsewhere.
    assert.equal(app.nativeKlyvaron.enableLegacyArtifacts, false)
    assert.equal(app.nativeKlyvaron.providers.size, 0)
    const ready = await call('GET', '/api/ready')
    assert.equal(ready.status, 200)
    assert.equal(ready.data.klyvaron.weightsRequired, false)
    assert.equal(ready.data.capabilities.chat, false)

    const info = await call('GET', '/api/klyvaron/processor')
    assert.equal(info.status, 200)
    assert.equal(info.data.modelUsed, false)
    assert.equal(info.data.weightsUsed, false)
    assert.deepEqual(Object.keys(info.data.profiles), ['lite', 'pro', 'max'])
    assert.deepEqual((await call('GET', '/api/models')).data.models, [])

    // Old model and modality-specific routes fail closed; no fallback or artifact scan occurs.
    for (const path of ['/api/klyvaron/manifests', '/api/klyvaron/models', '/api/klyvaron/qualification', '/api/klyvaron/worker']) {
      const retired = await call('GET', path)
      assert.equal(retired.status, 410, path)
      assert.equal(retired.data.error, 'model_independent_architecture')
    }
    for (const modelId of ['klyvaron-pro-lm', 'klyvaron-max-lm']) {
      const selection = await call('PUT', '/api/models/selection', { model: modelId })
      assert.equal(selection.status, 410)
      const chat = await call('POST', '/api/chat', {
        model: modelId,
        messages: [{ role: 'user', content: 'This must not invoke a model artifact.' }],
        authorization: { confirmed: true, providerRevision: 0 },
      })
      assert.equal(chat.status, 410)
      assert.equal(chat.data.error, 'model_independent_architecture')
    }
    for (const [path, tier] of [['/api/image/generate', 'pro'], ['/api/video/generate', 'max']]) {
      const retired = await call('POST', path, { prompt: 'no tier-specific media model', tier })
      assert.equal(retired.status, 410)
      assert.equal(retired.data.error, 'model_independent_tier')
    }

    const processed = await call('POST', '/api/klyvaron/process', {
      tier: 'max', input: 'The shared Klyvaron processor runs bounded deterministic workflows.', tasks: ['summarize'],
    })
    assert.equal(processed.status, 200)
    assert.equal(processed.data.modelUsed, false)
    assert.equal(processed.data.weightsUsed, false)
    assert.match(processed.data.text, /shared Klyvaron processor/)
  } finally {
    server.closeAllConnections()
    await new Promise((resolveClose) => server.close(resolveClose))
    app.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('legacy isolated local-worker compatibility keeps pairing, memory-first policy, and hardware-gated inference', { skip: LIVE_ACCEPTANCE_SKIP }, async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ragam-worker-mm-'))
  try {
    const modelsDir = join(workDir, 'models')
    stageInstalledModels(modelsDir)
    const workerServer = createLocalWorkerServer({
      workspaceDir: workDir,
      modelsDir,
      host: '127.0.0.1',
      port: 0,
      pairingSecret: 'single-use-mm-pairing-secret',
    })
    const workerOrigin = await workerServer.start()
    try {
      const controller = new UserTrainingController({ root: join(workDir, 'ctrl') })
      assert.equal(controller.isLocalWorkerConnected(), false)

      const paired = await controller.completePairing({
        workerEndpoint: workerOrigin,
        pairingSecret: 'single-use-mm-pairing-secret',
        actor: 'owner@example.com',
      })
      assert.equal(paired.localWorkerConnected, true)
      assert.equal(controller.isLocalWorkerConnected(), true)

      // Replay of single-use pairing secret is strictly rejected
      const replayRes = await fetch(`${workerOrigin}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingSecret: 'single-use-mm-pairing-secret' }),
      })
      assert.equal(replayRes.status, 403)

      // Private conversation auto-ingestion is strictly refused (403)
      assert.throws(
        () => controller.evaluateRequest({
          modelId: 'klyvaron-pro-image',
          dataAuthorization: { includePrivateConversations: true },
        }),
        /Automatic ingestion of private conversations is prohibited/,
      )

      // Single correction recommends memory/retrieval rather than pretending to pretrain weights
      const singleEval = controller.evaluateRequest({
        modelId: 'klyvaron-pro-lm',
        examples: [{ input: 'My timezone is IST', target: 'IST' }],
      })
      assert.equal(singleEval.spec.selectedMode, 'memory_or_retrieval')
      assert.ok(TRAINING_MODES.includes('foundation_pretrain'))

      // Real inference execution on paired local worker for a multimodal model
      const workerInfer = await controller.runWorkerInference({
        modelDir: join(modelsDir, 'klyvaron-pro-voice'),
        modelId: 'klyvaron-pro-voice',
        modality: 'voice',
        task: 'speech.synthesize',
        prompt: 'worker ready',
      })
      assert.equal(workerInfer.modelId, 'klyvaron-pro-voice')
      assert.ok(workerInfer.latencyMs > 0)
    } finally {
      await workerServer.close()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})
