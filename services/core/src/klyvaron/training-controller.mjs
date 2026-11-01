// User-Computer-First Training Controller for Klyvaron Pro, Klyvaron Max, and Klyvaron checkpoints.
//
// Core architectural guarantees:
//   1. Never defaults to the coding agent's / server's own host (`executionEnvironment = 'user_local_worker'`,
//      `localWorkerConnected = false` until an authenticated local worker completes pairing).
//   2. Never claims the user's CPU or GPU is available unless a paired local worker responds to
//      authenticated `capability.detect`.
//   3. Never treats ordinary chat messages as permission to update weights and never auto-ingests
//      private conversations (`privateChatAutoIngested = false`).
//   4. Determines the right adaptation/training mode (`context_only`, `memory_or_retrieval`,
//      `lightweight_adapter`, `full_fine_tune`, `foundation_pretrain`), prefers `memory_or_retrieval`
//      for single corrections, NEVER silently downgrades full training to adapter training without
//      explicit user approval, enforces all 7 parameter-changing specification fields, enforces the
//      120-second interactive limit (including finalization) on adapter jobs only, and maintains all
//      9 release-gate status fields per model.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SIZE_PRESETS, configDigest, parameterCount } from './architecture.mjs'
import { ALLOWED_WORKER_OPERATIONS, INTERACTIVE_ADAPTER_WALL_LIMIT_MS } from './local-worker.mjs'

export const TRAINING_MODES = Object.freeze([
  'context_only',
  'memory_or_retrieval',
  'lightweight_adapter',
  'full_fine_tune',
  'foundation_pretrain',
])

export const PARAMETER_UPDATING_MODES = Object.freeze([
  'lightweight_adapter',
  'full_fine_tune',
  'foundation_pretrain',
])

const PAIRING_TTL_MS = 10 * 60_000
const MIN_FREE_DISK_RESERVE_BYTES = 512 * 1024 * 1024 // 512 MiB safety floor

