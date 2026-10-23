// Phase 2 — User-Computer Runtime Qualification & Backend Validation Registry.
//
// Strictly separates:
//   1. Hardware detection (`detectHardwareProfile`): what CPU, RAM, GPU, VRAM, disk, and software
//      exist on the host or paired user worker. Detection NEVER marks any backend `qualified`.
//   2. Runtime qualification (`RuntimeQualificationRegistry`): loads real model weights on a specific
//      backend (`cpu`, `cuda`, `rocm`, `mps`), runs real inference, validates output integrity,
//      measures initialization time, latency, and RSS memory, and records an invalidatable record
//      keyed by `(hardwareFingerprint, backend, runtimeVersion, modelId, modelVersion, artifactSha256)`.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const WORKER_EXEC_PY = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'worker_exec.py')

export const IMPLEMENTED_BACKENDS = Object.freeze(['cpu', 'cuda', 'rocm', 'mps'])

export function computeHardwareFingerprint(capabilities) {
  if (!capabilities) return 'unpaired-unknown-hardware'
  const canonical = {
    platform: capabilities.platform ?? process.platform,
    arch: capabilities.arch ?? process.arch,
    cpuModel: capabilities.cpu?.model ?? 'unknown-cpu',
    logicalCores: Number(capabilities.cpu?.logicalCores ?? 1),
    gpus: (capabilities.gpu?.devices ?? []).map((g) => ({
      kind: g.kind,
      name: g.name,
      driverVersion: g.driverVersion ?? null,
      vramTotalBytes: Number(g.vramTotalBytes ?? 0),
    })),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

export function computeQualificationKey({
  hardwareFingerprint,
  backend,
  runtimeVersion,
  modelId,
  modelVersion,
  artifactSha256,
}) {
  return [
    hardwareFingerprint,
    backend,
    runtimeVersion,
    modelId,
    modelVersion,
    artifactSha256,
  ].join('::')
}

export function detectHardwareProfile(capabilities) {
  if (!capabilities) {
    return {
      detected: false,
      hardwareFingerprint: null,
      platform: null,
      arch: null,
      ramBytes: null,
      availableRamBytes: null,
      freeDiskBytes: null,
      gpuDevices: [],
      detectedBackends: [],
      qualificationImpliedByDetection: false,
    }
  }
  const gpuDevices = capabilities.gpu?.devices ?? []
  const detectedBackends = ['cpu']
  if (gpuDevices.some((d) => d.kind === 'cuda')) detectedBackends.push('cuda')
  if (gpuDevices.some((d) => d.kind === 'rocm')) detectedBackends.push('rocm')
  if (gpuDevices.some((d) => d.kind === 'metal' || d.kind === 'mps')) detectedBackends.push('mps')

  return {
    detected: true,
    hardwareFingerprint: computeHardwareFingerprint(capabilities),
    platform: capabilities.platform,
    arch: capabilities.arch,
    cpu: capabilities.cpu,
    ramBytes: capabilities.memory?.totalRamBytes ?? 0,
    availableRamBytes: capabilities.memory?.availableRamBytes ?? 0,
    freeDiskBytes: capabilities.storage?.freeDiskBytes ?? 0,
    gpuDevices,
    software: capabilities.software ?? {},
    detectedBackends,
    qualificationImpliedByDetection: false,
  }
}

export class RuntimeQualificationRegistry {
  constructor({ statePath, pythonBinary = 'python3', workerExecScript = WORKER_EXEC_PY } = {}) {
    this.statePath = resolve(statePath)
    this.pythonBinary = pythonBinary
    this.workerExecScript = workerExecScript
    this.records = new Map() // recordId -> qualification entry
    mkdirSync(resolve(this.statePath, '..'), { recursive: true })
    this.#load()
  }

  #load() {
    if (!existsSync(this.statePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      for (const rec of parsed.records ?? []) {
        if (rec?.key) this.records.set(rec.key, rec)
      }
    } catch {
      this.records.clear()
    }
  }

  #save() {
    mkdirSync(resolve(this.statePath, '..'), { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ schema: 'klyvaron.qualification.registry/1', records: [...this.records.values()] }, null, 2) + '\n',
      'utf8',
    )
    renameSync(tmp, this.statePath)
  }

  /**
   * Look up a valid qualification record for the EXACT current hardware, backend, runtime version,
   * model version, and artifact SHA-256 digest. If an older record exists with a different digest,
   * version, runtime, or hardware fingerprint, it is NOT returned and its invalidation reason is reported.
   */
  getValidQualification({
    capabilities,
    backend = 'cpu',
    runtimeVersion = null,
    modelId,
    modelVersion,
    artifactSha256,
  }) {
    const hwFp = computeHardwareFingerprint(capabilities)
    const matchingPrefix = [...this.records.values()].filter(
      (r) => r.modelId === modelId && r.backend === backend && r.qualified === true,
    )
    const valid = matchingPrefix.find(
      (r) => r.hardwareFingerprint === hwFp
        && r.modelVersion === modelVersion
        && r.artifactSha256 === artifactSha256
        && (runtimeVersion === null || r.runtimeVersion === runtimeVersion),
    )
    if (valid) {
      return { valid: true, status: 'qualified', record: structuredClone(valid), invalidatedReason: null }
    }
    if (matchingPrefix.length > 0) {
      const prev = matchingPrefix[matchingPrefix.length - 1]
      const diffs = []
      if (prev.artifactSha256 !== artifactSha256) diffs.push('artifact_digest_changed')
      if (prev.modelVersion !== modelVersion) diffs.push('model_version_changed')
      if (prev.hardwareFingerprint !== hwFp) diffs.push('hardware_changed')
      if (runtimeVersion !== null && prev.runtimeVersion !== runtimeVersion) diffs.push('runtime_version_changed')
      return {
        valid: false,
        status: 'invalidated_re_qualification_required',
        record: null,
        invalidatedReason: diffs.join(', ') || 'component_changed',
      }
    }
    return { valid: false, status: 'unqualified', record: null, invalidatedReason: null }
  }

  /** Explicitly record a qualification run (pass OR failure) with measured telemetry. */
  recordQualification(entry) {
    const key = computeQualificationKey(entry)
    const stored = {
      ...structuredClone(entry),
      key,
      qualifiedAt: entry.qualifiedAt ?? new Date().toISOString(),
    }
    this.records.set(key, stored)
    this.#save()
    return structuredClone(stored)
  }

  /** Execute real artifact loading + real inference + output verification on `backend`. */
  qualifyModelOnHost({ capabilities, modelDir, backend = 'cpu' }) {
    if (!IMPLEMENTED_BACKENDS.includes(backend)) {
      throw new Error(`Unsupported backend '${backend}'. Expected one of: ${IMPLEMENTED_BACKENDS.join(', ')}`)
    }
    const hwFp = computeHardwareFingerprint(capabilities)
    const specPath = join(tmpdir(), `klyvaron-qualify-${process.pid}-${Date.now()}.json`)
    writeFileSync(specPath, JSON.stringify({ modelDir: resolve(modelDir), backend }), 'utf8')
    const proc = spawnSync(this.pythonBinary, [this.workerExecScript, 'qualify', specPath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, XLA_PYTHON_CLIENT_PREALLOCATE: 'false' },
    })
    try {
      const fs = process.getBuiltinModule('node:fs')
      fs.rmSync(specPath, { force: true })
    } catch {}

    const lines = (proc.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    const parsed = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null
    if (proc.status !== 0 || !parsed?.ok) {
      const failureReason = parsed?.message || proc.stderr || `Backend '${backend}' failed qualification`
      const unsupportedHw = /not supported\/available on this machine|no compatible accelerator/i.test(failureReason)
      const failureRecord = {
        hardwareFingerprint: hwFp,
        backend,
        runtimeVersion: capabilities?.software?.numpyVersion ? `numpy/${capabilities.software.numpyVersion}` : 'unknown',
        modelId: resolve(modelDir).split('/').pop(),
        modelVersion: '0.1.0',
        artifactSha256: 'unverified',
        qualified: false,
        readinessCode: unsupportedHw ? 'unsupported_hardware' : 'runtime_unqualified',
        failureReason,
      }
      return this.recordQualification(failureRecord)
    }

    return this.recordQualification({
      hardwareFingerprint: hwFp,
      backend: parsed.backend,
      runtimeVersion: parsed.runtimeVersion,
      modelId: parsed.modelId,
      modelVersion: parsed.modelVersion,
      modality: parsed.modality,
      artifactSha256: parsed.artifactSha256,
      weightsSha256: parsed.weightsSha256,
      qualified: true,
      readinessCode: 'ready',
      initMs: parsed.initMs,
      latencyMs: parsed.latencyMs,
      rssBeforeMb: parsed.rssBeforeMb,
      rssAfterMb: parsed.rssAfterMb,
      outputSha256: parsed.outputSha256,
      summary: parsed.summary,
    })
  }

  invalidateModel(modelId) {
    let removed = 0
    for (const [key, val] of this.records.entries()) {
      if (val.modelId === modelId) {
        this.records.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.#save()
    return { modelId, removed }
  }

  list() {
    return [...this.records.values()].map((r) => structuredClone(r))
  }
}
