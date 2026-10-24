// Packaged, cross-platform (`linux`, `darwin`, `win32`) authenticated Klyvaron Local Worker.
//
// Runs on the user's own computer, pairs explicitly with RAGAM via a single-use cryptographic
// handshake, confines every file operation strictly inside explicitly authorized directories,
// exposes ONLY eight typed schema-validated operations, and NEVER provides shell execution.

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { cpus } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectHardware, memorySnapshot } from '../hardware/detect.mjs'
import { ADAPTER_FORMAT, ArtifactError, loadAdapterArtifact, loadArtifact } from './format.mjs'
import { KlyvaronRuntime } from './runtime.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const WORKER_EXEC_PY = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'worker_exec.py')
const TRAIN_KLYVARON_PY = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'train_klyvaron.py')

export const SUPPORTED_WORKER_OS = Object.freeze(['linux', 'darwin', 'win32'])
export const INTERACTIVE_ADAPTER_WALL_LIMIT_MS = 120_000

export const ALLOWED_WORKER_OPERATIONS = Object.freeze([
  'capability.detect',
  'model.inspect',
  'runtime.qualify',
  'training.create',
  'training.progress',
  'training.cancel',
  'checkpoint.manage',
  'artifact.validate',
  'model.infer',
])

const ALLOWED_OP_SET = new Set(ALLOWED_WORKER_OPERATIONS)

export class LocalWorkerRpcError extends Error {
  constructor(message, { code = 'worker_rpc_error', status = 400, detail = {} } = {}) {
    super(message)
    this.name = 'LocalWorkerRpcError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

function safeTokenEquals(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string' || !expected || !provided) return false
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(provided, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function probeCrossPlatformGpu() {
  const accelerators = []
  const platform = process.platform

  // NVIDIA CUDA (`linux` and `win32`)
  const nvidiaBin = platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  const nv = spawnSync(
    nvidiaBin,
    ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 3000 },
  )
  if (nv.status === 0 && nv.stdout?.trim()) {
    for (const line of nv.stdout.trim().split(/\r?\n/)) {
      const [name, totalMb, freeMb, driver] = line.split(',').map((s) => s.trim())
      if (name) {
        accelerators.push({
          kind: 'cuda',
          vendor: 'nvidia',
          name,
          vramTotalBytes: Math.round(Number(totalMb || 0) * 1024 * 1024),
          vramAvailableBytes: Math.round(Number(freeMb || 0) * 1024 * 1024),
          driverVersion: driver || null,
        })
      }
    }
  }

  // AMD ROCm (`linux`)
  if (platform === 'linux' && accelerators.length === 0) {
    const rocm = spawnSync('rocminfo', [], { encoding: 'utf8', timeout: 3000 })
    if (rocm.status === 0 && /Marketing Name:\s+(.+)/i.test(rocm.stdout || '')) {
      const match = /Marketing Name:\s+(.+)/i.exec(rocm.stdout)
      accelerators.push({
        kind: 'rocm',
        vendor: 'amd',
        name: match[1].trim(),
        vramTotalBytes: 0,
        vramAvailableBytes: 0,
      })
    }
  }

  // Apple Silicon / Metal (`darwin`)
  if (platform === 'darwin') {
    const sp = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], { encoding: 'utf8', timeout: 4000 })
    if (sp.status === 0 && sp.stdout?.trim()) {
      try {
        const parsed = JSON.parse(sp.stdout)
        for (const gpu of parsed.SPDisplaysDataType ?? []) {
          accelerators.push({
            kind: 'metal',
            vendor: 'apple',
            name: gpu.sppci_model || 'Apple Metal GPU',
            // Unified memory architecture on Apple Silicon shares system memory pool.
            vramTotalBytes: process.arch === 'arm64' ? memorySnapshot().totalRamBytes : 0,
            vramAvailableBytes: process.arch === 'arm64' ? memorySnapshot().availableRamBytes : 0,
          })
        }
      } catch {
        // Ignore malformed output.
      }
    }
  }

  return accelerators
}

function probePythonBackend() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['/tmp/accel-venv/bin/python', '/tmp/fabric-venv/bin/python', 'python3', 'python']

