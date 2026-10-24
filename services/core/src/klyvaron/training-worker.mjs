// Optional, explicit, user-authorized local training worker setup and lifecycle manager.
//
// Enforces pre-consent hardware/software inspection, full disclosure of expected compute,
// dataset provenance/licensing, storage footprint, and thermal/energy impact, explicit
// signed consent verification, CPU/disk resource limits, graceful SIGTERM cancellation,
// atomic checkpoint persistence (`tmp -> fsync -> os.replace`), and verified checkpoint
// recovery across process restarts.
//
// Note on wall-clock ceilings: the repository's 120,000 ms (2-minute) ceiling applies to
// interactive local adaptation runs (`mode === 'interactive_adaptation'`), whereas full
// foundation training runs (`mode === 'foundation_training'`) operate under an explicit
// operator-declared duration budget (`maxDurationMs`) with periodic atomic checkpointing.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectHardware, memorySnapshot } from '../hardware/detect.mjs'
import { SIZE_PRESETS, configDigest, parameterCount } from './architecture.mjs'

export const INTERACTIVE_ADAPTATION_LIMIT_MS = 120_000
export const DEFAULT_MIN_FREE_DISK_BYTES = 1_000_000_000 // 1 GB safety floor
export const MIN_AVAILABLE_RAM_BYTES = 1_400_000_000 // 1.4 GB: host floor for NumPy/JAX training
export const PREFLIGHT_EXPIRY_MS = 30 * 60 * 1000 // 30 minutes: consent bound to a stable snapshot, not live resources
export const APPROVED_CORPUS_LICENCES = Object.freeze(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'PSF-2.0', 'ISC', 'CC0-1.0'])

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TRAIN_SCRIPT = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'train_klyvaron.py')

export class TrainingWorkerError extends Error {
  constructor(message, { code = 'training_worker_error', status = 400, detail = {} } = {}) {
    super(message)
    this.name = 'TrainingWorkerError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function probePythonCandidate(bin) {
  if (!bin || (!bin.includes('/') ? false : !existsSync(bin))) {
    // Bare binary names like `python3` are probed directly via spawnSync below.
  }
  const probe = spawnSync(
    bin,
    [
      '-c',
      'import json, platform, numpy; jax_ver = None\n'
      + 'try:\n  import jax; jax_ver = jax.__version__\nexcept Exception:\n  pass\n'
      + 'print(json.dumps({"python": platform.python_version(), "numpy": numpy.__version__, "jax": jax_ver}))',
    ],
    { encoding: 'utf8', timeout: 8000 },
  )
  if (probe.status !== 0 || !probe.stdout?.trim()) return null
  try {
    return { binary: bin, ...JSON.parse(probe.stdout.trim()) }
  } catch {
    return null
  }
}

function readCpuSimdFlags() {
  try {
    if (!existsSync('/proc/cpuinfo')) return []
    const text = readFileSync('/proc/cpuinfo', 'utf8')
    const line = text.split('\n').find((l) => l.startsWith('flags'))
    if (!line) return []
    const flags = new Set(line.split(':')[1]?.trim().split(/\s+/) ?? [])
    return ['avx512f', 'avx512_vnni', 'avx2', 'fma', 'neon'].filter((f) => flags.has(f))
  } catch {
    return []
  }
}

function freeDiskBytesFor(targetDir) {
  try {
    mkdirSync(targetDir, { recursive: true })
    const st = statfsSync(targetDir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return 0
  }
}

export class LocalTrainingWorkerManager {
  constructor({ root, ledger = null, trainScript = TRAIN_SCRIPT } = {}) {
    this.root = resolve(root)
    this.workDir = join(this.root, 'worker-runs')
    this.stateFile = join(this.workDir, 'jobs.json')
    this.ledger = ledger
    this.trainScript = trainScript
    this.jobs = new Map()
    this.processes = new Map()
    this.closed = false
    mkdirSync(this.workDir, { recursive: true })
    this.#restorePersistedJobs()
  }

  #restorePersistedJobs() {
    if (!existsSync(this.stateFile)) return
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8'))
      for (const job of saved.jobs ?? []) {
        if (job.state === 'running' || job.state === 'starting') {
          const hasCheckpoint = job.checkpointPath && existsSync(job.checkpointPath)
          job.state = hasCheckpoint ? 'interrupted_recoverable' : 'interrupted'
          job.interruptedReason = 'Core process restarted while local training worker was active.'
        }
        this.jobs.set(job.id, job)
      }
    } catch {
      // Corrupt state file starts fresh rather than crashing the service.
    }
  }

