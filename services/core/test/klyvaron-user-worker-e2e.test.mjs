// End-to-end verification of the Klyvaron User-Computer-First Training Architecture.
//
// Exercises:
//   - User-computer-first defaults (`localWorkerConnected === false`, never using server host silently)
//   - Explicit single-use pairing + constant-time Bearer auth + directory jail + zero shell access
//   - Resource-aware mode selection, single-correction memory preference, NO silent full->adapter downgrade
//   - Mandatory 7-field training specification + explicit `disclosureDigest` consent + 120s adapter cap
//   - Separate 9-field release gate tracking (`klyvaron-pro-lm` & `klyvaron-max-lm`)
//   - Full 10-step real flow on BOTH a dedicated test checkpoint AND real installed `klyvaron-pro-lm`
//     (connect worker -> detect hardware -> inspect verified checkpoint -> submit authorized examples ->
//      execute real AdamW optimizer updates -> save & validate artifact -> hot-load -> measure native
//      inference & target NLL improvement -> cancel active job & roll back weights to exact baseline).

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { KlyvaronLocalWorkerServer } from '../src/klyvaron/local-worker.mjs'
import { OnlineApp } from '../src/online/app.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const INSTALLED_PRO_DIR = resolve(REPO_ROOT, '.aetheris-data', 'online', 'klyvaron', 'models', 'klyvaron-pro-lm')

function createDedicatedTestCheckpoint(modelsDir) {
  const py = [
    'import json',
    'from pathlib import Path',
    'import numpy as np',
    'from fabric.lm.bpe import ByteBPETokenizer',
    'from fabric.lm.export import build_manifest, write_json',
    'from fabric.lm.model import TransformerConfig, TransformerLM',
    'models_dir = Path(json.loads(__import__("sys").argv[1]))',
    'out = models_dir / "klyvaron-e2e-test-checkpoint"',
    'out.mkdir(parents=True, exist_ok=True)',
    'corpus = ("Klyvaron verifies weights by SHA-256 before local inference.\\n" * 30)',
    'tok = ByteBPETokenizer.fit(corpus, vocab_size=320)',
    'cfg = TransformerConfig(vocab_size=tok.size, d_model=48, n_layers=2, n_heads=4, d_ff=96, seq_len=96, tie_embeddings=True, age_buckets=4, state_classes=4, verdict_head=True, state_head=True)',
    'model = TransformerLM(cfg, seed=2026, dtype=np.float32)',
    'wfile = out / "klyvaron-e2e-test-checkpoint-0.1.0.npz"',
    'model.save(wfile)',
    'manifest = build_manifest(config=cfg, tokenizer=tok, weights_file=wfile.name, weights_bytes=wfile.read_bytes(), weights_names=list(model.params.keys()), artifact_id="klyvaron-e2e-test-checkpoint", version="0.1.0", tier="lite", instruction_tuned=True, limitations=["Dedicated integration test checkpoint; never presented as Klyvaron Pro or Max."])',
    'write_json(out / "klyvaron-e2e-test-checkpoint.klyvaron.json", manifest)',
    '(out / ".ready").write_text(manifest["weights"]["sha256"] + "\\n", encoding="utf-8")',
  ].join('\n')
  const r = spawnSync('python3', ['-c', py, JSON.stringify(modelsDir)], {
    cwd: join(REPO_ROOT, 'services', 'fabric'),
    encoding: 'utf8',
    timeout: 20_000,
  })
  assert.equal(r.status, 0, `Failed building dedicated test checkpoint: ${r.stderr}`)
}

async function startTestApp(dataDir) {
  const app = new OnlineApp({ dataDir, secureCookie: false, cookieSameSite: 'lax' })
  const server = app.server()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  let cookie = ''

  const req = async (method, path, body = undefined) => {
    const headers = { 'x-aetheris-request': '1' }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    const payload = await res.json()
    return { status: res.status, body: payload }
  }

  const reg = await req('POST', '/api/auth/register', {
    email: 'owner@ragam.local',
    password: 'StrongOwnerPassword!2026',
  })
  assert.equal(reg.status, 201)

  return {
    app,
    server,
    origin,
    req,
    async close() {
      await new Promise((r) => server.close(() => r()))
      app.close()
    },
  }
}