  for (const bin of candidates) {
    if (isAbsolute(bin) && !existsSync(bin)) continue
    const probe = spawnSync(
      bin,
      [
        '-c',
        'import json, platform, numpy\n'
        + 'jax_ver = None; jax_devs = []\n'
        + 'try:\n'
        + '  import jax\n'
        + '  jax_ver = jax.__version__\n'
        + '  jax_devs = [d.platform for d in jax.devices()]\n'
        + 'except Exception:\n'
        + '  pass\n'
        + 'print(json.dumps({"python": platform.python_version(), "numpy": numpy.__version__, "jax": jax_ver, "jaxDevices": jax_devs}))',
      ],
      { encoding: 'utf8', timeout: 8000, env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' } },
    )
    if (probe.status === 0 && probe.stdout?.trim()) {
      try {
        return { binary: bin, ...JSON.parse(probe.stdout.trim()) }
      } catch {
        // Try next interpreter candidate.
      }
    }
  }
  return null
}

function readCpuSimdFlags() {
  try {
    if (process.platform === 'linux' && existsSync('/proc/cpuinfo')) {
      const line = readFileSync('/proc/cpuinfo', 'utf8').split('\n').find((l) => l.startsWith('flags'))
      const flags = new Set(line?.split(':')[1]?.trim().split(/\s+/) ?? [])
      return ['avx512f', 'avx512_vnni', 'avx2', 'fma', 'neon'].filter((f) => flags.has(f))
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') return ['neon']
  } catch {
    // Non-fatal.
  }
  return []
}

function freeDiskBytes(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const st = statfsSync(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return 0
  }
}

export class KlyvaronLocalWorkerServer {
  constructor({
    workspaceDir,
    modelsDir,
    extraAllowedDirs = [],
    pairingSecret,
    workerLabel = 'Local Computer Worker',
    host = '127.0.0.1',
    port = 0,
    hardwareOverride = null,
    workerExecScript = WORKER_EXEC_PY,
    trainKlyvaronScript = TRAIN_KLYVARON_PY,
  }) {
    if (!pairingSecret || typeof pairingSecret !== 'string' || pairingSecret.length < 16) {
      throw new LocalWorkerRpcError('Local worker requires a high-entropy pairingSecret (>= 16 chars).', {
        code: 'invalid_pairing_secret',
      })
    }
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      throw new LocalWorkerRpcError(
        `Local worker refuses non-loopback bind host '${host}' unless behind an explicit authenticated tunnel.`,
        { code: 'unsafe_worker_bind' },
      )
    }
    this.workerId = `klyvaron-worker-${randomUUID()}`
    this.workerLabel = workerLabel
    this.host = host
    this.requestedPort = port
    this.workspaceDir = resolve(workspaceDir)
    this.modelsDir = resolve(modelsDir)
    mkdirSync(this.workspaceDir, { recursive: true })
    mkdirSync(this.modelsDir, { recursive: true })
    this.allowedRoots = [
      realpathSync(this.workspaceDir),
      realpathSync(this.modelsDir),
      ...extraAllowedDirs.map((d) => {
        const abs = resolve(d)
        mkdirSync(abs, { recursive: true })
        return realpathSync(abs)
      }),
    ]
    this.pairingSecret = pairingSecret
    this.pairingConsumed = false
    this.sessionToken = null
    this.pairedAt = null
    this.pairedBy = null
    this.hardwareOverride = hardwareOverride
    this.workerExecScript = workerExecScript
    this.trainKlyvaronScript = trainKlyvaronScript

    this.jobs = new Map()
    this.activeProcess = null
    this.loadedModels = new Map() // modelId -> { runtime, modelDir, activeAdapterDir, baselineAdapterDir }
    this.server = null
  }

  /** Confine any path strictly within `this.allowedRoots` (blocks `..`, NUL bytes, symlink escape). */
  resolveAuthorizedPath(targetPath) {
    if (typeof targetPath !== 'string' || !targetPath || targetPath.includes('\0')) {
      throw new LocalWorkerRpcError('Invalid or empty path supplied to local worker.', {
        code: 'invalid_worker_path',
        status: 400,
      })
    }
    const candidate = resolve(this.workspaceDir, targetPath)
    // Walk up until an existing ancestor is found so `realpathSync` catches symlink escapes even for new outputs.
    let probe = candidate
    const tail = []
    while (!existsSync(probe)) {
      const parent = dirname(probe)
      if (parent === probe) break
      tail.unshift(probe.slice(parent.length + 1))
      probe = parent
    }
    const realBase = existsSync(probe) ? realpathSync(probe) : probe
    const canonical = tail.length ? resolve(realBase, ...tail) : realBase

    const permitted = this.allowedRoots.some((root) => {
      const rel = relative(root, canonical)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
    if (!permitted) {
      throw new LocalWorkerRpcError(
        `Path '${targetPath}' lies outside the local worker's authorized workspace roots.`,
        { code: 'path_outside_authorized_root', status: 403 },
      )
    }
    return canonical
  }

  detectCapabilities() {
    if (this.hardwareOverride) {
      return structuredClone(this.hardwareOverride)
    }
    const hw = detectHardware()
    const mem = memorySnapshot()
    const cpuList = cpus()
    const gpus = probeCrossPlatformGpu()
    const py = probePythonBackend()
    const totalVram = gpus.reduce((sum, g) => sum + (g.vramTotalBytes || 0), 0)
    const availVram = gpus.reduce((sum, g) => sum + (g.vramAvailableBytes || 0), 0)
    const backends = ['klyvaron-js-cpu']
    if (py?.numpy) backends.push('python-numpy-cpu')
    if (py?.jax) backends.push(`python-jax-${(py.jaxDevices ?? ['cpu']).join('+')}`)
    if (gpus.some((g) => g.kind === 'cuda')) backends.push('cuda')
    if (gpus.some((g) => g.kind === 'metal')) backends.push('metal')
    if (gpus.some((g) => g.kind === 'rocm')) backends.push('rocm')

    return {
      workerId: this.workerId,
      workerLabel: this.workerLabel,
      detectedAt: new Date().toISOString(),
      osSupported: SUPPORTED_WORKER_OS.includes(process.platform),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpu: {
        model: cpuList[0]?.model ?? hw.cpuModel ?? 'CPU',
        logicalCores: cpuList.length,
        simdFlags: readCpuSimdFlags(),
      },
      memory: {
        totalRamBytes: mem.totalRamBytes,
        availableRamBytes: mem.availableRamBytes,
      },
      gpu: {
        available: gpus.length > 0,
        totalVramBytes: totalVram,
        availableVramBytes: availVram,
        devices: gpus,
      },
      storage: {
        workspaceDir: this.workspaceDir,
        modelsDir: this.modelsDir,
        freeDiskBytes: freeDiskBytes(this.workspaceDir),
      },
      software: {
        pythonAvailable: Boolean(py),
        pythonBinary: py?.binary ?? null,
        pythonVersion: py?.python ?? null,
        numpyVersion: py?.numpy ?? null,
        jaxVersion: py?.jax ?? null,
        workerExecAvailable: existsSync(this.workerExecScript),
        foundationTrainerAvailable: existsSync(this.trainKlyvaronScript),
        supportedBackends: backends,
      },
      security: {
        shellExecutionEnabled: false,
        filesystemScope: 'jailed_to_authorized_roots',
        allowedOperations: [...ALLOWED_WORKER_OPERATIONS],
      },
    }
  }

  inspectModels({ modelId = null, adapterDir = null } = {}) {
    const inspected = []
    const entries = existsSync(this.modelsDir) ? readdirSync(this.modelsDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (modelId && entry.name !== modelId) continue
      const dir = this.resolveAuthorizedPath(join(this.modelsDir, entry.name))
      const mmManifestPath = join(dir, 'manifest.json')
      if (existsSync(mmManifestPath)) {
        try {
          const mm = JSON.parse(readFileSync(mmManifestPath, 'utf8'))
          if (mm.schema === 'klyvaron.multimodal/1') {
            const weightsPath = join(dir, mm.weights.file)
            const procPath = join(dir, mm.processor.file)
            const actualSha = createHash('sha256').update(readFileSync(weightsPath)).digest('hex')
            const actualProcSha = createHash('sha256').update(readFileSync(procPath)).digest('hex')
            if (actualSha !== mm.weights.sha256 || actualProcSha !== mm.processor.sha256) {
              throw new Error('Multimodal package SHA-256 verification failed.')
            }
            inspected.push({
              id: mm.id,
              version: mm.version,
              tier: mm.tier,
              modality: mm.modality,
              format: mm.schema,
              directory: dir,
              verified: true,
              weightsSha256: mm.weights.weightsSha256,
              fileSha256: actualSha,
              weightsBytes: mm.weights.bytes,
              parameterCount: mm.parameterCount,
              architecture: mm.architecture,
              processorSha256: actualProcSha,
              supportedTasks: mm.supportedTasks ?? [],
            })
            continue
          }
        } catch (mmErr) {
          inspected.push({
            id: entry.name,
            directory: dir,
            verified: false,
            error: { code: 'invalid_multimodal_artifact', message: mmErr.message },
          })
          continue
        }
      }
      try {
        const artifact = loadArtifact(dir)
        let adapterSummary = null
        const checkedAdapterDir = adapterDir ? this.resolveAuthorizedPath(adapterDir) : null
        if (checkedAdapterDir) {
          const verifiedAdapter = loadAdapterArtifact(checkedAdapterDir, { expectedBaseManifest: artifact.manifest })
          adapterSummary = {
            id: verifiedAdapter.manifest.id,
            version: verifiedAdapter.manifest.version,
            sha256: verifiedAdapter.sha256,
            rank: verifiedAdapter.rank,
            alpha: verifiedAdapter.alpha,
            parameterCount: verifiedAdapter.manifest.lora.parameterCount,
          }
        }
        inspected.push({
          id: artifact.manifest.id,
          version: artifact.manifest.version,
          tier: artifact.manifest.tier,
          format: artifact.manifest.format,
          instructionTuned: Boolean(artifact.manifest.instructionTuned),
          directory: dir,
          verified: true,
          weightsSha256: artifact.sha256,
          weightsBytes: artifact.manifest.weights.bytes,
          architecture: artifact.manifest.architecture,
          tokenizerKind: artifact.manifest.tokenizer.kind,
          tokenizerDigest: artifact.manifest.tokenizer.digest,
          activeAdapter: this.loadedModels.get(artifact.manifest.id)?.activeAdapter ?? adapterSummary,
        })
      } catch (error) {
        inspected.push({
          id: entry.name,
          directory: dir,
          verified: false,
          error: { code: error.code ?? 'invalid_artifact', message: error.message },
        })
      }
    }
    return { modelsDir: this.modelsDir, models: inspected }
  }

  qualifyBackend({ modelId, modelDir = null, backend = 'cpu' } = {}) {
    const caps = this.detectCapabilities()
    if (!caps.software.pythonAvailable || !caps.software.pythonBinary) {
      throw new LocalWorkerRpcError('Python 3.11+ with NumPy is missing on this local worker.', {
        code: 'python_backend_missing',
        status: 409,
      })
    }
    const safeModelDir = modelDir
      ? this.resolveAuthorizedPath(modelDir)
      : this.resolveAuthorizedPath(join(this.modelsDir, modelId))
    const specPath = this.resolveAuthorizedPath(join(this.workspaceDir, `qualify-${Date.now()}.json`))
    writeFileSync(specPath, JSON.stringify({ modelDir: safeModelDir, backend }), 'utf8')
    const proc = spawnSync(caps.software.pythonBinary, [this.workerExecScript, 'qualify', specPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' },
    })
    rmSync(specPath, { force: true })
    const lines = (proc.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
    if (proc.status !== 0 || !last?.ok) {
      throw new LocalWorkerRpcError(last?.message || proc.stderr || `Qualification failed on backend '${backend}'.`, {
        code: /not supported\/available/i.test(last?.message || '') ? 'unsupported_hardware' : 'runtime_unqualified',
        status: 409,
      })
    }
    return last
  }

  validateArtifact({ artifactDir, baseModelId = null, baseModelDir = null }) {
    const safeArtifactDir = this.resolveAuthorizedPath(artifactDir)
    if (existsSync(join(safeArtifactDir, 'manifest.json'))) {
      const caps = this.detectCapabilities()
      const resolvedBaseDir = baseModelDir
        ? this.resolveAuthorizedPath(baseModelDir)
        : (baseModelId ? this.resolveAuthorizedPath(join(this.modelsDir, baseModelId)) : null)
      const specPath = this.resolveAuthorizedPath(join(this.workspaceDir, `validate-${Date.now()}.json`))
      writeFileSync(
        specPath,
        JSON.stringify({ artifactDir: safeArtifactDir, ...(resolvedBaseDir ? { baseModelDir: resolvedBaseDir } : {}) }),
        'utf8',
      )
      const proc = spawnSync(caps.software.pythonBinary || 'python3', [this.workerExecScript, 'validate', specPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' },
      })
      rmSync(specPath, { force: true })
      const lines = (proc.stdout || '').trim().split(/\r?\n/).filter(Boolean)
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      if (proc.status !== 0 || !last?.ok) {
        throw new LocalWorkerRpcError(last?.message || proc.stderr || 'Multimodal artifact validation failed.', {
          code: 'artifact_invalid',
          status: 400,
        })
      }
      return last
    }
    const manifests = existsSync(safeArtifactDir)
      ? readdirSync(safeArtifactDir).filter((f) => f.endsWith('.klyvaron.json'))
      : []
    if (manifests.length !== 1) {
      throw new LocalWorkerRpcError(`Artifact directory '${safeArtifactDir}' must contain one *.klyvaron.json file.`, {
        code: 'artifact_invalid',
        status: 400,
      })
    }
    const raw = JSON.parse(readFileSync(join(safeArtifactDir, manifests[0]), 'utf8'))
    if (raw.format === ADAPTER_FORMAT) {
      const resolvedBaseDir = baseModelDir
        ? this.resolveAuthorizedPath(baseModelDir)
        : this.resolveAuthorizedPath(join(this.modelsDir, baseModelId ?? raw.baseModel?.id ?? ''))
      const baseRt = KlyvaronRuntime.load(resolvedBaseDir)
      const verifiedAdapter = loadAdapterArtifact(safeArtifactDir, { expectedBaseManifest: baseRt.manifest })
      baseRt.attachAdapter(safeArtifactDir)
      const probeIds = Int32Array.from([1, 2, 3, 4])
      const logits = baseRt.logits(probeIds)
      const finite = logits.every((v) => Number.isFinite(v))
      if (!finite) {
        throw new LocalWorkerRpcError('Validated adapter produced non-finite logits.', { code: 'non_finite_logits' })
      }
      return {
        valid: true,
        kind: 'lora_adapter',
        id: verifiedAdapter.manifest.id,
        version: verifiedAdapter.manifest.version,
        sha256: verifiedAdapter.sha256,
        bytes: verifiedAdapter.manifest.weights.bytes,
        baseModelId: baseRt.manifest.id,
        baseWeightsSha256: baseRt.sha256,
        parameterCount: verifiedAdapter.manifest.lora.parameterCount,
        metrics: verifiedAdapter.manifest.metrics ?? null,
        finiteProbeLogits: true,
      }
    }

    const rt = KlyvaronRuntime.load(safeArtifactDir)
    const logits = rt.logits(Int32Array.from([1, 2, 3, 4]))
    const finite = logits.every((v) => Number.isFinite(v))
    if (!finite) {
      throw new LocalWorkerRpcError('Validated checkpoint produced non-finite logits.', { code: 'non_finite_logits' })
    }
    return {
      valid: true,
      kind: 'model_checkpoint',
      id: rt.manifest.id,
      version: rt.manifest.version,
      sha256: rt.sha256,
      bytes: rt.manifest.weights.bytes,
      parameterCount: rt.parameterCount,
      finiteProbeLogits: true,
    }
  }

  runInference({
    modelId,
    modelDir = null,
    adapterDir = undefined,
    prompt,
    target = null,
    maxNewTokens = 16,
    persistLoaded = true,
    modality = null,
    task = null,
    ...multimodalParams
  }) {
    const resolvedDir = modelDir
      ? this.resolveAuthorizedPath(modelDir)
      : this.resolveAuthorizedPath(join(this.modelsDir, modelId))

    if (existsSync(join(resolvedDir, 'manifest.json'))) {
      const caps = this.detectCapabilities()
      const specObj = {
        modelDir: resolvedDir,
        modelId,
        ...(typeof adapterDir === 'string' && adapterDir ? { adapterDir: this.resolveAuthorizedPath(adapterDir) } : {}),
        ...(prompt != null ? { prompt } : {}),
        ...(modality ? { modality } : {}),
        ...(task ? { task } : {}),
        ...multimodalParams,
      }
      const specPath = this.resolveAuthorizedPath(join(this.workspaceDir, `infer-mm-${Date.now()}.json`))
      writeFileSync(specPath, JSON.stringify(specObj), 'utf8')
      const proc = spawnSync(caps.software.pythonBinary || 'python3', [this.workerExecScript, 'infer', specPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
        env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' },
      })
      rmSync(specPath, { force: true })
      const lines = (proc.stdout || '').trim().split(/\r?\n/).filter(Boolean)
      const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null
      if (proc.status !== 0 || !last?.ok) {
        throw new LocalWorkerRpcError(last?.message || proc.stderr || 'Multimodal inference failed on local worker.', {
          code: 'worker_inference_failed',
          status: 400,
        })
      }
      return last
    }

    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new LocalWorkerRpcError('model.infer requires a non-empty prompt.', { code: 'invalid_prompt' })
    }

    let state = this.loadedModels.get(modelId)
    if (!state || state.modelDir !== resolvedDir) {
      const runtime = KlyvaronRuntime.load(resolvedDir)
      state = {
        runtime,
        modelDir: resolvedDir,
        activeAdapter: null,
        previousAdapterDir: null,
      }
      if (persistLoaded) this.loadedModels.set(modelId, state)
    }

    if (adapterDir === null && state.runtime.activeAdapter) {
      state.previousAdapterDir = state.activeAdapter?.directory ?? null
      state.runtime.detachAdapter()
      state.activeAdapter = null
    } else if (typeof adapterDir === 'string' && adapterDir) {
      const safeAdapterDir = this.resolveAuthorizedPath(adapterDir)
      if (state.runtime.activeAdapter?.directory !== safeAdapterDir) {
        state.previousAdapterDir = state.activeAdapter?.directory ?? null
        state.activeAdapter = state.runtime.attachAdapter(safeAdapterDir)
      }
    }

    const rssBefore = process.memoryUsage().rss
    const formattedPrompt = state.runtime.instructionTuned
      ? `<|system|>\n${state.runtime.manifest.chatTemplate?.systemPrompt ?? 'Klyvaron first-party language model. Answer directly from available context and state clearly when supporting evidence is absent.'}\n<|context|>\nnone\n<|user|>\n${prompt.trim()}\n<|assistant|>\n`
      : prompt

    const started = performance.now()
    const out = state.runtime.generate({
      prompt: formattedPrompt,
      maxNewTokens,
      minNewTokens: Math.min(2, maxNewTokens),
      temperature: 0,
      stop: state.runtime.manifest.generation?.stop ?? (state.runtime.instructionTuned ? ['<|end|>'] : []),
    })
    const latencyMs = Number((performance.now() - started).toFixed(2))
    const rssAfter = process.memoryUsage().rss
    const tokPerSec = Number(((out.generatedTokens / Math.max(latencyMs, 0.001)) * 1000).toFixed(2))

    let targetLoss = null
    if (typeof target === 'string' && target.length > 0) {
      const suffix = state.runtime.instructionTuned ? `${target.trim()}<|end|>` : target
      const promptIds = Array.from(state.runtime.tokenizer.encode(formattedPrompt))
      const targetIds = Array.from(state.runtime.tokenizer.encode(suffix))
      const combined = [...promptIds, ...targetIds]
      const scored = state.runtime.scoreSequence(combined, { lossStartIndex: promptIds.length })
      targetLoss = {
        meanNll: Number(scored.meanNll.toFixed(6)),
        perplexity: Number(scored.perplexity.toFixed(4)),
        scoredTokens: scored.tokenCount,
      }
    }

    return {
      modelId: state.runtime.manifest.id,
      weightsSha256: state.runtime.sha256,
      activeAdapter: state.runtime.activeAdapter ?? null,
      text: out.text,
      generatedTokens: out.generatedTokens,
      stoppedBy: out.stoppedBy,
      differentiators: out.differentiators ?? null,
      targetLoss,
      latencyMs,
      tokensPerSecond: tokPerSec,
      rssBytesBefore: rssBefore,
      rssBytesAfter: rssAfter,
    }
  }

  createTrainingJob(payload) {
    if (this.activeProcess) {
      throw new LocalWorkerRpcError('Local worker is already running an active training job.', {
        code: 'worker_busy',
        status: 409,
      })
    }
    const caps = this.detectCapabilities()
    if (!caps.software.pythonAvailable || !caps.software.pythonBinary) {
      throw new LocalWorkerRpcError('Python 3.11+ with NumPy is not available on this worker machine.', {
        code: 'python_backend_missing',
        status: 409,
      })
    }

    const mode = payload?.mode
    if (!['lightweight_adapter', 'full_fine_tune', 'foundation_pretrain'].includes(mode)) {
      throw new LocalWorkerRpcError(`Unsupported worker training mode '${mode}'.`, { code: 'invalid_mode' })
    }

    const jobId = payload.jobId ?? randomUUID()
    const jobRoot = this.resolveAuthorizedPath(join(this.workspaceDir, 'jobs', jobId))
    mkdirSync(jobRoot, { recursive: true })
    const checkpointPath = join(jobRoot, 'checkpoints', `${jobId}.ckpt.npz`)
    const outputArtifactDir = join(jobRoot, 'output', payload.artifactId ?? `${payload.modelId}-${mode}`)
    const cancelFlagPath = join(jobRoot, '.cancel')
    const specFile = join(jobRoot, 'job-spec.json')

    let baseModelDir = null
    let baselineWeightsSha256 = null
    let inferredModality = payload.modality ?? null
    const previousAdapterDir = this.loadedModels.get(payload.modelId)?.activeAdapter?.directory ?? null
    if (payload.modelDir || payload.modelId) {
      const candidate = payload.modelDir
        ? this.resolveAuthorizedPath(payload.modelDir)
        : this.resolveAuthorizedPath(join(this.modelsDir, payload.modelId))
      if (existsSync(candidate)) {
        if (existsSync(join(candidate, 'manifest.json'))) {
          const mm = JSON.parse(readFileSync(join(candidate, 'manifest.json'), 'utf8'))
          baseModelDir = candidate
          baselineWeightsSha256 = mm.weights?.weightsSha256 ?? mm.weights?.sha256
          inferredModality = inferredModality ?? mm.modality
        } else {
          const verifiedBase = loadArtifact(candidate)
          baseModelDir = candidate
          baselineWeightsSha256 = verifiedBase.sha256
        }
      } else if (mode !== 'foundation_pretrain') {
        throw new LocalWorkerRpcError(`Base model '${payload.modelId}' does not exist in worker models directory.`, {
          code: 'base_model_missing',
          status: 404,
        })
      }
    }

    const maxDurationMs = mode === 'lightweight_adapter'
      ? Math.min(Number(payload.stoppingCriteria?.maxDurationMs ?? INTERACTIVE_ADAPTER_WALL_LIMIT_MS), INTERACTIVE_ADAPTER_WALL_LIMIT_MS)
      : Number(payload.stoppingCriteria?.maxDurationMs ?? 3_600_000)

    const workerSpec = {
      jobId,
      mode,
      modality: inferredModality,
      modelId: payload.modelId,
      modelDir: baseModelDir,
      baseModelDir,
      artifactId: payload.artifactId ?? `${payload.modelId}-adapter`,
      adapterId: payload.artifactId ?? `${payload.modelId}-adapter`,
      version: payload.version ?? '0.1.0',
      tier: payload.tier ?? 'lite',
      preset: payload.preset ?? payload.tier ?? 'pro',
      architecture: payload.architecture ?? null,
      tokenizer: payload.tokenizer ?? null,
      seed: Number(payload.seed ?? 20261023),
      workDir: jobRoot,
      checkpointPath,
      outputDir: outputArtifactDir,
      outputArtifactDir,
      cancelFlagPath,
      checkpointEvery: Number(payload.checkpointEvery ?? 1),
      stepDelayMs: Number(payload.stepDelayMs ?? 0),
      maxSteps: Number(payload.stoppingCriteria?.maxSteps ?? 8),
      learningRate: Number(payload.trainingLoss?.learningRate ?? 8e-3),
      maxDurationMs,
      intendedBehavior: payload.intendedBehavior,
      inputTargetFormat: payload.inputTargetFormat,
      dataProvenance: payload.dataProvenance,
      trainingLoss: payload.trainingLoss,
      validationMethod: payload.validationMethod,
      stoppingCriteria: { ...payload.stoppingCriteria, maxDurationMs },
      regressionTests: payload.regressionTests,
      examples: payload.trainExamples,
      trainExamples: payload.trainExamples,
      validationExamples: payload.validationExamples ?? [],
      resume: Boolean(payload.resume),
    }
    writeFileSync(specFile, JSON.stringify(workerSpec, null, 2) + '\n', 'utf8')

    const maxThreads = String(Math.max(1, Math.min(caps.cpu.logicalCores, Number(payload.maxCpuThreads ?? caps.cpu.logicalCores))))
    const child = spawn(caps.software.pythonBinary, [this.workerExecScript, 'train', specFile], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OMP_NUM_THREADS: maxThreads,
        OPENBLAS_NUM_THREADS: maxThreads,
        MKL_NUM_THREADS: maxThreads,
        XLA_PYTHON_CLIENT_PREALLOCATE: 'false',
      },
    })

    const jobRecord = {
      jobId,
      workerId: this.workerId,
      modelId: payload.modelId,
      mode,
      state: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      baseline: {
        modelDir: baseModelDir,
        weightsSha256: baselineWeightsSha256,
        previousAdapterDir,
      },
      specFile,
      checkpointPath,
      outputArtifactDir,
      cancelFlagPath,
      maxDurationMs,
      progress: {
        phase: 'starting',
        step: 0,
        totalSteps: Number(workerSpec.stoppingCriteria.maxSteps),
        trainLoss: null,
        valLoss: null,
        gradNorm: null,
        elapsedMs: 0,
        peakRssBytes: 0,
        checkpointSha256: null,
      },
      logs: [],
      result: null,
      error: null,
      rolledBackAt: null,
    }
    this.jobs.set(jobId, jobRecord)

    // Watchdog enforcing hard wall-clock ceiling (including finalization for interactive jobs).
    const timer = setTimeout(() => {
      if (this.activeProcess?.jobId === jobId) {
        jobRecord.timedOut = true
        try { writeFileSync(cancelFlagPath, 'timeout\n', 'utf8') } catch {}
        try { child.kill('SIGTERM') } catch {}
      }
    }, maxDurationMs + 250)
    timer.unref()

    this.activeProcess = { jobId, child, timer }

    const consumeLine = (chunk) => {
      for (const rawLine of String(chunk).split(/\r?\n/).filter(Boolean)) {
        jobRecord.logs.push(rawLine)
        if (jobRecord.logs.length > 100) jobRecord.logs.shift()
        try {
          const parsed = JSON.parse(rawLine)
          if (parsed.type === 'progress') {
            jobRecord.progress = {
              phase: parsed.phase ?? 'training',
              step: parsed.step ?? 0,
              totalSteps: parsed.totalSteps ?? parsed.maxSteps ?? jobRecord.progress.totalSteps,
              trainLoss: parsed.trainLoss ?? parsed.loss ?? null,
              valLoss: parsed.valLoss ?? null,
              gradNorm: parsed.gradNorm ?? jobRecord.progress.gradNorm,
              elapsedMs: parsed.elapsedMs ?? 0,
              peakRssBytes: parsed.peakRssBytes ?? 0,
              checkpointSha256: parsed.checkpointSha256 ?? jobRecord.progress.checkpointSha256,
            }
          } else if (parsed.type === 'result' && parsed.ok) {
            jobRecord.result = parsed
          } else if (parsed.type === 'error') {
            jobRecord.error = { code: parsed.code, message: parsed.message }
          }
        } catch {
          // Plain stderr diagnostic line kept in bounded log ring buffer.
        }
      }
    }

    child.stdout.on('data', consumeLine)
    child.stderr.on('data', consumeLine)
    child.on('exit', (code, signalName) => {
      clearTimeout(timer)
      if (this.activeProcess?.jobId === jobId) this.activeProcess = null
      jobRecord.completedAt = new Date().toISOString()
      const hasCheckpoint = existsSync(checkpointPath)
      if (code === 0 && jobRecord.result) {
        jobRecord.state = 'completed'
        jobRecord.progress.phase = 'completed'
      } else if (jobRecord.cancelRequested || jobRecord.error?.code === 'job_cancelled' || code === 130) {
        // Ensure unfinalized partial output never advertises `.ready`.
        rmSync(join(outputArtifactDir, '.ready'), { force: true })
        jobRecord.state = hasCheckpoint ? 'cancelled_checkpointed' : 'cancelled'
        jobRecord.progress.phase = jobRecord.state
      } else if (jobRecord.timedOut || jobRecord.error?.code === 'exceeded_interactive_120s_limit' || code === 124) {
        rmSync(join(outputArtifactDir, '.ready'), { force: true })
        jobRecord.state = 'failed_time_limit'
        jobRecord.error = jobRecord.error ?? {
          code: 'exceeded_interactive_120s_limit',
          message: `Job exceeded its ${maxDurationMs} ms wall-clock budget (including finalization).`,
        }
      } else {
        rmSync(join(outputArtifactDir, '.ready'), { force: true })
        jobRecord.state = hasCheckpoint ? 'failed_checkpointed' : 'failed'
        jobRecord.error = jobRecord.error ?? {
          code: 'worker_process_failed',
          message: `Worker exited with code ${code} (${signalName ?? 'no signal'}).`,
        }
      }
    })

    return this.getJobProgress(jobId)
  }

  getJobProgress(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new LocalWorkerRpcError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }
    return {
      ...structuredClone(job),
      checkpointExists: existsSync(job.checkpointPath),
    }
  }