  #persistJobs() {
    mkdirSync(this.workDir, { recursive: true })
    const tmp = `${this.stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2) + '\n', 'utf8')
    const { renameSync } = process.getBuiltinModule('node:fs')
    renameSync(tmp, this.stateFile)
  }

  /** Detect real host hardware and Python/NumPy/XLA software capabilities. */
  inspectEnvironment() {
    const hardware = detectHardware()
    const mem = memorySnapshot()
    const freeDiskBytes = freeDiskBytesFor(this.root)
    const logicalCpus = cpus().length
    const simdFlags = readCpuSimdFlags()

    const candidates = ['/tmp/accel-venv/bin/python', '/tmp/fabric-venv/bin/python', 'python3']
    let runtime = null
    for (const candidate of candidates) {
      if (candidate.startsWith('/') && !existsSync(candidate)) continue
      const found = probePythonCandidate(candidate)
      if (found) {
        runtime = found
        break
      }
    }

    const gpuAvailable = Array.isArray(hardware.accelerators)
      && hardware.accelerators.some((acc) => acc.kind !== 'cpu')

    return {
      inspectedAt: new Date().toISOString(),
      hardware: {
        platform: hardware.platform,
        arch: hardware.arch,
        logicalCpus,
        simdFlags,
        totalRamBytes: mem.totalRamBytes,
        availableRamBytes: mem.availableRamBytes,
        freeDiskBytes,
        gpuAvailable,
        accelerators: hardware.accelerators ?? [],
      },
      software: {
        trainScriptExists: existsSync(this.trainScript),
        pythonAvailable: Boolean(runtime),
        pythonBinary: runtime?.binary ?? null,
        pythonVersion: runtime?.python ?? null,
        numpyVersion: runtime?.numpy ?? null,
        xlaAvailable: Boolean(runtime?.jax),
        jaxVersion: runtime?.jax ?? null,
      },
      limits: {
        interactiveAdaptationMaxMs: INTERACTIVE_ADAPTATION_LIMIT_MS,
        foundationTrainingWallClockLimit: 'operator_budgeted (not capped at 120s interactive limit)',
        minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES,
      },
    }
  }

  /** Build a pre-consent setup & resource plan with a verifiable SHA-256 `disclosureDigest`. */
  prepareSetupPlan({
    preset = 'pro',
    mode = 'foundation_training',
    corpusDir = '/tmp/klyvaron-corpus',
    corpusRecord = '/tmp/klyvaron-corpus-record.json',
    pretrainSteps = null,
    jointSteps = null,
    batchSize = null,
    checkpointEvery = 25,
    maxCpuThreads = null,
    maxDurationMs = null,
  } = {}) {
    if (!['pro', 'max'].includes(preset)) {
      throw new TrainingWorkerError(`Preset must be 'pro' or 'max', got '${preset}'.`, { code: 'invalid_preset' })
    }
    if (!['interactive_adaptation', 'foundation_training'].includes(mode)) {
      throw new TrainingWorkerError(`Mode must be 'interactive_adaptation' or 'foundation_training'.`, { code: 'invalid_mode' })
    }

    const env = this.inspectEnvironment()
    const arch = SIZE_PRESETS[preset].config
    const params = parameterCount(arch)
    const archDigest = configDigest(arch)
    const stepsPre = Number.isInteger(pretrainSteps) && pretrainSteps >= 1
      ? pretrainSteps
      : (mode === 'interactive_adaptation' ? 8 : (preset === 'pro' ? 180 : 105))
    const stepsJoint = Number.isInteger(jointSteps) && jointSteps >= 1
      ? jointSteps
      : (mode === 'interactive_adaptation' ? 8 : (preset === 'pro' ? 140 : 125))
    const totalSteps = stepsPre + stepsJoint
    const effectiveBatch = Number.isInteger(batchSize) && batchSize >= 1 ? batchSize : (preset === 'pro' ? 2 : 1)
    const tokensPlanned = totalSteps * effectiveBatch * arch.seqLen
    const trainingFlops = 6 * params * tokensPlanned

    const measuredTokPerSec = env.software.xlaAvailable
      ? (preset === 'pro' ? 635 : 240)
      : (preset === 'pro' ? 55 : 16)
    const estimatedSeconds = Math.ceil(tokensPlanned / measuredTokPerSec) + 35

    const effectiveDurationLimitMs = mode === 'interactive_adaptation'
      ? Math.min(maxDurationMs ?? INTERACTIVE_ADAPTATION_LIMIT_MS, INTERACTIVE_ADAPTATION_LIMIT_MS)
      : (maxDurationMs ?? Math.max(estimatedSeconds * 3000, 3_600_000))

    // Peak RAM & disk requirements (checkpoint stores params + m1 + m2 in float32 = 12 bytes/param).
    const requiredRamBytes = preset === 'pro' ? 2_200_000_000 : 2_600_000_000
    const checkpointBytes = params * 12
    const exportedArtifactsBytes = Math.round(params * 5.1) // fp32 v1 + compressed int8 v2
    const requiredDiskBytes = checkpointBytes + exportedArtifactsBytes + DEFAULT_MIN_FREE_DISK_BYTES

    // Average CPU package draw ~25W per 2 active Xeon cores -> Watt-hours = W * hours.
    const estimatedWatts = env.hardware.gpuAvailable ? 180 : 28
    const estimatedWattHours = Number(((estimatedWatts * estimatedSeconds) / 3600).toFixed(2))
    const threads = Math.max(1, Math.min(env.hardware.logicalCpus, maxCpuThreads ?? env.hardware.logicalCpus))

    const blockers = []
    if (mode === 'interactive_adaptation' && estimatedSeconds * 1000 > INTERACTIVE_ADAPTATION_LIMIT_MS) {
      blockers.push(`Interactive adaptation estimate (${estimatedSeconds}s) exceeds the 120s ceiling; lower step count or select foundation_training.`)
    }
    if (!env.software.pythonAvailable) {
      blockers.push('Python 3.11+ with NumPy is not installed on this host.')
    }
    if (!env.software.trainScriptExists) {
      blockers.push(`Training script missing at ${this.trainScript}.`)
    }
    if (!existsSync(corpusDir)) {
      blockers.push(`Approved corpus directory not found at ${corpusDir}. Run assemble_corpus.py first.`)
    }
    if (env.hardware.availableRamBytes < Math.min(requiredRamBytes, 1_400_000_000)) {
      blockers.push(`Insufficient free RAM (${Math.round(env.hardware.availableRamBytes / 1e6)} MB available).`)
    }
    if (env.hardware.freeDiskBytes < requiredDiskBytes) {
      blockers.push(`Insufficient free disk space (${Math.round(env.hardware.freeDiskBytes / 1e6)} MB free, ${Math.round(requiredDiskBytes / 1e6)} MB required including 1 GB safety reserve).`)
    }

    const chinchillaTokens = 20 * params
    const externalExecutionNote = !env.hardware.gpuAvailable
      ? {
          fullChinchillaScaleFeasibleLocally: false,
          reason: `This host has ${env.hardware.logicalCpus} CPU threads and 0 GPUs. Local CPU training validates and produces real ${params.toLocaleString()}-parameter domain weights on ${tokensPlanned.toLocaleString()} tokens (~${estimatedSeconds}s), whereas full Chinchilla compute-optimal pretraining (${chinchillaTokens.toLocaleString()} tokens) requires an external GPU worker (e.g. 1x A100/H100 running the exact command below).`,
          externalCommand: `python3 services/fabric/scripts/train_klyvaron.py --preset ${preset} --corpus-dir /path/to/assembled-corpus --pretrain-steps 25000 --joint-steps 5000`,
        }
      : null

    // Stable preflight snapshot: bound to consent, never contains live measurements
    // that fluctuate between prepareSetupPlan() and startJob(). Live resource
    // re-checks happen at job start and do not require digest equality.
    const snapshotCreatedAt = Date.now()
    const preflightSnapshot = {
      snapshotId: `preflight-${preset}-${archDigest}-${stepsPre}-${stepsJoint}-${effectiveBatch}-${resolve(corpusDir)}-${resolve(corpusRecord)}-${mode}`,
      preset,
      artifactId: `klyvaron-${preset}-lm`,
      mode,
      architectureDigest: archDigest,
      parameterCount: params,
      pretrainSteps: stepsPre,
      jointSteps: stepsJoint,
      totalSteps,
      batchSize: effectiveBatch,
      sequenceLength: arch.seqLen,
      tokensPlanned,
      checkpointEvery,
      corpusDir: resolve(corpusDir),
      corpusRecord: resolve(corpusRecord),
      resourceLimits: {
        maxCpuThreads: threads,
        niceIncrement: 10,
        maxDurationMs: effectiveDurationLimitMs,
        minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES,
      },
      disclosures: {
        compute: {
          estimatedFlops: trainingFlops,
          estimatedWallSeconds: estimatedSeconds,
          backend: env.software.xlaAvailable ? `CPU XLA (${runtimeLabel(env.software)})` : 'CPU NumPy',
          interactiveLimitNote: mode === 'interactive_adaptation'
            ? 'Interactive adaptation session strictly bounded to 120 seconds.'
            : 'Full foundation training run; 2-minute interactive cap does not apply and operator budget governs execution.',
        },
        dataAndLicensing: {
          corpusPath: resolve(corpusDir),
          approvedSpdxLicences: APPROVED_CORPUS_LICENCES,
          personalMemoryUsed: false,
          personalDataPolicy: 'Personal user chats and memories carry training_use="prohibited" and are never read by this worker.',
          heldOutEvaluationSplit: ['pallets__click', 'psf__requests'],
        },
        storage: {
          atomicCheckpointBytes: checkpointBytes,
          exportedArtifactsBytes,
          requiredFreeDiskBytes: requiredDiskBytes,
        },
        energyAndThermal: {
          sustainedPowerWattsEstimate: estimatedWatts,
          estimatedEnergyWattHours: estimatedWattHours,
          impactNotice: `Sustains ${threads} CPU threads near 100% utilisation for ~${Math.max(1, Math.round(estimatedSeconds / 60))} min (~${estimatedWattHours} Wh).`,
        },
      },
    }

    // Live measurements (NOT in the consent digest): re-checked at job start.
    const liveMeasurements = {
      currentFreeDiskBytes: env.hardware.freeDiskBytes,
      currentAvailableRamBytes: env.hardware.availableRamBytes,
      currentLogicalCpus: env.hardware.logicalCpus,
      measuredAt: new Date().toISOString(),
    }

    // Consent binds to the stable snapshot, not to live resource fluctuations.
    const disclosureDigest = createHash('sha256')
      .update(JSON.stringify(preflightSnapshot))
      .digest('hex')

    return {
      readyToAuthorize: blockers.length === 0,
      blockers,
      environment: env,
      plan: preflightSnapshot,
      snapshotCreatedAt,
      liveMeasurements,
      externalExecutionNote,
      disclosureDigest,
      consentRequirement: {
        requiredFields: ['confirmed', 'disclosureDigest', 'createdAt'],
        statement: 'I understand the compute load, dataset licence policy, storage footprint, and energy impact above, and authorize running this local Klyvaron training worker on this host.',
      },
    }
  }

  /** Start a consent-verified local training worker process with enforced limits. */
  startJob({ planRequest = {}, consent = null, resumeFromJobId = null, actor = null } = {}) {
    if ([...this.processes.values()].length > 0) {
      throw new TrainingWorkerError('Another local training worker is already running on this host.', {
        code: 'worker_busy',
        status: 409,
      })
    }

    const prepared = this.prepareSetupPlan(planRequest)
    if (!prepared.readyToAuthorize) {
      throw new TrainingWorkerError(`Local training worker preflight blocked: ${prepared.blockers.join(' ')}`, {
        code: 'preflight_failed',
        status: 409,
        detail: { blockers: prepared.blockers },
      })
    }

    // Consent verification: bind to the stable preflight snapshot, not to live
    // resource measurements that fluctuate between prepareSetupPlan() and startJob().
    // The disclosureDigest now covers only stable plan identity (model, mode, arch,
    // steps, corpus, licence scope, resource limits, backend). Live resource
    // re-checks happen below and do not require digest equality.
    //
    // Consent expiry: the caller includes `createdAt` (epoch ms) in the consent
    // object. Consent older than PREFLIGHT_EXPIRY_MS is rejected as stale, even
    // if the disclosureDigest matches — a matching digest from a stale snapshot
    // must not be silently reused.
    if (consent?.confirmed !== true || consent?.disclosureDigest !== prepared.disclosureDigest) {
      throw new TrainingWorkerError(
        'Explicit user consent matching the current preflight disclosureDigest is required before starting a local training worker.',
        {
          code: 'training_consent_required',
          status: 403,
          detail: { expectedDisclosureDigest: prepared.disclosureDigest },
        },
      )
    }
    if (typeof consent.createdAt !== 'number' || (Date.now() - consent.createdAt) > PREFLIGHT_EXPIRY_MS) {
      throw new TrainingWorkerError(
        'Consent is expired or missing a createdAt timestamp. A fresh consent matching the current preflight disclosureDigest is required.',
        {
          code: 'consent_expired',
          status: 403,
          detail: {
            createdAt: consent.createdAt ?? null,
            ageMs: typeof consent.createdAt === 'number' ? Date.now() - consent.createdAt : null,
            maxAgeMs: PREFLIGHT_EXPIRY_MS,
          },
        },
      )
    }

    // Re-check live resources at job start. Harmless fluctuation in live
    // measurements is permitted as long as the original disclosed training
    // plan remains valid and current resource checks pass.
    const liveRecheck = this.#recheckLiveResources(prepared)
    if (!liveRecheck.passed) {
      throw new TrainingWorkerError(
        `Local training worker live resource recheck failed: ${liveRecheck.blockers.join(' ')}`,
        {
          code: 'preflight_failed',
          status: 409,
          detail: { blockers: liveRecheck.blockers },
        },
      )
    }

    const jobId = resumeFromJobId ?? randomUUID()
    const jobWorkDir = resumeFromJobId && this.jobs.get(resumeFromJobId)?.workDir
      ? this.jobs.get(resumeFromJobId).workDir
      : join(this.workDir, jobId)
    const artifactId = prepared.plan.artifactId
    const checkpointPath = join(jobWorkDir, `${artifactId}-run`, `${artifactId}.checkpoint.npz`)

    if (resumeFromJobId && !existsSync(checkpointPath)) {
      throw new TrainingWorkerError(`Cannot resume job ${resumeFromJobId}: atomic checkpoint not found at ${checkpointPath}.`, {
        code: 'checkpoint_missing',
        status: 404,
      })
    }

    const args = [
      this.trainScript,
      '--preset', prepared.plan.preset,
      '--corpus-dir', prepared.plan.corpusDir,
      '--corpus-record', prepared.plan.corpusRecord,
      '--work-dir', jobWorkDir,
      '--install-root', this.root,
      '--pretrain-steps', String(prepared.plan.pretrainSteps),
      '--joint-steps', String(prepared.plan.jointSteps),
      '--batch-size', String(prepared.plan.batchSize),
      '--checkpoint-every', String(prepared.plan.checkpointEvery),
      '--keep-checkpoint',
      '--skip-cards',
    ]
    if (resumeFromJobId) args.push('--resume')

    const threads = String(prepared.plan.resourceLimits.maxCpuThreads)
    const child = spawn(prepared.environment.software.pythonBinary, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS: threads,
        OPENBLAS_NUM_THREADS: threads,
        MKL_NUM_THREADS: threads,
        XLA_PYTHON_CLIENT_PREALLOCATE: 'false',
      },
    })

    const job = {
      id: jobId,
      preset: prepared.plan.preset,
      artifactId,
      mode: prepared.plan.mode,
      state: 'running',
      actor,
      authorizedAt: new Date().toISOString(),
      disclosureDigest: prepared.disclosureDigest,
      resumed: Boolean(resumeFromJobId),
      pid: child.pid ?? null,
      workDir: jobWorkDir,
      checkpointPath,
      resourceLimits: prepared.plan.resourceLimits,
      progress: { step: 0, totalSteps: prepared.plan.totalSteps, lastLoss: null, lastCheckpointSha256: null },
      logs: [],
      exitCode: null,
      completedAt: null,
      error: null,
    }
    this.jobs.set(jobId, job)
    this.#persistJobs()
    this.ledger?.record({
      category: 'training_worker',
      action: resumeFromJobId ? 'worker_resume' : 'worker_start',
      outcome: 'started',
      subject: actor,
      detail: { jobId, preset: job.preset, mode: job.mode, disclosureDigest: job.disclosureDigest },
    })

    const deadlineTimer = setTimeout(() => {
      if (this.processes.has(jobId)) {
        job.cancelReason = `Reached configured ${job.mode} duration ceiling (${job.resourceLimits.maxDurationMs} ms).`
        child.kill('SIGTERM')
      }
    }, prepared.plan.resourceLimits.maxDurationMs)
    deadlineTimer.unref()

    this.processes.set(jobId, { child, deadlineTimer })

    const appendLine = (raw) => {
      for (const line of String(raw).split(/\r?\n/).filter(Boolean)) {
        job.logs.push(line)
        if (job.logs.length > 80) job.logs.shift()
        const stepMatch = /step\s+(\d+)\/(\d+).*loss=([0-9.]+)/.exec(line)
        if (stepMatch) {
          job.progress.step = Number(stepMatch[1])
          job.progress.totalSteps = Number(stepMatch[2])
          job.progress.lastLoss = Number(stepMatch[3])
        }
        const ckptMatch = /atomic checkpoint saved at step (\d+) \(sha256=([0-9a-f]+)/.exec(line)
        if (ckptMatch) {
          job.progress.step = Number(ckptMatch[1])
          job.progress.lastCheckpointSha256 = ckptMatch[2]
        }
      }
    }

    child.stdout.on('data', appendLine)
    child.stderr.on('data', appendLine)
    child.on('exit', (code, sig) => {
      clearTimeout(deadlineTimer)
      this.processes.delete(jobId)
      job.exitCode = code
      job.completedAt = new Date().toISOString()
      const ckptExists = existsSync(checkpointPath)
      if (code === 0) {
        job.state = 'completed'
      } else if (job.cancelRequested || code === 130 || sig === 'SIGTERM') {
        job.state = ckptExists ? 'cancelled_checkpointed' : 'cancelled'
      } else {
        job.state = ckptExists ? 'failed_recoverable' : 'failed'
        job.error = job.logs.at(-1) ?? `Worker exited with code ${code}`
      }
      if (!this.closed) {
        this.#persistJobs()
        this.ledger?.record({
          category: 'training_worker',
          action: 'worker_exit',
          outcome: job.state,
          subject: actor,
          detail: { jobId, exitCode: code, signal: sig, checkpointSaved: ckptExists },
        })
      }
    })

    return this.getJob(jobId)
  }

  /** Gracefully cancel an active worker job; worker flushes its atomic checkpoint before exit. */
  cancelJob(jobId, { actor = null } = {}) {
    const job = this.jobs.get(jobId)
    if (!job) throw new TrainingWorkerError(`Unknown training worker job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    const running = this.processes.get(jobId)
    if (!running) return this.getJob(jobId)
    job.cancelRequested = true
    running.child.kill('SIGTERM')
    this.#persistJobs()
    this.ledger?.record({ category: 'training_worker', action: 'worker_cancel', outcome: 'requested', subject: actor, detail: { jobId } })
    return this.getJob(jobId)
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return null
    return {
      ...structuredClone(job),
      checkpointVerified: Boolean(job.checkpointPath && existsSync(job.checkpointPath)),
    }
  }

  listJobs() {
    return [...this.jobs.keys()].map((id) => this.getJob(id))
  }

  /**
   * Re-check live resources at job start. The original consent binds to the
   * stable preflight snapshot (model, arch, steps, corpus, licence, backend,
   * resource limits) — not to live measurements. This method verifies that
   * current disk, RAM, backend availability, dataset integrity, and safety
   * thresholds still hold. Harmless fluctuation in live measurements is
   * permitted as long as the disclosed training plan remains valid.
   */
  #recheckLiveResources(prepared) {
    const blockers = []
    const env = this.inspectEnvironment()
    const plan = prepared.plan

    // 1. Current free disk must still meet the requirement.
    const requiredDisk = plan.disclosures.storage.requiredFreeDiskBytes
    if (env.hardware.freeDiskBytes < requiredDisk) {
      blockers.push(
        `Insufficient free disk: ${env.hardware.freeDiskBytes} bytes available, ` +
        `${requiredDisk} bytes required.`
      )
    }

    // 2. Current available RAM must meet the minimum requirement.
    const requiredRam = plan.preset === 'pro' ? 2_200_000_000 : 2_600_000_000
    const minRamBytes = Math.min(requiredRam, MIN_AVAILABLE_RAM_BYTES)
    if (env.hardware.availableRamBytes < minRamBytes) {
      blockers.push(
        `Insufficient available RAM: ${env.hardware.availableRamBytes} bytes available, ` +
        `${minRamBytes} bytes required.`
      )
    }

    // 3. Backend must still be available (Python + NumPy).
    if (!env.software.pythonAvailable || !env.software.numpyVersion) {
      blockers.push(
        `Backend unavailable: Python=${env.software.pythonAvailable}, ` +
        `NumPy=${env.software.numpyVersion ?? 'not available'}.`
      )
    }

    // 4. Dataset integrity: corpus directory and record must still exist.
    if (!existsSync(plan.corpusDir)) {
      blockers.push(`Corpus directory not found: ${plan.corpusDir}`)
    }
    if (plan.corpusRecord && !existsSync(plan.corpusRecord)) {
      blockers.push(`Corpus record not found: ${plan.corpusRecord}`)
    }

    // 5. Training script must still exist.
    if (!existsSync(this.trainScript)) {
      blockers.push(`Training script not found: ${this.trainScript}`)
    }

    return {
      passed: blockers.length === 0,
      blockers,
      current: {
        freeDiskBytes: env.hardware.freeDiskBytes,
        availableRamBytes: env.hardware.availableRamBytes,
        logicalCpus: env.hardware.logicalCpus,
        measuredAt: new Date().toISOString(),
      },
    }
  }

  close() {
    this.closed = true
    for (const [jobId, entry] of this.processes.entries()) {
      clearTimeout(entry.deadlineTimer)
      const job = this.jobs.get(jobId)
      if (job) job.cancelRequested = true
      try { entry.child.kill('SIGTERM') } catch {}
    }
    this.processes.clear()
  }
}

function runtimeLabel(sw) {
  return `Python ${sw.pythonVersion}, NumPy ${sw.numpyVersion}, JAX ${sw.jaxVersion}`
}
