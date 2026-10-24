/**
 * Phase 8 End-to-End Acceptance Verification for Klyvaron Pro & Max Multimodal Stack:
 *
 * Exercises live, unmocked execution across all 8 first-party models:
 *   - Chat:  `klyvaron-pro-lm@0.1.0` (27.56M) & `klyvaron-max-lm@0.1.0` (92.08M)
 *   - Image: `klyvaron-pro-image@0.1.0` (3.73M) & `klyvaron-max-image@0.1.0` (13.66M)
 *   - Video: `klyvaron-pro-video@0.1.0` (2.22M) & `klyvaron-max-video@0.1.0` (8.13M)
 *   - Voice: `klyvaron-pro-voice@0.1.0` (3.08M) & `klyvaron-max-voice@0.1.0` (11.26M)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
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

test('Phase 1 & 4: product subscription tiers, 8 first-party model identities, and programmatic readiness are strictly separated', () => {
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

test('Phase 2, 3, 6, 7 & 8: end-to-end HTTP verification of Chat, Image, Video, Voice, Qualification & Separate Pro/Max Manifests', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'ragam-mm-e2e-'))
  try {
    const modelsDir = join(workDir, 'klyvaron', 'models')
    stageInstalledModels(modelsDir)

    const app = new OnlineApp({ dataDir: workDir, secureCookie: false })
    const server = app.server()
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${server.address().port}`

    try {
      const { call } = await createAuthedClient(baseUrl)

      // 1. Check /api/ready independent per-modality readiness across chat, image, video, voice
      const ready = await call('GET', '/api/ready')
      assert.equal(ready.status, 200)
      assert.equal(ready.data.capabilities.chat, true)
      assert.equal(ready.data.capabilities.imageGeneration, true)
      assert.equal(ready.data.capabilities.imageEditing, true)
      assert.equal(ready.data.capabilities.visionUnderstanding, true)
      assert.equal(ready.data.capabilities.videoGeneration, true)
      assert.equal(ready.data.capabilities.videoUnderstanding, true)
      assert.equal(ready.data.capabilities.speechSynthesis, true)
      assert.equal(ready.data.capabilities.speechTranscription, true)
      assert.equal(ready.data.media.image.connectionId, 'klyvaron-native')
      assert.equal(ready.data.media.video.connectionId, 'klyvaron-native')
      assert.deepEqual(ready.data.media.voice.models, ['klyvaron-pro-voice', 'klyvaron-max-voice'])

      // 2. Chat inference on both klyvaron-pro-lm and klyvaron-max-lm
      for (const chatModel of ['klyvaron-pro-lm', 'klyvaron-max-lm']) {
        const chatRes = await call('POST', '/api/chat', {
          model: chatModel,
          messages: [{ role: 'user', content: 'Summarize first-party verification.' }],
        })
        assert.equal(chatRes.status, 200, `${chatModel} should return 200`)
        assert.equal(chatRes.data.provider, 'Klyvaron Native')
        assert.equal(chatRes.data.modelId, chatModel)
        assert.equal(chatRes.data.sentExternally, false)
        assert.equal(chatRes.data.firstPartyWeights, true)
        assert.equal(chatRes.data.weightsSha256.length, 64)
      }

      // 3. Image generation + PNG container validation + Vision understanding + Neural image editing (Pro & Max)
      for (const imgModel of ['klyvaron-pro-image', 'klyvaron-max-image']) {
        const gen = await call('POST', '/api/image/generate', {
          model: imgModel,
          prompt: 'sunset horizon warm glow golden sky',
          size: '256x256',
        })
        assert.equal(gen.status, 202)
        const genDone = await waitForMediaJob(call, gen.data.id)
        assert.equal(genDone.params.provenance.firstPartyWeights, true)
        assert.equal(genDone.params.provenance.model, imgModel)

        const rawPng = await call('GET', `/api/image/jobs/${gen.data.id}/content`)
        assert.equal(rawPng.status, 200)
        const mediaCheck = validateMedia({ bytes: rawPng.data, expectedKind: MEDIA_KINDS.IMAGE, claimedContentType: 'image/png' })
        assert.equal(mediaCheck.valid, true)
        assert.equal(mediaCheck.format, 'png')

        const understood = await call('POST', '/api/image/understand', {
          model: imgModel,
          sourceJobId: gen.data.id,
        })
        assert.equal(understood.status, 200)
        assert.equal(typeof understood.data.scene, 'string')
        assert.ok(understood.data.confidence > 0.3)

        const edited = await call('POST', '/api/image/edit', {
          model: imgModel,
          sourceJobId: gen.data.id,
          prompt: 'cobalt ocean waves deep blue water',
          strength: 0.72,
        })
        assert.equal(edited.status, 202)
        const editedDone = await waitForMediaJob(call, edited.data.id)
        assert.notEqual(editedDone.artifact.sha256, genDone.artifact.sha256)
      }

      // 4. Video generation (genuine multi-frame H.264 MP4) + Temporal understanding + Honest scope refusal
      for (const vidModel of ['klyvaron-pro-video', 'klyvaron-max-video']) {
        const genVid = await call('POST', '/api/video/generate', {
          model: vidModel,
          prompt: 'pan right glowing beacon steady motion',
          aspectRatio: '16:9',
          resolution: '480p',
        })
        assert.equal(genVid.status, 202)
        const vidDone = await waitForMediaJob(call, genVid.data.id)
        assert.equal(vidDone.params.provenance.firstPartyWeights, true)

        const rawMp4 = await call('GET', `/api/video/jobs/${genVid.data.id}/content`)
        assert.equal(rawMp4.status, 200)
        const vidCheck = validateMedia({ bytes: rawMp4.data, expectedKind: MEDIA_KINDS.VIDEO, claimedContentType: 'video/mp4' })
        const genuine = assertGenuineVideo(vidCheck, { minBytes: 1024 })
        assert.equal(genuine.genuine, true)
        const mp4Probe = probeMp4(rawMp4.data)
        assert.ok(mp4Probe && mp4Probe.durationSeconds >= 1.0, `Expected real MP4 mvhd duration >= 1s, got ${JSON.stringify(mp4Probe)}`)

        const vidUnderstood = await call('POST', '/api/video/understand', {
          model: vidModel,
          sourceJobId: genVid.data.id,
        })
        assert.equal(vidUnderstood.status, 200)
        assert.equal(typeof vidUnderstood.data.motion, 'string')
        assert.ok(vidUnderstood.data.videoMetadata.decodedFrames >= 8)
      }

      // Unsupported long-form / 4K / audio-track video requests fail closed cleanly with 409 unsupported_video_scope
      const refusedLongVideo = await call('POST', '/api/video/generate', {
        model: 'klyvaron-pro-video',
        prompt: 'ten minute feature film with soundtrack',
        durationMs: 60_000,
      })
      assert.equal(refusedLongVideo.status, 409)
      assert.equal(refusedLongVideo.data.error, 'unsupported_video_scope')

      // 5. Voice synthesis (16 kHz PCM RIFF WAV) + Neural speech-to-text round-trip (Pro & Max)
      for (const voiceModel of ['klyvaron-pro-voice', 'klyvaron-max-voice']) {
        const synth = await call('POST', '/api/voice/synthesize', {
          model: voiceModel,
          text: 'status check',
        })
        assert.equal(synth.status, 202)
        assert.equal(synth.data.modelId, voiceModel)
        assert.equal(synth.data.sampleRate, 16000)
        const wavBytes = Buffer.from(synth.data.audioBase64, 'base64')
        assert.equal(wavBytes.subarray(0, 4).toString('ascii'), 'RIFF')
        assert.equal(wavBytes.subarray(8, 12).toString('ascii'), 'WAVE')

        await waitForMediaJob(call, synth.data.job.id)
        const trans = await call('POST', '/api/voice/transcribe', {
          model: voiceModel,
          sourceJobId: synth.data.job.id,
        })
        assert.equal(trans.status, 200)
        assert.equal(trans.data.nearestCommand, 'status check')
        assert.ok(trans.data.commandConfidence > 0.7)
      }

      // 6. Per-backend Runtime Qualification + Stale Digest Invalidation
      const qualCpu = await call('POST', '/api/klyvaron/qualification/run', { backend: 'cpu' })
      assert.equal(qualCpu.status, 200)
      for (const mod of ['chat', 'image', 'video', 'voice']) {
        assert.equal(qualCpu.data.results[mod].qualified, true, `CPU backend must qualify ${mod} via real inference`)
        assert.ok(qualCpu.data.results[mod].latencyMs > 0)
      }

      const qualCuda = await call('POST', '/api/klyvaron/qualification/run', { backend: 'cuda' })
      assert.equal(qualCuda.status, 200)
      assert.equal(qualCuda.data.results.image.qualified, false)

      const staleCheck = app.qualificationRegistry.getValidQualification({
        capabilities: null,
        backend: 'cpu',
        modelId: 'klyvaron-pro-image',
        modelVersion: '0.1.0',
        artifactSha256: 'f'.repeat(64),
      })
      assert.equal(staleCheck.valid, false)
      assert.equal(staleCheck.status, 'invalidated_re_qualification_required')
      assert.match(staleCheck.invalidatedReason, /artifact_digest_changed/)

      // 7. Separate Pro and Max Capability Manifests after CPU qualification
      const manifestsRes = await call('GET', '/api/klyvaron/manifests')
      assert.equal(manifestsRes.status, 200)
      const { pro, max } = manifestsRes.data
      assert.equal(pro.tier, 'pro')
      assert.equal(max.tier, 'max')
      assert.equal(pro.overallReadinessStatus, 'partially_available')
      assert.equal(max.overallReadinessStatus, 'partially_available')
      for (const mod of ['chat', 'image', 'video', 'voice']) {
        assert.notEqual(pro.modalities[mod].modelId, max.modalities[mod].modelId)
        assert.notEqual(pro.modalities[mod].artifactSha256, max.modalities[mod].artifactSha256)
        assert.equal(pro.modalities[mod].evaluationStatus, 'passed_held_out_gates')
        assert.equal(max.modalities[mod].evaluationStatus, 'passed_held_out_gates')
      }

      // 8. Tampered weight file fails closed on verification
      const weightPath = join(modelsDir, 'klyvaron-max-voice', 'weights.npz')
      const origBytes = readFileSync(weightPath)
      const corrupted = Buffer.from(origBytes)
      corrupted[corrupted.length - 17] ^= 0xff
      writeFileSync(weightPath, corrupted)
      const reverify = app.multimodalHost.refresh()
      assert.equal(reverify.models['klyvaron-max-voice'].verified, false)
      assert.equal(reverify.models['klyvaron-max-voice'].status, 'missing_artifact')
      writeFileSync(weightPath, origBytes)
      app.multimodalHost.refresh()
    } finally {
      await new Promise((r) => server.close(r))
      app.close?.()
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('Phase 2 & 5: authenticated local user worker executes hardware detection, single-use pairing, multimodal inference, and training policy gates', async () => {
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