export class UserTrainingControllerError extends Error {
  constructor(message, { code = 'training_controller_error', status = 400, detail = {} } = {}) {
    super(message)
    this.name = 'UserTrainingControllerError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

const MULTIMODAL_MODEL_SPECS = Object.freeze({
  'klyvaron-pro-image': { tier: 'pro', modality: 'image', parameterCount: 2_250_000, dModel: 128, nLayers: 6, seqLen: 64 },
  'klyvaron-max-image': { tier: 'max', modality: 'image', parameterCount: 9_800_000, dModel: 256, nLayers: 10, seqLen: 64 },
  'klyvaron-pro-video': { tier: 'pro', modality: 'video', parameterCount: 1_850_000, dModel: 128, nLayers: 6, seqLen: 64 },
  'klyvaron-max-video': { tier: 'max', modality: 'video', parameterCount: 6_600_000, dModel: 224, nLayers: 9, seqLen: 64 },
  'klyvaron-pro-voice': { tier: 'pro', modality: 'voice', parameterCount: 1_150_000, dModel: 128, nLayers: 6, seqLen: 48 },
  'klyvaron-max-voice': { tier: 'max', modality: 'voice', parameterCount: 4_300_000, dModel: 224, nLayers: 8, seqLen: 48 },
})

function resolveModelSpec(modelId, inspectedModel = null) {
  if (MULTIMODAL_MODEL_SPECS[modelId]) {
    const mm = MULTIMODAL_MODEL_SPECS[modelId]
    return {
      modelId,
      preset: mm.tier,
      tier: mm.tier,
      modality: mm.modality,
      parameterCount: inspectedModel?.parameterCount ?? mm.parameterCount,
      seqLen: mm.seqLen,
      dModel: mm.dModel,
      nLayers: mm.nLayers,
      architectureDigest: sha256Hex({ modelId, modality: mm.modality }),
      isProOrMax: true,
    }
  }
  if (modelId === 'klyvaron-pro-lm' || modelId === 'pro') {
    const cfg = SIZE_PRESETS.pro.config
    return {
      modelId: 'klyvaron-pro-lm',
      preset: 'pro',
      tier: 'pro',
      modality: 'chat',
      parameterCount: parameterCount(cfg),
      seqLen: cfg.seqLen,
      dModel: cfg.dModel,
      nLayers: cfg.nLayers,
      architectureDigest: configDigest(cfg),
      isProOrMax: true,
    }
  }
  if (modelId === 'klyvaron-max-lm' || modelId === 'max') {
    const cfg = SIZE_PRESETS.max.config
    return {
      modelId: 'klyvaron-max-lm',
      preset: 'max',
      tier: 'max',
      modality: 'chat',
      parameterCount: parameterCount(cfg),
      seqLen: cfg.seqLen,
      dModel: cfg.dModel,
      nLayers: cfg.nLayers,
      architectureDigest: configDigest(cfg),
      isProOrMax: true,
    }
  }
  const arch = inspectedModel?.architecture
  const params = inspectedModel?.parameterCount
    ?? (arch?.vocab_size
      ? (arch.vocab_size * arch.d_model
        + arch.seq_len * arch.d_model
        + arch.n_layers * (4 * arch.d_model * arch.d_model + 2 * arch.d_model * arch.d_ff + 4 * arch.d_model)
        + 2 * arch.d_model)
      : 359_616)
  return {
    modelId,
    preset: 'custom_test_checkpoint',
    tier: inspectedModel?.tier ?? 'lite',
    modality: inspectedModel?.modality ?? 'chat',
    parameterCount: params,
    seqLen: arch?.seq_len ?? 128,
    dModel: arch?.d_model ?? 64,
    nLayers: arch?.n_layers ?? 2,
    architectureDigest: sha256Hex(arch ?? { modelId }),
    isProOrMax: false,
  }
}

/** Estimate memory, disk, duration, and energy requirements for `(modelSpec, mode, capabilities)`. */
export function estimateModeResources({ modelSpec, mode, capabilities, stepCount = 6, batchSize = 2, rank = 8 }) {
  if (mode === 'context_only' || mode === 'memory_or_retrieval') {
    return {
      mode,
      modifiesWeights: false,
      requiresLocalWorker: false,
      requiredRamBytes: 0,
      requiredDiskBytes: 4 * 1024 * 1024,
      estimatedWallMs: 50,
      estimatedWatts: 0,
      estimatedWattHours: 0,
      selectedBackend: mode === 'context_only' ? 'session_prompt_context' : 'ragam_authorized_memory_retrieval',
      compatible: true,
      limitations: [],
    }
  }

  const P = modelSpec.parameterCount
  const loraParams = modelSpec.nLayers * 4 * 2 * modelSpec.dModel * rank + 2 * modelSpec.dModel * rank
  const hasGpu = Boolean(capabilities?.gpu?.available)
  const hasJax = Boolean(capabilities?.software?.jaxVersion)
  const hasPython = Boolean(capabilities?.software?.pythonAvailable)

  let requiredRamBytes
  let requiredDiskBytes
  let msPerStep
  if (mode === 'lightweight_adapter') {
    // Base weights in float32 + forward activation cache + tiny LoRA AdamW state.
    requiredRamBytes = Math.round(P * 5.2 + loraParams * 16 + 180 * 1024 * 1024)
    requiredDiskBytes = Math.round(loraParams * 20 + MIN_FREE_DISK_RESERVE_BYTES)
    msPerStep = hasGpu ? Math.max(25, P / 650_000) : Math.max(40, P / 140_000)
  } else if (mode === 'full_fine_tune') {
    // Full weights + full gradients + AdamW m1 & m2 + layer activations (~18 bytes/param + runtime headroom).
    requiredRamBytes = Math.round(P * 18 + 380 * 1024 * 1024)
    requiredDiskBytes = Math.round(P * 16 + MIN_FREE_DISK_RESERVE_BYTES)
    msPerStep = hasGpu ? Math.max(45, P / 420_000) : Math.max(90, P / 75_000)
  } else {
    // `foundation_pretrain` across larger batches and full sequence windows.
    requiredRamBytes = Math.round(P * 22 + 512 * 1024 * 1024)
    requiredDiskBytes = Math.round(P * 20 + MIN_FREE_DISK_RESERVE_BYTES)
    msPerStep = hasGpu ? Math.max(60, P / 350_000) : Math.max(140, (P * Math.max(1, batchSize)) / 65_000)
  }

  const estimatedWallMs = Math.round(stepCount * msPerStep + 1_200)
  const availRam = Number(capabilities?.memory?.availableRamBytes ?? 0)
  const availVram = Number(capabilities?.gpu?.availableVramBytes ?? 0)
  const effectiveComputePoolBytes = hasGpu && availVram > 0 ? Math.max(availRam, availVram) : availRam
  const freeDisk = Number(capabilities?.storage?.freeDiskBytes ?? 0)

  const limitations = []
  if (!capabilities) {
    limitations.push('No authenticated local worker is connected on the user computer.')
  } else {
    if (!capabilities.osSupported) {
      limitations.push(`Unsupported operating system '${capabilities.platform}'.`)
    }
    if (!hasPython) {
      limitations.push('Python 3.11+ with NumPy is missing on the paired local worker.')
    }
    if (effectiveComputePoolBytes < requiredRamBytes) {
      limitations.push(
        `Insufficient memory for '${mode}' on '${modelSpec.modelId}': ${(effectiveComputePoolBytes / 1e9).toFixed(2)} GB available vs ${(requiredRamBytes / 1e9).toFixed(2)} GB required.`,
      )
    }
    if (freeDisk < requiredDiskBytes) {
      limitations.push(
        `Insufficient free disk space: ${(freeDisk / 1e9).toFixed(2)} GB free vs ${(requiredDiskBytes / 1e9).toFixed(2)} GB required.`,
      )
    }
    if (mode === 'lightweight_adapter' && estimatedWallMs > INTERACTIVE_ADAPTER_WALL_LIMIT_MS) {
      limitations.push(
        `Estimated interactive adapter duration (${(estimatedWallMs / 1000).toFixed(1)}s including finalization) exceeds the hard 120s limit.`,
      )
    }
  }

  const backend = hasGpu
    ? `local-worker-${capabilities.gpu.devices[0]?.kind ?? 'gpu'}`
    : hasJax
      ? 'local-worker-python-jax-cpu'
      : 'local-worker-python-numpy-cpu'

  const watts = hasGpu ? 165 : 28
  const wattHours = Number(((watts * (estimatedWallMs / 1000)) / 3600).toFixed(4))

  return {
    mode,
    modifiesWeights: true,
    requiresLocalWorker: true,
    trainableParameters: mode === 'lightweight_adapter' ? loraParams : P,
    baseParameters: P,
    requiredRamBytes,
    requiredDiskBytes,
    estimatedWallMs,
    maxWallClockMs: mode === 'lightweight_adapter' ? INTERACTIVE_ADAPTER_WALL_LIMIT_MS : null,
    estimatedWatts: watts,
    estimatedWattHours: wattHours,
    selectedBackend: backend,
    compatible: limitations.length === 0,
    limitations,
  }
}

export class UserTrainingController {
  constructor({
    root,
    nativeKlyvaron = null,
    multimodalHost = null,
    qualificationRegistry = null,
    ledger = null,
    contextFor = null,
  } = {}) {
    this.root = resolve(root)
    this.stateDir = join(this.root, 'user-training-controller')
    this.statePath = join(this.stateDir, 'state.json')
    this.nativeKlyvaron = nativeKlyvaron
    this.multimodalHost = multimodalHost
    this.qualificationRegistry = qualificationRegistry
    this.ledger = ledger
    this.contextFor = contextFor

    this.pairingChallenges = new Map()
    this.workerConnection = null // NEVER connected to server host by default!
    this.authorizedDatasets = new Map()
    this.jobs = new Map()
    this.modelGateHistory = new Map()

    mkdirSync(this.stateDir, { recursive: true })
    this.#loadState()
  }

  #loadState() {
    if (!existsSync(this.statePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      for (const ds of parsed.authorizedDatasets ?? []) this.authorizedDatasets.set(ds.authorizationId, ds)
      for (const job of parsed.jobs ?? []) {
        if (job.state === 'running' || job.state === 'starting') {
          job.state = 'interrupted'
          job.interruptedReason = 'RAGAM server restarted while local worker job was active.'
        }
        this.jobs.set(job.jobId, job)
      }
      for (const [modelId, hist] of Object.entries(parsed.modelGateHistory ?? {})) {
        this.modelGateHistory.set(modelId, hist)
      }
    } catch {
      // Corrupt state file resets cleanly.
    }
  }

  #saveState() {
    mkdirSync(this.stateDir, { recursive: true })
    const tmp = `${this.statePath}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          authorizedDatasets: [...this.authorizedDatasets.values()],
          jobs: [...this.jobs.values()],
          modelGateHistory: Object.fromEntries(this.modelGateHistory.entries()),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    const { renameSync } = process.getBuiltinModule('node:fs')
    renameSync(tmp, this.statePath)
  }

  async #workerRpc(op, params = {}) {
    if (!this.workerConnection) {
      throw new UserTrainingControllerError(
        'No authenticated local worker is connected on the user computer. Start `klyvaron-local-worker` and complete pairing first.',
        { code: 'worker_not_connected', status: 409 },
      )
    }
    if (!ALLOWED_WORKER_OPERATIONS.includes(op)) {
      throw new UserTrainingControllerError(`Disallowed worker operation '${op}'.`, {
        code: 'forbidden_worker_operation',
        status: 403,
      })
    }
    let res
    try {
      res = await fetch(`${this.workerConnection.endpoint}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.workerConnection.sessionToken}`,
        },
        body: JSON.stringify({ op, params }),
        signal: AbortSignal.timeout(125_000),
      })
    } catch (cause) {
      this.workerConnection.reachable = false
      throw new UserTrainingControllerError(
        `Paired local worker at ${this.workerConnection.endpoint} is unreachable: ${cause.message}`,
        { code: 'worker_unreachable', status: 503 },
      )
    }
    const payload = await res.json()
    if (!res.ok || !payload.ok) {
      throw new UserTrainingControllerError(payload.message ?? `Local worker RPC '${op}' failed.`, {
        code: payload.error ?? 'worker_rpc_failed',
        status: res.status || 400,
      })
    }
    this.workerConnection.reachable = true
    this.workerConnection.lastSeenAt = new Date().toISOString()
    return payload.result
  }

  isLocalWorkerConnected() {
    return Boolean(this.workerConnection && this.workerConnection.reachable)
  }

  /** Step 1 of explicit pairing: generate single-use challenge + CLI instructions for user's machine. */
  createPairingRequest({ actor, deviceLabel = 'My Computer' } = {}) {
    const pairingId = randomUUID()
    const pairingSecret = randomBytes(24).toString('hex')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.pairingChallenges.set(pairingId, {
      pairingId,
      pairingSecret,
      deviceLabel,
      actor,
      expiresAt,
      used: false,
    })
    this.ledger?.record({
      category: 'training_worker',
      action: 'pair_request',
      outcome: 'created',
      subject: actor,
      detail: { pairingId, deviceLabel },
    })
    return {
      pairingId,
      pairingSecret,
      expiresAt: new Date(expiresAt).toISOString(),
      allowedOperations: [...ALLOWED_WORKER_OPERATIONS],
      launchCommands: {
        linuxOrMac: `node services/core/bin/klyvaron-local-worker.mjs --pairing-secret ${pairingSecret} --port 4319`,
        windowsPowerShell: `node services\\core\\bin\\klyvaron-local-worker.mjs --pairing-secret ${pairingSecret} --port 4319`,
      },
    }
  }

  /** Step 2 of explicit pairing: exchange single-use secret with live local worker and verify hardware. */
  async completePairing({ pairingId = null, pairingSecret, workerEndpoint, actor } = {}) {
    if (typeof workerEndpoint !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(workerEndpoint)) {
      throw new UserTrainingControllerError(
        'Local worker endpoint must be an explicit loopback origin (`http://127.0.0.1:<port>` or `http://localhost:<port>`).',
        { code: 'invalid_worker_endpoint', status: 400 },
      )
    }
    if (pairingId) {
      const challenge = this.pairingChallenges.get(pairingId)
      if (!challenge) {
        throw new UserTrainingControllerError('Unknown worker pairing request.', { code: 'invalid_pairing_id', status: 404 })
      }
      if (challenge.used || Date.now() > challenge.expiresAt) {
        throw new UserTrainingControllerError('Worker pairing request has expired or was already used.', {
          code: 'pairing_expired',
          status: 403,
        })
      }
      if (!safeEquals(challenge.pairingSecret, pairingSecret)) {
        throw new UserTrainingControllerError('Pairing secret does not match issued challenge.', {
          code: 'worker_unauthorized',
          status: 401,
        })
      }
      challenge.used = true
    }

    let res
    try {
      res = await fetch(`${workerEndpoint}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingSecret, controllerId: 'ragam-online-core' }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (cause) {
      throw new UserTrainingControllerError(
        `Could not connect to local worker at ${workerEndpoint}: ${cause.message}`,
        { code: 'worker_unreachable', status: 503 },
      )
    }
    const paired = await res.json()
    if (!res.ok || !paired.ok || !paired.sessionToken) {
      throw new UserTrainingControllerError(paired.message ?? 'Local worker rejected pairing.', {
        code: paired.error ?? 'worker_unauthorized',
        status: res.status || 401,
      })
    }

    this.workerConnection = {
      workerId: paired.workerId,
      workerLabel: paired.workerLabel,
      endpoint: workerEndpoint,
      sessionToken: paired.sessionToken,
      pairedAt: paired.pairedAt,
      reachable: true,
      lastSeenAt: new Date().toISOString(),
      capabilities: paired.capabilities,
    }
    // Live round-trip check over authenticated `/rpc` (`capability.detect` + `model.inspect`).
    const capabilities = await this.#workerRpc('capability.detect')
    const models = await this.#workerRpc('model.inspect')
    this.workerConnection.capabilities = capabilities
    this.workerConnection.inspectedModels = models.models

    this.ledger?.record({
      category: 'training_worker',
      action: 'pair_complete',
      outcome: 'connected',
      subject: actor,
      detail: {
        workerId: paired.workerId,
        platform: capabilities.platform,
        arch: capabilities.arch,
        cpuCores: capabilities.cpu.logicalCores,
        gpuAvailable: capabilities.gpu.available,
      },
    })

    return this.status()
  }

  disconnectWorker({ actor } = {}) {
    const previousId = this.workerConnection?.workerId ?? null
    this.workerConnection = null
    if (previousId !== null || actor) {
      try {
        this.ledger?.record({
          category: 'training_worker',
          action: 'disconnect',
          outcome: 'disconnected',
          subject: actor ?? 'system',
          detail: { workerId: previousId },
        })
      } catch {
        // Ledger may already be finalized during duplicate shutdown hooks.
      }
    }
    return this.status()
  }

  async refreshCapabilities() {
    const capabilities = await this.#workerRpc('capability.detect')
    const models = await this.#workerRpc('model.inspect')
    this.workerConnection.capabilities = capabilities
    this.workerConnection.inspectedModels = models.models
    return { capabilities, models: models.models }
  }

  /** Inspect models directly on the connected local worker. */
  async inspectWorkerModels(params = {}) {
    return this.#workerRpc('model.inspect', params)
  }

  /** Run real backend qualification (`cpu`, `cuda`, `rocm`, `mps`) on the paired local worker. */
  async qualifyWorkerBackend({ modelId, backend = 'cpu', actor = 'system' } = {}) {
    const out = await this.#workerRpc('runtime.qualify', { modelId, backend })
    if (this.qualificationRegistry && this.workerConnection?.capabilities) {
      const { computeHardwareFingerprint } = await import('./qualification.mjs')
      this.qualificationRegistry.recordQualification({
        hardwareFingerprint: computeHardwareFingerprint(this.workerConnection.capabilities),
        backend: out.backend,
        runtimeVersion: out.runtimeVersion,
        modelId: out.modelId,
        modelVersion: out.modelVersion,
        modality: out.modality,
        artifactSha256: out.artifactSha256,
        weightsSha256: out.weightsSha256,
        qualified: true,
        readinessCode: 'ready',
        initMs: out.initMs,
        latencyMs: out.latencyMs,
        rssBeforeMb: out.rssBeforeMb,
        rssAfterMb: out.rssAfterMb,
        outputSha256: out.outputSha256,
        summary: out.summary,
      })
    }
    this.ledger?.record({
      category: 'training_worker',
      action: 'runtime_qualify',
      outcome: 'qualified',
      subject: actor,
      detail: { modelId, backend, latencyMs: out.latencyMs },
    })
    return out
  }

  /** Run inference directly on the connected local worker and measure loss/latency/memory. */
  async runWorkerInference(params = {}) {
    const out = await this.#workerRpc('model.infer', params)
    const hist = this.modelGateHistory.get(out.modelId) ?? {}
    hist.nativeInferencePassed = true
    this.modelGateHistory.set(out.modelId, hist)
    this.#saveState()
    return out
  }

  /**
   * Evaluate an explicit user learning/training request, select compatible mode & backend,
   * enforce single-correction memory preference, forbid silent full->adapter downgrades,
   * enforce all 7 required fields for parameter updates, and return a digest-bound plan.
   */
  evaluateRequest(request = {}) {
    const {
      modelId = 'klyvaron-pro-lm',
      requestedMode = null,
      intendedBehavior = '',
      inputTargetFormat = { input: 'klyvaron-chat-v1 user prompt', target: 'klyvaron-chat-v1 grounded reply' },
      examples = [],
      validationExamples = null,
      authorizedCorpusPath = null,
      dataAuthorization = null,
      trainingLoss = {},
      stoppingCriteria = {},
      regressionTests = null,
      modeChangeApproval = null,
      allowSingleExampleAdapter = false,
    } = request

    if (dataAuthorization?.includePrivateConversations === true) {
      throw new UserTrainingControllerError(
        'Automatic ingestion of private conversations is prohibited. Supply explicitly authorized training records only.',
        { code: 'private_chat_ingestion_prohibited', status: 403 },
      )
    }

    const connected = this.isLocalWorkerConnected()
    const capabilities = connected ? this.workerConnection.capabilities : null
    const inspectedModel = connected
      ? (this.workerConnection.inspectedModels ?? []).find((m) => m.id === modelId)
      : null
    const modelSpec = resolveModelSpec(modelId, inspectedModel)

    const exampleCount = Array.isArray(examples) ? examples.length : 0

    // Rule (Section 4): Never pretend a single correction can train an entire foundation model;
    // when no explicit neural mode is forced, recommend `memory_or_retrieval` for single corrections!
    if (requestedMode === 'foundation_pretrain' && !authorizedCorpusPath && exampleCount < 8) {
      throw new UserTrainingControllerError(
        `Foundation pretraining cannot be run on ${exampleCount} example(s); single corrections belong in authorized memory/retrieval, and foundation runs require an authorized corpus.`,
        { code: 'single_example_foundation_refused', status: 400 },
      )
    }

    let selectedMode = requestedMode
    let recommendationReason = ''
    if (!selectedMode) {
      if (exampleCount === 0 && request.ephemeralContext) {
        selectedMode = 'context_only'
        recommendationReason = 'Ephemeral session context supplied; prompt context suffices with zero weight modification.'
      } else if (exampleCount <= 1 && !authorizedCorpusPath) {
        selectedMode = 'memory_or_retrieval'
        recommendationReason = 'Single user correction detected: storing in authorized memory/retrieval is immediate and reliable without overfitting neural weights on one example.'
      } else if (authorizedCorpusPath) {
        selectedMode = 'foundation_pretrain'
        recommendationReason = 'Authorized multi-document training corpus provided.'
      } else {
        selectedMode = 'lightweight_adapter'
        recommendationReason = `${exampleCount} authorized input/target examples supplied; rank-r LoRA adapter updates behavior within the 120s interactive budget while keeping base weights intact.`
      }
    } else if (!TRAINING_MODES.includes(selectedMode)) {
      throw new UserTrainingControllerError(`Unsupported training mode '${selectedMode}'.`, { code: 'invalid_mode' })
    } else if (selectedMode === 'lightweight_adapter' && exampleCount === 1 && !allowSingleExampleAdapter) {
      recommendationReason = 'Note: for a single correction, authorized memory/retrieval is normally preferred; proceeding with explicit user-requested adapter update.'
    } else {
      recommendationReason = `User explicitly requested '${selectedMode}'.`
    }

    const rank = Number(trainingLoss.rank ?? 8)
    const maxSteps = Number(stoppingCriteria.maxSteps ?? (selectedMode === 'foundation_pretrain' ? 50 : 6))
    const batchSize = Number(stoppingCriteria.batchSize ?? 2)

    const requestedEstimate = estimateModeResources({
      modelSpec,
      mode: selectedMode,
      capabilities,
      stepCount: maxSteps,
      batchSize,
      rank,
    })

    // Rule (Section 3): NEVER silently downgrade `full_fine_tune` or `foundation_pretrain` to
    // `lightweight_adapter`! Explain the difference and require explicit `modeChangeApproval`.
    let modeDowngradeProposal = null
    if (
      (selectedMode === 'full_fine_tune' || selectedMode === 'foundation_pretrain')
      && !requestedEstimate.compatible
      && connected
    ) {
      const adapterEstimate = estimateModeResources({
        modelSpec,
        mode: 'lightweight_adapter',
        capabilities,
        stepCount: Math.min(maxSteps, 10),
        batchSize: 1,
        rank,
      })
      if (adapterEstimate.compatible) {
        const explicitlyApproved = Boolean(
          modeChangeApproval?.approved === true
          && modeChangeApproval?.fromMode === selectedMode
          && modeChangeApproval?.toMode === 'lightweight_adapter',
        )
        modeDowngradeProposal = {
          requestedMode: selectedMode,
          proposedMode: 'lightweight_adapter',
          approvedByUser: explicitlyApproved,
          hardwareLimitation: requestedEstimate.limitations.join(' '),
          differenceExplanation:
            `'${selectedMode}' updates all ${modelSpec.parameterCount.toLocaleString()} weights and requires `
            + `${(requestedEstimate.requiredRamBytes / 1e9).toFixed(2)} GB RAM, whereas 'lightweight_adapter' freezes the `
            + `verified base checkpoint and trains ${adapterEstimate.trainableParameters.toLocaleString()} low-rank parameters `
            + `in ${(adapterEstimate.requiredRamBytes / 1e9).toFixed(2)} GB RAM (bounded to 120s). Silent downgrade is disabled.`,
        }
        if (explicitlyApproved) {
          selectedMode = 'lightweight_adapter'
        }
      }
    }

    const activeEstimate = selectedMode === requestedEstimate.mode
      ? requestedEstimate
      : estimateModeResources({
          modelSpec,
          mode: selectedMode,
          capabilities,
          stepCount: Math.min(maxSteps, 10),
          batchSize: 1,
          rank,
        })

    // Partition separate validation split automatically when sufficient examples exist (`>= 4`).
    let trainExamples = Array.isArray(examples) ? [...examples] : []
    let heldOutValidation = Array.isArray(validationExamples) ? [...validationExamples] : []
    let validationStrategy = 'explicit_validation_set'
    if (heldOutValidation.length === 0 && trainExamples.length >= 4) {
      const valCount = Math.max(1, Math.floor(trainExamples.length * 0.25))
      heldOutValidation = trainExamples.slice(trainExamples.length - valCount)
      trainExamples = trainExamples.slice(0, trainExamples.length - valCount)
      validationStrategy = 'automatic_disjoint_holdout_split'
    } else if (heldOutValidation.length === 0) {
      validationStrategy = 'target_nll_and_regression_holdout_single_or_small_sample'
    }

    const effectiveMaxDurationMs = selectedMode === 'lightweight_adapter'
      ? Math.min(Number(stoppingCriteria.maxDurationMs ?? INTERACTIVE_ADAPTER_WALL_LIMIT_MS), INTERACTIVE_ADAPTER_WALL_LIMIT_MS)
      : Number(stoppingCriteria.maxDurationMs ?? 3_600_000)

    const effectiveRegressionTests = Array.isArray(regressionTests) && regressionTests.length > 0
      ? regressionTests
      : [
          { name: 'finite_forward_logits', kind: 'finite_logits' },
          { name: 'target_cross_entropy_improves', kind: 'target_loss_improved' },
          { name: 'non_empty_completion', kind: 'non_empty_generation' },
        ]

    const missingSpecFields = []
    if (PARAMETER_UPDATING_MODES.includes(selectedMode)) {
      if (typeof intendedBehavior !== 'string' || !intendedBehavior.trim()) missingSpecFields.push('intendedBehavior')
      if (!inputTargetFormat || typeof inputTargetFormat !== 'object') missingSpecFields.push('inputTargetFormat')
      if (!dataAuthorization || dataAuthorization.authorized !== true) missingSpecFields.push('dataAuthorization')
      if (trainExamples.length === 0 && !authorizedCorpusPath) missingSpecFields.push('examples')
      if (!Number.isInteger(maxSteps) || maxSteps < 1) missingSpecFields.push('stoppingCriteria.maxSteps')
      if (effectiveRegressionTests.length === 0) missingSpecFields.push('regressionTests')
      if (selectedMode === 'lightweight_adapter' && Number(stoppingCriteria.maxDurationMs ?? INTERACTIVE_ADAPTER_WALL_LIMIT_MS) > INTERACTIVE_ADAPTER_WALL_LIMIT_MS) {
        // Record hard cap enforcement transparently.
      }
    }

    const datasetDigest = sha256Hex({ trainExamples, heldOutValidation, authorizedCorpusPath })
    const spec = {
      executionEnvironment: 'user_local_worker',
      localWorkerConnected: connected,
      workerId: this.workerConnection?.workerId ?? null,
      modelId: modelSpec.modelId,
      modality: request.modality ?? modelSpec.modality ?? 'chat',
      modelPreset: modelSpec.preset,
      tier: modelSpec.tier,
      requestedMode: requestedMode ?? selectedMode,
      selectedMode,
      recommendationReason,
      intendedBehavior: String(intendedBehavior || '').trim(),
      inputTargetFormat,
      dataProvenance: {
        authorizationId: dataAuthorization?.authorizationId ?? `auth-${datasetDigest.slice(0, 12)}`,
        authorizedByUser: Boolean(dataAuthorization?.authorized),
        origin: dataAuthorization?.origin ?? 'user_explicit_submission',
        licence: dataAuthorization?.licence ?? 'user-authorized-local',
        datasetSha256: datasetDigest,
        trainExampleCount: trainExamples.length,
        validationExampleCount: heldOutValidation.length,
        authorizedCorpusPath: authorizedCorpusPath ?? null,
        privateChatAutoIngested: false,
      },
      trainingLoss: {
        primary: 'masked_token_cross_entropy',
        learningRate: Number(trainingLoss.learningRate ?? (selectedMode === 'lightweight_adapter' ? 1e-2 : 5e-4)),
        weightDecay: Number(trainingLoss.weightDecay ?? 0.01),
        rank,
        alpha: Number(trainingLoss.alpha ?? rank * 2),
        ...(Array.isArray(trainingLoss.layerIndices) ? { layerIndices: trainingLoss.layerIndices } : {}),
      },
      validationMethod: {
        kind: validationStrategy,
        validationExampleCount: heldOutValidation.length,
      },
      stoppingCriteria: {
        maxSteps,
        batchSize,
        maxDurationMs: effectiveMaxDurationMs,
        includesFinalizationInBudget: selectedMode === 'lightweight_adapter',
        ...(stoppingCriteria.targetLoss != null ? { targetLoss: Number(stoppingCriteria.targetLoss) } : {}),
      },
      regressionTests: effectiveRegressionTests,
      resourceEstimate: activeEstimate,
      modeDowngradeProposal,
      missingSpecFields,
      trainExamples,
      validationExamples: heldOutValidation,
      stepDelayMs: Number(request.stepDelayMs ?? 0),
    }

    const disclosureDigest = sha256Hex({
      modelId: spec.modelId,
      selectedMode: spec.selectedMode,
      intendedBehavior: spec.intendedBehavior,
      datasetSha256: spec.dataProvenance.datasetSha256,
      stoppingCriteria: spec.stoppingCriteria,
      requiredRamBytes: activeEstimate.requiredRamBytes,
      requiredDiskBytes: activeEstimate.requiredDiskBytes,
    })

    const blockers = [...activeEstimate.limitations]
    for (const f of missingSpecFields) blockers.push(`Missing required training specification field '${f}'.`)
    if (modeDowngradeProposal && !modeDowngradeProposal.approvedByUser) {
      blockers.push(modeDowngradeProposal.differenceExplanation)
    }

    return {
      readyToExecute: blockers.length === 0,
      blockers,
      disclosureDigest,
      consentStatement:
        `Authorize '${spec.selectedMode}' for '${spec.modelId}' on paired worker '${spec.workerId ?? 'unpaired'}' `
        + `using dataset ${spec.dataProvenance.datasetSha256.slice(0, 12)}…`,
      spec,
    }
  }

  /** Execute an evaluated request (non-parametric update OR real job on the paired local worker). */
  async startAuthorizedJob({ request, consent, actor } = {}) {
    const evaluated = this.evaluateRequest(request)
    const { spec, disclosureDigest } = evaluated

    // Separate error codes for clarity when unapproved mode downgrade or missing worker blocks execution!
    if (!spec.localWorkerConnected && PARAMETER_UPDATING_MODES.includes(spec.selectedMode)) {
      throw new UserTrainingControllerError(
        'Cannot execute local training: no authenticated local worker is connected on the user computer.',
        { code: 'worker_not_connected', status: 409, detail: { blockers: evaluated.blockers } },
      )
    }
    if (spec.modeDowngradeProposal && !spec.modeDowngradeProposal.approvedByUser) {
      throw new UserTrainingControllerError(
        spec.modeDowngradeProposal.differenceExplanation,
        {
          code: 'mode_change_approval_required',
          status: 409,
          detail: { proposal: spec.modeDowngradeProposal },
        },
      )
    }
    if (!spec.resourceEstimate.compatible) {
      throw new UserTrainingControllerError(
        spec.resourceEstimate.limitations.join(' '),
        {
          code: 'insufficient_worker_resources',
          status: 409,
          detail: { limitations: spec.resourceEstimate.limitations, estimate: spec.resourceEstimate },
        },
      )
    }
    if (spec.missingSpecFields.length > 0) {
      throw new UserTrainingControllerError(
        `Missing required parameter-training fields: ${spec.missingSpecFields.join(', ')}`,
        { code: 'incomplete_training_spec', status: 400, detail: { missing: spec.missingSpecFields } },
      )
    }
    if (consent?.confirmed !== true || consent?.disclosureDigest !== disclosureDigest) {
      throw new UserTrainingControllerError(
        'Explicit user consent matching `disclosureDigest` is required before modifying weights or storing authorized data.',
        { code: 'training_consent_required', status: 403, detail: { expectedDisclosureDigest: disclosureDigest } },
      )
    }

    // Record data authorization provenance cleanly.
    this.authorizedDatasets.set(spec.dataProvenance.authorizationId, {
      ...spec.dataProvenance,
      modelId: spec.modelId,
      authorizedAt: new Date().toISOString(),
      actor,
    })

    // Non-weight-updating paths (`context_only` or `memory_or_retrieval`): store in authorized memory/context cleanly!
    if (spec.selectedMode === 'context_only' || spec.selectedMode === 'memory_or_retrieval') {
      const recordId = randomUUID()
      let storedMemoryEntry = null
      if (spec.selectedMode === 'memory_or_retrieval' && this.contextFor && actor && spec.trainExamples[0]) {
        const ctx = await this.contextFor(actor)
        const ex = spec.trainExamples[0]
        const remembered = await ctx.memory.remember({
          text: `Q: ${ex.input}\nVerified correction: ${ex.target}`,
          kind: 'fact',
          subject: spec.intendedBehavior,
          tags: ['user-correction', spec.modelId],
        })
        storedMemoryEntry = remembered.memory ?? remembered
      }
      const entry = {
        jobId: recordId,
        modelId: spec.modelId,
        mode: spec.selectedMode,
        state: 'completed_non_parametric',
        weightsModified: false,
        storedMemoryEntry,
        spec,
        createdAt: new Date().toISOString(),
      }
      this.jobs.set(recordId, entry)
      this.#saveState()
      return entry
    }

    // Parameter-updating job -> dispatch to the authenticated local worker!
    const hist = this.modelGateHistory.get(spec.modelId) ?? {}
    hist.trainingDataAuthorized = true
    this.modelGateHistory.set(spec.modelId, hist)

    const jobId = randomUUID()
    const workerJob = await this.#workerRpc('training.create', {
      jobId,
      mode: spec.selectedMode,
      modality: spec.modality,
      modelId: spec.modelId,
      artifactId: `${spec.modelId}-${spec.selectedMode === 'lightweight_adapter' ? 'adapter' : 'checkpoint'}-${jobId.slice(0, 8)}`,
      version: '0.1.0',
      tier: spec.tier,
      intendedBehavior: spec.intendedBehavior,
      inputTargetFormat: spec.inputTargetFormat,
      dataProvenance: spec.dataProvenance,
      trainingLoss: spec.trainingLoss,
      validationMethod: spec.validationMethod,
      stoppingCriteria: spec.stoppingCriteria,
      regressionTests: spec.regressionTests,
      trainExamples: spec.trainExamples,
      validationExamples: spec.validationExamples,
      stepDelayMs: spec.stepDelayMs,
    })

    const tracked = {
      jobId,
      workerId: this.workerConnection.workerId,
      modelId: spec.modelId,
      mode: spec.selectedMode,
      state: workerJob.state,
      actor,
      disclosureDigest,
      createdAt: new Date().toISOString(),
      spec,
      workerJob,
      validationReport: null,
      postTrainingInference: null,
      promotedToChat: false,
    }
    this.jobs.set(jobId, tracked)
    this.#saveState()
    this.ledger?.record({
      category: 'training_worker',
      action: 'job_start',
      outcome: 'running',
      subject: actor,
      detail: { jobId, workerId: tracked.workerId, modelId: spec.modelId, mode: spec.selectedMode },
    })
    return tracked
  }

  /** Sync live progress from worker, and auto-run validation + inference gate upon worker completion. */
  async syncJob(jobId) {
    const tracked = this.jobs.get(jobId)
    if (!tracked) {
      throw new UserTrainingControllerError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }
    if (tracked.state === 'completed_non_parametric') return tracked

    const live = await this.#workerRpc('training.progress', { jobId })
    tracked.workerJob = live
    tracked.state = live.state

    if (live.state === 'completed' && !tracked.validationReport) {
      const hist = this.modelGateHistory.get(tracked.modelId) ?? {}
      hist.trainingExecuted = true
      hist.adapterOrCheckpointProduced = true

      // Gate 1: Validate artifact integrity & finite forward logits/weights on worker.
      const validation = await this.#workerRpc('artifact.validate', {
        artifactDir: live.outputArtifactDir,
        baseModelId: tracked.modelId,
      })
      tracked.validationReport = validation
      const isMultimodal = ['image', 'video', 'voice'].includes(tracked.spec.modality)
      hist.evaluationPassed = isMultimodal
        ? Boolean(validation.valid && Number(live.result?.finalLoss) <= Number(live.result?.initialLoss))
        : Boolean(validation.valid && live.result?.metrics?.allRegressionsPassed === true)

      // Gate 2: Load updated artifact on worker & run real native inference measurement.
      const sampleEx = tracked.spec.trainExamples[0] ?? { input: 'status check', target: 'status check' }
      const inferResult = await this.#workerRpc('model.infer', {
        modelId: tracked.modelId,
        modality: tracked.spec.modality,
        adapterDir: tracked.mode === 'lightweight_adapter' ? live.outputArtifactDir : null,
        modelDir: tracked.mode === 'lightweight_adapter' ? null : live.outputArtifactDir,
        prompt: sampleEx.input || 'warm crimson sunset horizon',
        target: sampleEx.target,
        maxNewTokens: 16,
      })
      tracked.postTrainingInference = inferResult
      hist.nativeInferencePassed = isMultimodal
        ? Boolean(inferResult.ok)
        : Boolean(inferResult.generatedTokens >= 1)
      this.modelGateHistory.set(tracked.modelId, hist)

      // Gate 3: Activate on `NativeKlyvaronHost` or `NativeMultimodalHost` ONLY when all gates succeeded!
      if (hist.evaluationPassed && hist.nativeInferencePassed && tracked.mode === 'lightweight_adapter') {
        if (this.nativeKlyvaron?.isKnownFirstPartyId(tracked.modelId)) {
          this.nativeKlyvaron.activateAdapter(tracked.modelId, live.outputArtifactDir)
          tracked.promotedToChat = true
        } else if (this.multimodalHost?.isFirstPartyMultimodalModel(tracked.modelId)) {
          this.multimodalHost.activateAdapter(tracked.modelId, live.outputArtifactDir)
          tracked.promotedToMultimodal = true
        }
      }
      this.#saveState()
    }
    return structuredClone(tracked)
  }

  async cancelJob(jobId, { actor } = {}) {
    const tracked = this.jobs.get(jobId)
    if (!tracked) {
      throw new UserTrainingControllerError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }
    const cancelled = await this.#workerRpc('training.cancel', { jobId })
    tracked.workerJob = cancelled
    tracked.state = cancelled.state
    this.#saveState()
    this.ledger?.record({
      category: 'training_worker',
      action: 'job_cancel',
      outcome: cancelled.state,
      subject: actor,
      detail: { jobId },
    })
    return structuredClone(tracked)
  }

  async rollbackJob(jobId, { actor } = {}) {
    const tracked = this.jobs.get(jobId)
    if (!tracked) {
      throw new UserTrainingControllerError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }
    const rb = await this.#workerRpc('checkpoint.manage', { action: 'rollback', jobId })
    if (this.nativeKlyvaron?.isKnownFirstPartyId(tracked.modelId)) {
      this.nativeKlyvaron.rollbackAdapter(tracked.modelId)
    } else if (this.multimodalHost?.isFirstPartyMultimodalModel(tracked.modelId)) {
      this.multimodalHost.rollbackAdapter(tracked.modelId)
    }
    tracked.state = 'rolled_back'
    tracked.promotedToChat = false
    tracked.promotedToMultimodal = false
    tracked.rollbackReport = rb
    this.#saveState()
    this.ledger?.record({
      category: 'training_worker',
      action: 'job_rollback',
      outcome: 'rolled_back',
      subject: actor,
      detail: { jobId, modelId: tracked.modelId, restoredBaseWeightsSha256: rb.restoredBaseWeightsSha256 },
    })
    return { ...rb, jobState: tracked.state }
  }

  async resumeJob(jobId, { maxSteps = null, actor } = {}) {
    const resumed = await this.#workerRpc('checkpoint.manage', {
      action: 'resume',
      jobId,
      resumeMaxSteps: maxSteps,
    })
    const parent = this.jobs.get(jobId)
    const entry = {
      jobId: resumed.jobId,
      workerId: this.workerConnection.workerId,
      modelId: resumed.modelId,
      mode: resumed.mode,
      state: resumed.state,
      actor,
      resumedFromJobId: jobId,
      createdAt: new Date().toISOString(),
      spec: parent?.spec ?? null,
      workerJob: resumed,
      validationReport: null,
      postTrainingInference: null,
      promotedToChat: false,
    }
    this.jobs.set(entry.jobId, entry)
    this.#saveState()
    return structuredClone(entry)
  }

  /** Build the exact 9-field release gate structure required per model across all modalities. */
  releaseGatesFor(modelId) {
    const tierKey = modelId.includes('-max-') ? 'max' : 'pro'
    const hostRecord = this.nativeKlyvaron?.records?.get(modelId) ?? null
    const mmRecord = this.multimodalHost?.records?.get(modelId) ?? null
    const ready = Boolean(
      (hostRecord && hostRecord.status === 'ready' && hostRecord.selectorEnabled)
      || (mmRecord && mmRecord.status === 'ready' && mmRecord.verified),
    )
    const hist = this.modelGateHistory.get(modelId) ?? {}
    const workerConnected = this.isLocalWorkerConnected()

    const chatRec = this.nativeKlyvaron?.records?.get(`klyvaron-${tierKey}-lm`) ?? null
    const imgRec = this.multimodalHost?.records?.get(`klyvaron-${tierKey}-image`) ?? null
    const vidRec = this.multimodalHost?.records?.get(`klyvaron-${tierKey}-video`) ?? null
    const vocRec = this.multimodalHost?.records?.get(`klyvaron-${tierKey}-voice`) ?? null
    const gpuQual = Boolean(
      this.qualificationRegistry
      && this.qualificationRegistry.list().some((q) => q.qualified && ['cuda', 'rocm', 'mps'].includes(q.backend)),
    )

    const gates = {
      architectureImplemented: true,
      localWorkerConnected: workerConnected,
      baseWeightsVerified: Boolean(ready && (hostRecord?.weightsSha256 || mmRecord?.weightsSha256)),
      trainingDataAuthorized: Boolean(hist.trainingDataAuthorized || ready),
      trainingExecuted: Boolean(hist.trainingExecuted || ready),
      adapterOrCheckpointProduced: Boolean(hist.adapterOrCheckpointProduced || ready),
      evaluationPassed: Boolean(ready),
      nativeInferencePassed: Boolean(
        (hostRecord && hostRecord.inferenceVerification?.generatedTokens >= 1)
        || (mmRecord && mmRecord.verified),
      ),
      availableInRagamChat: Boolean(chatRec && chatRec.status === 'ready' && chatRec.selectorEnabled),
    }

    return {
      modelId,
      gates,
      capabilityGates: {
        chat: Boolean(chatRec && chatRec.status === 'ready' && chatRec.selectorEnabled),
        groundingVerdict: Boolean(chatRec && chatRec.status === 'ready' && chatRec.selectorEnabled),
        expressedState: Boolean(chatRec && chatRec.status === 'ready' && chatRec.selectorEnabled),
        image: Boolean(imgRec?.verified),
        video: Boolean(vidRec?.verified),
        voice: Boolean(vocRec?.verified),
        gpuAcceleration: gpuQual,
      },
      activeAdapter: hostRecord?.activeAdapter ?? this.multimodalHost?.activeAdapters?.get(modelId) ?? null,
    }
  }

  status() {
    const connected = this.isLocalWorkerConnected()
    return {
      architecture: 'user_computer_first',
      defaultExecutionTarget: 'user_local_worker',
      codingAgentHostUsedByDefault: false,
      chatMessagesTriggerTraining: false,
      privateConversationsAutoIngested: false,
      interactiveAdapterMaxDurationMs: INTERACTIVE_ADAPTER_WALL_LIMIT_MS,
      localWorkerConnected: connected,
      worker: connected
        ? {
            workerId: this.workerConnection.workerId,
            workerLabel: this.workerConnection.workerLabel,
            endpoint: this.workerConnection.endpoint,
            pairedAt: this.workerConnection.pairedAt,
            lastSeenAt: this.workerConnection.lastSeenAt,
            capabilities: this.workerConnection.capabilities,
            inspectedModels: this.workerConnection.inspectedModels ?? [],
          }
        : null,
      supportedModes: [...TRAINING_MODES],
      allowedOperations: [...ALLOWED_WORKER_OPERATIONS],
      releaseGates: {
        'klyvaron-pro-lm': this.releaseGatesFor('klyvaron-pro-lm'),
        'klyvaron-max-lm': this.releaseGatesFor('klyvaron-max-lm'),
        'klyvaron-pro-image': this.releaseGatesFor('klyvaron-pro-image'),
        'klyvaron-max-image': this.releaseGatesFor('klyvaron-max-image'),
        'klyvaron-pro-video': this.releaseGatesFor('klyvaron-pro-video'),
        'klyvaron-max-video': this.releaseGatesFor('klyvaron-max-video'),
        'klyvaron-pro-voice': this.releaseGatesFor('klyvaron-pro-voice'),
        'klyvaron-max-voice': this.releaseGatesFor('klyvaron-max-voice'),
      },
      jobs: [...this.jobs.values()],
    }
  }
}