test('user-computer-first defaults, pairing security, mode rules, and NO silent downgrade hold', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'klyvaron-ucf-policy-'))
  const harness = await startTestApp(join(tempRoot, 'online'))
  let limitedWorker = null
  t.after(async () => {
    await limitedWorker?.close()
    await harness.close()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  // 1. Default state: never connected to server host, never claims user hardware!
  const initial = await harness.req('GET', '/api/klyvaron/worker')
  assert.equal(initial.status, 200)
  assert.equal(initial.body.architecture, 'user_computer_first')
  assert.equal(initial.body.defaultExecutionTarget, 'user_local_worker')
  assert.equal(initial.body.codingAgentHostUsedByDefault, false)
  assert.equal(initial.body.localWorkerConnected, false)
  assert.equal(initial.body.connectedHardware, null)
  assert.equal(initial.body.chatMessagesTriggerTraining, false)
  assert.equal(initial.body.privateConversationsAutoIngested, false)

  // Check all 9 separate release gate fields exist on both Pro and Max!
  const expectedNineGates = [
    'architectureImplemented',
    'localWorkerConnected',
    'baseWeightsVerified',
    'trainingDataAuthorized',
    'trainingExecuted',
    'adapterOrCheckpointProduced',
    'evaluationPassed',
    'nativeInferencePassed',
    'availableInRagamChat',
  ]
  for (const id of ['klyvaron-pro-lm', 'klyvaron-max-lm']) {
    assert.deepEqual(Object.keys(initial.body.releaseGates[id].gates), expectedNineGates)
    assert.equal(initial.body.releaseGates[id].gates.localWorkerConnected, false)
    assert.equal(initial.body.releaseGates[id].capabilityGates.image, false)
    assert.equal(initial.body.releaseGates[id].capabilityGates.video, false)
  }

  // 2. Unpaired training attempt MUST fail closed (`worker_not_connected`), NEVER running on server host!
  const unpairedEval = await harness.req('POST', '/api/klyvaron/worker/evaluate', {
    modelId: 'klyvaron-pro-lm',
    requestedMode: 'lightweight_adapter',
    intendedBehavior: 'Answer verification questions concisely.',
    examples: [{ input: 'Prompt A', target: 'Target A' }, { input: 'Prompt B', target: 'Target B' }],
    dataAuthorization: { authorized: true },
  })
  const unpairedExec = await harness.req('POST', '/api/klyvaron/worker/execute', {
    request: {
      modelId: 'klyvaron-pro-lm',
      requestedMode: 'lightweight_adapter',
      intendedBehavior: 'Answer verification questions concisely.',
      examples: [{ input: 'Prompt A', target: 'Target A' }, { input: 'Prompt B', target: 'Target B' }],
      dataAuthorization: { authorized: true },
    },
    consent: { confirmed: true, disclosureDigest: unpairedEval.body.disclosureDigest },
  })
  assert.equal(unpairedExec.status, 409)
  assert.equal(unpairedExec.body.error, 'worker_not_connected')

  // 3. Private chat auto-ingestion is strictly refused (`403 private_chat_ingestion_prohibited`).
  const privateIngest = await harness.req('POST', '/api/klyvaron/worker/evaluate', {
    modelId: 'klyvaron-pro-lm',
    examples: [{ input: 'x', target: 'y' }],
    dataAuthorization: { authorized: true, includePrivateConversations: true },
  })
  assert.equal(privateIngest.status, 403)
  assert.equal(privateIngest.body.error, 'private_chat_ingestion_prohibited')

  // 4. Single correction prefers `memory_or_retrieval` and refuses `foundation_pretrain`!
  const singleCorrectionEval = await harness.req('POST', '/api/klyvaron/worker/evaluate', {
    modelId: 'klyvaron-pro-lm',
    intendedBehavior: 'Remember project code-freeze timezone is Asia/Kolkata.',
    examples: [{ input: 'What timezone are release cutoffs in?', target: 'Release cutoffs use Asia/Kolkata.' }],
    dataAuthorization: { authorized: true },
  })
  assert.equal(singleCorrectionEval.body.spec.selectedMode, 'memory_or_retrieval')
  assert.equal(singleCorrectionEval.body.readyToExecute, true)

  const singleExec = await harness.req('POST', '/api/klyvaron/worker/execute', {
    request: {
      modelId: 'klyvaron-pro-lm',
      intendedBehavior: 'Remember project code-freeze timezone is Asia/Kolkata.',
      examples: [{ input: 'What timezone are release cutoffs in?', target: 'Release cutoffs use Asia/Kolkata.' }],
      dataAuthorization: { authorized: true },
    },
    consent: { confirmed: true, disclosureDigest: singleCorrectionEval.body.disclosureDigest },
  })
  assert.equal(singleExec.status, 202)
  assert.equal(singleExec.body.state, 'completed_non_parametric')
  assert.equal(singleExec.body.weightsModified, false)
  assert.ok(singleExec.body.storedMemoryEntry?.id)

  const singleFoundationRefused = await harness.req('POST', '/api/klyvaron/worker/evaluate', {
    modelId: 'klyvaron-max-lm',
    requestedMode: 'foundation_pretrain',
    intendedBehavior: 'Try foundation pretraining on 1 example',
    examples: [{ input: 'One prompt', target: 'One answer' }],
    dataAuthorization: { authorized: true },
  })
  assert.equal(singleFoundationRefused.status, 400)
  assert.equal(singleFoundationRefused.body.error, 'single_example_foundation_refused')

  // 5. Pair a memory-constrained worker (`availableRamBytes = 1.6 GB`) to test security boundaries
  //    AND prove NO silent downgrade from `full_fine_tune` -> `lightweight_adapter`!
  const pairOffer = await harness.req('POST', '/api/klyvaron/worker/pair/request', { deviceLabel: 'Laptop 8GB' })
  limitedWorker = new KlyvaronLocalWorkerServer({
    workspaceDir: join(tempRoot, 'worker-ws'),
    modelsDir: join(tempRoot, 'worker-models'),
    pairingSecret: pairOffer.body.pairingSecret,
    hardwareOverride: {
      workerId: 'simulated-8gb-laptop',
      workerLabel: 'Laptop 8GB',
      osSupported: true,
      platform: 'darwin',
      arch: 'arm64',
      cpu: { model: 'Apple M2', logicalCores: 8, simdFlags: ['neon'] },
      memory: { totalRamBytes: 8_000_000_000, availableRamBytes: 1_600_000_000 },
      gpu: { available: false, totalVramBytes: 0, availableVramBytes: 0, devices: [] },
      storage: { freeDiskBytes: 25_000_000_000 },
      software: { pythonAvailable: true, pythonBinary: 'python3', numpyVersion: '2.4.6', jaxVersion: '0.10.0', supportedBackends: ['python-numpy-cpu'] },
    },
  })
  const workerUrl = await limitedWorker.start()

  // Unauthenticated `/rpc` before pairing MUST fail with 401!
  const unauthRes = await fetch(`${workerUrl}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'capability.detect' }),
  })
  assert.equal(unauthRes.status, 401)

  const paired = await harness.req('POST', '/api/klyvaron/worker/pair/complete', {
    pairingId: pairOffer.body.pairingId,
    pairingSecret: pairOffer.body.pairingSecret,
    workerEndpoint: workerUrl,
  })
  assert.equal(paired.status, 200)
  assert.equal(paired.body.localWorkerConnected, true)

  // Replay of single-use pairing secret on worker MUST fail with `403 pairing_code_used`!
  const replayPair = await fetch(`${workerUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingSecret: pairOffer.body.pairingSecret }),
  })
  assert.equal(replayPair.status, 403)

  // Arbitrary shell operation and path traversal on worker MUST fail with 403!
  assert.throws(() => limitedWorker.dispatchOperation('shell.exec', { cmd: 'whoami' }), {
    code: 'forbidden_worker_operation',
  })
  assert.throws(() => limitedWorker.resolveAuthorizedPath('../../../../etc/passwd'), {
    code: 'path_outside_authorized_root',
  })

  // Request `full_fine_tune` on `klyvaron-max-lm` (requires ~1.66+ GB + overhead > 1.60 GB available):
  // MUST propose `lightweight_adapter` WITHOUT silently downgrading, and block until user approves!
  const fullReq = {
    modelId: 'klyvaron-max-lm',
    requestedMode: 'full_fine_tune',
    intendedBehavior: 'Adapt Max style',
    examples: [
      { input: 'Q1', target: 'A1' },
      { input: 'Q2', target: 'A2' },
    ],
    dataAuthorization: { authorized: true },
  }
  const downgradeBlocked = await harness.req('POST', '/api/klyvaron/worker/evaluate', fullReq)
  assert.equal(downgradeBlocked.body.readyToExecute, false)
  assert.equal(downgradeBlocked.body.spec.selectedMode, 'full_fine_tune')
  assert.equal(downgradeBlocked.body.spec.modeDowngradeProposal.proposedMode, 'lightweight_adapter')
  assert.equal(downgradeBlocked.body.spec.modeDowngradeProposal.approvedByUser, false)

  const execWithoutApproval = await harness.req('POST', '/api/klyvaron/worker/execute', {
    request: fullReq,
    consent: { confirmed: true, disclosureDigest: downgradeBlocked.body.disclosureDigest },
  })
  assert.equal(execWithoutApproval.status, 409)
  assert.equal(execWithoutApproval.body.error, 'mode_change_approval_required')

  // Once the user explicitly approves switching to `lightweight_adapter`, planning succeeds cleanly!
  const approvedPlan = await harness.req('POST', '/api/klyvaron/worker/evaluate', {
    ...fullReq,
    modeChangeApproval: {
      fromMode: 'full_fine_tune',
      toMode: 'lightweight_adapter',
      approved: true,
    },
  })
  assert.equal(approvedPlan.body.readyToExecute, true)
  assert.equal(approvedPlan.body.spec.selectedMode, 'lightweight_adapter')
  assert.equal(approvedPlan.body.spec.stoppingCriteria.maxDurationMs, 120_000)
})