  cancelTrainingJob({ jobId }) {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new LocalWorkerRpcError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }
    if (this.activeProcess?.jobId === jobId) {
      job.cancelRequested = true
      try { writeFileSync(job.cancelFlagPath, `${new Date().toISOString()}\n`, 'utf8') } catch {}
      try { this.activeProcess.child.kill('SIGTERM') } catch {}
    }
    return this.getJobProgress(jobId)
  }

  manageCheckpoint({ action, jobId, resumeMaxSteps = null }) {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new LocalWorkerRpcError(`Unknown training job '${jobId}'.`, { code: 'job_not_found', status: 404 })
    }

    if (action === 'inspect') {
      const exists = existsSync(job.checkpointPath)
      const metaPath = `${job.checkpointPath.replace(/\.npz$/, '')}.meta.json`
      const sha256 = exists ? createHash('sha256').update(readFileSync(job.checkpointPath)).digest('hex') : null
      const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
      return {
        jobId,
        checkpointExists: exists,
        checkpointPath: job.checkpointPath,
        sha256,
        meta,
        baseline: job.baseline,
      }
    }

    if (action === 'resume') {
      if (!existsSync(job.checkpointPath)) {
        throw new LocalWorkerRpcError(`No atomic checkpoint exists for job '${jobId}'.`, {
          code: 'checkpoint_missing',
          status: 404,
        })
      }
      const savedSpec = JSON.parse(readFileSync(job.specFile, 'utf8'))
      rmSync(job.cancelFlagPath, { force: true })
      const resumedJobId = `${jobId}-resumed`
      const nextSteps = resumeMaxSteps ?? savedSpec.stoppingCriteria.maxSteps
      const resumedDir = this.resolveAuthorizedPath(join(this.workspaceDir, 'jobs', resumedJobId))
      mkdirSync(join(resumedDir, 'checkpoints'), { recursive: true })
      const nextCkpt = join(resumedDir, 'checkpoints', `${resumedJobId}.ckpt.npz`)
      writeFileSync(nextCkpt, readFileSync(job.checkpointPath))
      return this.createTrainingJob({
        ...savedSpec,
        jobId: resumedJobId,
        stoppingCriteria: { ...savedSpec.stoppingCriteria, maxSteps: nextSteps },
        resume: true,
      })
    }

    if (action === 'rollback') {
      if (this.activeProcess?.jobId === jobId) {
        throw new LocalWorkerRpcError('Cancel the active training job before rolling back weights.', {
          code: 'job_still_running',
          status: 409,
        })
      }
      // Remove `.ready` on the job's produced artifact AND restore exact pre-job model state in worker memory.
      rmSync(join(job.outputArtifactDir, '.ready'), { force: true })
      const loaded = this.loadedModels.get(job.modelId)
      if (loaded) {
        if (job.baseline.previousAdapterDir && existsSync(join(job.baseline.previousAdapterDir, '.ready'))) {
          loaded.activeAdapter = loaded.runtime.attachAdapter(job.baseline.previousAdapterDir)
        } else {
          loaded.runtime.detachAdapter()
          loaded.activeAdapter = null
        }
      }
      // Re-verify baseline weights digest on disk to prove untouched integrity.
      let verifiedBaseSha = null
      if (job.baseline.modelDir) {
        if (existsSync(join(job.baseline.modelDir, 'manifest.json'))) {
          const mm = JSON.parse(readFileSync(join(job.baseline.modelDir, 'manifest.json'), 'utf8'))
          const wPath = join(job.baseline.modelDir, mm.weights.file)
          const actualFileSha = createHash('sha256').update(readFileSync(wPath)).digest('hex')
          if (actualFileSha !== mm.weights.sha256) {
            throw new LocalWorkerRpcError('Multimodal baseline weights.npz corrupted!', {
              code: 'baseline_integrity_violation',
              status: 500,
            })
          }
          verifiedBaseSha = mm.weights.weightsSha256 ?? actualFileSha
        } else {
          const verifiedBase = loadArtifact(job.baseline.modelDir)
          verifiedBaseSha = verifiedBase.sha256
        }
      }
      if (verifiedBaseSha && job.baseline.weightsSha256 && verifiedBaseSha !== job.baseline.weightsSha256) {
        throw new LocalWorkerRpcError('Baseline SHA-256 verification failed during rollback!', {
          code: 'baseline_integrity_violation',
          status: 500,
        })
      }
      job.state = 'rolled_back'
      job.rolledBackAt = new Date().toISOString()
      return {
        rolledBack: true,
        jobId,
        modelId: job.modelId,
        restoredBaseWeightsSha256: verifiedBaseSha,
        activeAdapter: loaded?.runtime.activeAdapter ?? null,
      }
    }

    throw new LocalWorkerRpcError(`Unsupported checkpoint.manage action '${action}'.`, {
      code: 'invalid_checkpoint_action',
      status: 400,
    })
  }

  dispatchOperation(op, params = {}) {
    if (!ALLOWED_OP_SET.has(op)) {
      throw new LocalWorkerRpcError(
        `Operation '${op}' is prohibited on the Klyvaron Local Worker. Shell execution and arbitrary file I/O are never exposed.`,
        { code: 'forbidden_worker_operation', status: 403 },
      )
    }
    switch (op) {
      case 'capability.detect':
        return this.detectCapabilities()
      case 'model.inspect':
        return this.inspectModels(params)
      case 'runtime.qualify':
        return this.qualifyBackend(params)
      case 'training.create':
        return this.createTrainingJob(params)
      case 'training.progress':
        return this.getJobProgress(params.jobId)
      case 'training.cancel':
        return this.cancelTrainingJob(params)
      case 'checkpoint.manage':
        return this.manageCheckpoint(params)
      case 'artifact.validate':
        return this.validateArtifact(params)
      case 'model.infer':
        return this.runInference(params)
      default:
        throw new LocalWorkerRpcError(`Unhandled operation '${op}'.`, { code: 'forbidden_worker_operation', status: 403 })
    }
  }

  async start() {
    if (this.server) return this.address()
    this.server = http.createServer(async (req, res) => {
      const reply = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        const chunks = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > 8 * 1024 * 1024) {
            return reply(413, { ok: false, error: 'payload_too_large', message: 'Worker RPC payload exceeds 8 MiB.' })
          }
          chunks.push(chunk)
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw ? JSON.parse(raw) : {}

        if (req.method === 'POST' && req.url === '/pair') {
          if (this.pairingConsumed) {
            throw new LocalWorkerRpcError('This worker pairing code has already been consumed.', {
              code: 'pairing_code_used',
              status: 403,
            })
          }
          if (!safeTokenEquals(this.pairingSecret, body?.pairingSecret)) {
            throw new LocalWorkerRpcError('Invalid local worker pairing secret.', {
              code: 'worker_unauthorized',
              status: 401,
            })
          }
          this.pairingConsumed = true
          this.sessionToken = randomBytes(32).toString('hex')
          this.pairedAt = new Date().toISOString()
          this.pairedBy = String(body?.controllerId ?? 'ragam-core')
          return reply(200, {
            ok: true,
            workerId: this.workerId,
            workerLabel: this.workerLabel,
            sessionToken: this.sessionToken,
            pairedAt: this.pairedAt,
            capabilities: this.detectCapabilities(),
          })
        }

        if (req.method === 'POST' && req.url === '/rpc') {
          const authHeader = String(req.headers.authorization ?? '')
          const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
          if (!this.sessionToken || !safeTokenEquals(this.sessionToken, bearer)) {
            throw new LocalWorkerRpcError('Authenticated local worker session credential required.', {
              code: 'worker_unauthorized',
              status: 401,
            })
          }
          const result = this.dispatchOperation(String(body?.op ?? ''), body?.params ?? {})
          return reply(200, { ok: true, workerId: this.workerId, op: body.op, result })
        }

        return reply(404, { ok: false, error: 'not_found', message: 'Unknown local worker endpoint.' })
      } catch (error) {
        const status = error instanceof LocalWorkerRpcError
          ? error.status
          : error instanceof ArtifactError
            ? 400
            : 400
        return reply(status, {
          ok: false,
          error: error.code ?? 'worker_error',
          message: error.message,
        })
      }
    })

    await new Promise((resolveListen, rejectListen) => {
      this.server.once('error', rejectListen)
      this.server.listen(this.requestedPort, this.host, () => resolveListen())
    })
    return this.address()
  }

  address() {
    if (!this.server) return null
    const addr = this.server.address()
    return `http://${this.host}:${addr.port}`
  }

  async close() {
    if (this.activeProcess) {
      clearTimeout(this.activeProcess.timer)
      try { this.activeProcess.child.kill('SIGTERM') } catch {}
      this.activeProcess = null
    }
    this.sessionToken = null
    if (!this.server) return
    const srv = this.server
    this.server = null
    await new Promise((r) => srv.close(() => r()))
  }
}

export function createLocalWorkerServer(options = {}) {
  return new KlyvaronLocalWorkerServer(options)
}