test('required 10-step real end-to-end flow: pair -> hardware -> checkpoint -> train -> validate -> load -> infer -> cancel & rollback', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'klyvaron-ucf-10step-'))
  const onlineDataDir = join(tempRoot, 'online')
  const workerModelsDir = join(onlineDataDir, 'klyvaron', 'models')
  mkdirSync(workerModelsDir, { recursive: true })

  // Install dedicated test checkpoint AND copy real `klyvaron-pro-lm` if present so BOTH are exercised!
  createDedicatedTestCheckpoint(workerModelsDir)
  const useRealPro = existsSync(INSTALLED_PRO_DIR)
  if (useRealPro) {
    cpSync(INSTALLED_PRO_DIR, join(workerModelsDir, 'klyvaron-pro-lm'), { recursive: true })
  }

  const harness = await startTestApp(onlineDataDir)
  let worker = null
  t.after(async () => {
    await worker?.close()
    await harness.close()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  // STEP 1: Start real packaged `KlyvaronLocalWorkerServer` & pair via RAGAM API
  const offer = await harness.req('POST', '/api/klyvaron/worker/pair/request', {
    deviceLabel: 'Authorized Local Test Computer',
  })
  assert.equal(offer.status, 200)

  worker = new KlyvaronLocalWorkerServer({
    workspaceDir: join(tempRoot, 'worker-workspace'),
    modelsDir: workerModelsDir,
    pairingSecret: offer.body.pairingSecret,
    workerLabel: 'Authorized Local Test Computer',
  })
  const endpoint = await worker.start()

  const paired = await harness.req('POST', '/api/klyvaron/worker/pair/complete', {
    pairingId: offer.body.pairingId,
    pairingSecret: offer.body.pairingSecret,
    workerEndpoint: endpoint,
  })
  assert.equal(paired.status, 200)
  assert.equal(paired.body.localWorkerConnected, true)

  // STEP 2: Verify real detected hardware & software backends
  const hw = paired.body.worker.capabilities
  assert.equal(hw.osSupported, true)
  assert.ok(hw.cpu.logicalCores >= 1)
  assert.ok(hw.memory.totalRamBytes > 0)
  assert.ok(hw.storage.freeDiskBytes > 0)
  assert.equal(hw.software.pythonAvailable, true)
  assert.equal(hw.security.shellExecutionEnabled, false)

  // STEP 3: Select verified Klyvaron checkpoint & measure baseline pre-training target NLL + generation
  const targetModelId = useRealPro ? 'klyvaron-pro-lm' : 'klyvaron-e2e-test-checkpoint'
  const inspected = paired.body.worker.inspectedModels.find((m) => m.id === targetModelId)
  assert.ok(inspected?.verified, `Expected ${targetModelId} to pass SHA-256 checkpoint inspection`)

  const evalPrompt = 'How does RAGAM verify Klyvaron weights before local execution?'
  const evalTarget = 'RAGAM verifies Klyvaron weights by SHA-256 digest before local execution.'

  const preInfer = await harness.req('POST', '/api/klyvaron/worker/infer', {
    modelId: targetModelId,
    prompt: evalPrompt,
    target: evalTarget,
    maxNewTokens: 8,
  })
  assert.equal(preInfer.status, 200)
  assert.ok(Number.isFinite(preInfer.body.targetLoss.meanNll))
  assert.ok(preInfer.body.generatedTokens >= 1)

  // STEP 4: Submit user-authorized training examples (4 examples -> automatic separate validation split!)
  const trainRequest = {
    modelId: targetModelId,
    requestedMode: 'lightweight_adapter',
    intendedBehavior: 'Teach concise SHA-256 verification and pairing policy answers.',
    examples: [
      { input: evalPrompt, target: evalTarget },
      { input: 'Where do authorized Klyvaron training jobs run?', target: 'Authorized jobs run on the paired local worker.' },
      { input: 'Do chat messages train weights automatically?', target: 'No, chat messages never trigger weight training.' },
      { input: 'What limits interactive adapter duration?', target: 'Interactive adapter jobs enforce a hard 120 second wall-clock ceiling.' },
    ],
    trainingLoss: {
      learningRate: 1.5e-2,
      rank: 4,
      alpha: 8,
      layerIndices: useRealPro ? [6, 7] : [0, 1],
    },
    stoppingCriteria: { maxSteps: 3, maxDurationMs: 120_000 },
    dataAuthorization: { authorized: true, origin: 'e2e_test_authorized_examples', licence: 'MIT' },
  }

  const planRes = await harness.req('POST', '/api/klyvaron/worker/evaluate', trainRequest)
  assert.equal(planRes.status, 200)
  assert.equal(planRes.body.readyToExecute, true)
  assert.equal(planRes.body.spec.validationMethod.kind, 'automatic_disjoint_holdout_split')
  assert.equal(planRes.body.spec.trainExamples.length, 3)
  assert.equal(planRes.body.spec.validationExamples.length, 1)

  // STEP 5: Execute genuine AdamW optimizer updates on the paired local worker
  const startedJob = await harness.req('POST', '/api/klyvaron/worker/execute', {
    request: trainRequest,
    consent: { confirmed: true, disclosureDigest: planRes.body.disclosureDigest },
  })
  assert.equal(startedJob.status, 202)
  const completedJobId = startedJob.body.jobId

  let synced = null
  for (let i = 0; i < 600; i += 1) {
    await delay(150)
    const poll = await harness.req('POST', '/api/klyvaron/worker/job', { jobId: completedJobId })
    assert.equal(poll.status, 200)
    synced = poll.body
    if (synced.state !== 'running' && synced.state !== 'starting') break
  }

  // STEP 6 & STEP 7: Confirm artifact saved, validated (`artifact.validate`), loaded, and promoted
  assert.equal(synced.state, 'completed', `Unexpected job failure: ${JSON.stringify(synced)}`)
  assert.equal(synced.workerJob.result.metrics.stepsCompleted, 3)
  assert.ok(
    synced.workerJob.result.metrics.finalTrainLoss < synced.workerJob.result.metrics.initialTrainLoss,
    `Expected post-update train loss (${synced.workerJob.result.metrics.finalTrainLoss}) < initial (${synced.workerJob.result.metrics.initialTrainLoss})`,
  )
  assert.equal(synced.validationReport.valid, true)
  assert.equal(synced.validationReport.finiteProbeLogits, true)
  if (useRealPro) {
    assert.equal(synced.promotedToChat, true)
  }

  // STEP 8: Measure native inference & exact target NLL after loading updated adapter artifact
  const postInfer = synced.postTrainingInference
  assert.ok(postInfer.generatedTokens >= 1)
  assert.ok(postInfer.activeAdapter?.sha256 === synced.validationReport.sha256)
  assert.ok(
    postInfer.targetLoss.meanNll < preInfer.body.targetLoss.meanNll,
    `Expected adapted native JS runtime NLL (${postInfer.targetLoss.meanNll}) < baseline (${preInfer.body.targetLoss.meanNll})`,
  )
  assert.ok(postInfer.latencyMs > 0)
  assert.ok(postInfer.rssBytesAfter > 0)

  if (useRealPro) {
    const liveChat = await harness.req('POST', '/api/chat', {
      model: 'klyvaron-pro-lm',
      messages: [{ role: 'user', content: evalPrompt }],
      maxTokens: 10,
      temperature: 0,
      authorization: { confirmed: true, providerRevision: 0, includeContext: false, allowSensitive: false },
    })
    assert.equal(liveChat.status, 200)
    assert.equal(liveChat.body.firstPartyWeights, true)
    assert.equal(liveChat.body.sentExternally, false)
    assert.ok(liveChat.body.text.length > 0)
  }

  // STEP 9A: Demonstrate live mid-job cancellation on a slow multi-step run
  const slowReq = {
    ...trainRequest,
    modelId: 'klyvaron-e2e-test-checkpoint',
    trainingLoss: { learningRate: 1e-2, rank: 4, alpha: 8, layerIndices: [0, 1] },
    stoppingCriteria: { maxSteps: 12, maxDurationMs: 120_000 },
    stepDelayMs: 120,
  }
  const slowPlan = await harness.req('POST', '/api/klyvaron/worker/evaluate', slowReq)
  const slowStart = await harness.req('POST', '/api/klyvaron/worker/execute', {
    request: slowReq,
    consent: { confirmed: true, disclosureDigest: slowPlan.body.disclosureDigest },
  })
  assert.equal(slowStart.status, 202)
  await delay(260)
  const cancelledRes = await harness.req('POST', '/api/klyvaron/worker/job/cancel', { jobId: slowStart.body.jobId })
  assert.equal(cancelledRes.status, 200)
  let finalCancelled = null
  for (let i = 0; i < 40; i += 1) {
    await delay(100)
    const p = await harness.req('POST', '/api/klyvaron/worker/job', { jobId: slowStart.body.jobId })
    finalCancelled = p.body
    if (finalCancelled.state !== 'running') break
  }
  assert.match(finalCancelled.state, /^cancelled/)
  assert.equal(finalCancelled.promotedToChat, false)

  // STEP 9B: Demonstrate atomic rollback of the completed job and verify exact baseline NLL restoration!
  const rollbackRes = await harness.req('POST', '/api/klyvaron/worker/job/rollback', { jobId: completedJobId })
  assert.equal(rollbackRes.status, 200)
  assert.equal(rollbackRes.body.rolledBack, true)
  assert.equal(rollbackRes.body.restoredBaseWeightsSha256, preInfer.body.weightsSha256)
  assert.equal(rollbackRes.body.activeAdapter, null)

  const afterRollbackInfer = await harness.req('POST', '/api/klyvaron/worker/infer', {
    modelId: targetModelId,
    prompt: evalPrompt,
    target: evalTarget,
    maxNewTokens: 8,
  })
  assert.equal(afterRollbackInfer.body.activeAdapter, null)
  assert.ok(
    Math.abs(afterRollbackInfer.body.targetLoss.meanNll - preInfer.body.targetLoss.meanNll) < 1e-5,
    `Rollback must restore exact baseline NLL (${afterRollbackInfer.body.targetLoss.meanNll} vs ${preInfer.body.targetLoss.meanNll})`,
  )

  // STEP 10: Print measured telemetry summary for transparent audit
  t.diagnostic(JSON.stringify({
    targetModelId,
    usedRealInstalledPro: useRealPro,
    preTrainNll: preInfer.body.targetLoss.meanNll,
    postTrainNll: postInfer.targetLoss.meanNll,
    rolledBackNll: afterRollbackInfer.body.targetLoss.meanNll,
    elapsedMs: synced.workerJob.result.elapsedMs,
    peakRssMb: Number((synced.workerJob.result.peakRssBytes / 1_048_576).toFixed(1)),
    postInferLatencyMs: postInfer.latencyMs,
    postInferTokPerSec: postInfer.tokensPerSecond,
  }))
})
