import { createHash, randomUUID } from 'node:crypto'
import { cpus, freemem, platform, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { verifyPinnedLocalFiles } from './local-provenance.mjs'
import { prepareKlyvaronPlatformMeasurementReport } from './platform-measurement-evidence.mjs'
import { canonicalProvenanceSha256 } from './provenance.mjs'

const SHA256 = /^[a-f0-9]{64}$/i
const TIER_PROFILES = Object.freeze({
  lite: Object.freeze({ modelId: 'klyvaron-lite-assistant', hardwareClass: 'mobile' }),
  pro: Object.freeze({ modelId: 'klyvaron-pro-assistant', hardwareClass: 'laptop' }),
  max: Object.freeze({ modelId: 'klyvaron-max-assistant', hardwareClass: 'workstation' }),
})
const PLATFORM_NAMES = Object.freeze({ linux: 'linux', darwin: 'macos', win32: 'windows' })
const ARCHITECTURES = Object.freeze({ x64: 'x64', arm64: 'arm64' })

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validSha(value) { return typeof value === 'string' && SHA256.test(value) }
function blocked(reason) { return { status: 'blocked', passed: false, blockers: [reason], target: null } }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function safeRunId() { return randomUUID() }

async function timed(run) {
  const start = performance.now()
  const value = await run()
  return { value, durationMs: Math.max(1, Math.ceil(performance.now() - start)) }
}

/**
 * Capture one host's target-bound measurements using explicit runtime/deployment adapters.
 * No platform can be impersonated: OS, architecture, RAM and CPU identity come from this host.
 * Adapters must perform the real model/runtime work; this coordinator does not simulate it.
 */
export async function captureKlyvaronPlatformQualification({
  modelRecord,
  artifactRoot,
  pinnedArtifactFiles,
  runtimeAdapter,
  deploymentAdapter,
  now = () => new Date(),
} = {}) {
  if (!isRecord(modelRecord) || !Object.hasOwn(TIER_PROFILES, modelRecord.tier)
    || modelRecord.id !== TIER_PROFILES[modelRecord.tier].modelId) return blocked('a canonical Lite, Pro or Max assistant release record is required')
  const profile = TIER_PROFILES[modelRecord.tier]
  const artifact = modelRecord.artifact
  const minimumRamBytes = modelRecord.minimumHardware?.ramBytes
  if (!isRecord(artifact) || !validSha(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0
    || !Number.isSafeInteger(minimumRamBytes) || minimumRamBytes <= 0
    || !Array.isArray(modelRecord.supportedRuntimes) || modelRecord.supportedRuntimes.length === 0) {
    return blocked('the release record must pin artifact bytes, minimum RAM and supported runtimes')
  }

  const currentPlatform = PLATFORM_NAMES[platform()]
  const currentArchitecture = ARCHITECTURES[process.arch]
  const memoryBytes = totalmem()
  if (!currentPlatform || !currentArchitecture) return blocked('this operating system or architecture is outside the qualification target set')
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < minimumRamBytes) return blocked('measured host RAM is below the tier minimum')

  if (!isRecord(runtimeAdapter)
    || !modelRecord.supportedRuntimes.includes(runtimeAdapter.id)
    || typeof runtimeAdapter.version !== 'string' || !/^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(runtimeAdapter.version)
    || typeof runtimeAdapter.coldStart !== 'function'
    || typeof runtimeAdapter.runInferenceSuite !== 'function'
    || !validSha(runtimeAdapter.inferenceSuiteSha256)) return blocked('a supported, version-pinned runtime adapter with cold-start and inference execution is required')
  if (!isRecord(deploymentAdapter)
    || typeof deploymentAdapter.readActiveArtifactSha256 !== 'function'
    || typeof deploymentAdapter.activateArtifact !== 'function'
    || typeof deploymentAdapter.restoreArtifact !== 'function') return blocked('a deployment adapter with active-artifact readback, activation and restoration is required')

  const integrity = await verifyPinnedLocalFiles({ root: artifactRoot, files: pinnedArtifactFiles })
  if (!integrity.passed || integrity.artifactSha256 !== artifact.sha256 || integrity.totalBytes !== artifact.bytes) {
    return blocked('local artifact bytes do not match the exact release-record digest and size')
  }

  const cpuList = cpus()
  const hardwareReport = {
    schema: 'klyvaron.measured-hardware.v1',
    platform: currentPlatform,
    architecture: currentArchitecture,
    hardwareClass: profile.hardwareClass,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    logicalCores: cpuList.length,
    ramBytes: memoryBytes,
    freeRamBytes: freemem(),
  }
  const hardwareReportSha256 = canonicalProvenanceSha256(hardwareReport)
  const environmentId = `host-${hardwareReportSha256.slice(0, 24)}`
  const common = {
    modelId: modelRecord.id,
    tier: modelRecord.tier,
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    artifactIntegrityReportSha256: integrity.reportSha256,
    platform: currentPlatform,
    architecture: currentArchitecture,
    hardwareClass: profile.hardwareClass,
    hardwareReportSha256,
    ramBytes: memoryBytes,
    runtimeId: runtimeAdapter.id,
    runtimeVersion: runtimeAdapter.version,
    environmentId,
  }

  try {
    const cold = await timed(() => runtimeAdapter.coldStart({
      artifactRoot, artifact, modelId: modelRecord.id, tier: modelRecord.tier,
    }))
    if (!isRecord(cold.value) || !Number.isSafeInteger(cold.value.peakResidentBytes) || cold.value.peakResidentBytes <= 0
      || !validSha(cold.value.traceSha256)) return blocked('runtime cold-start did not return measured resident memory and a trace digest')

    const inference = await timed(() => runtimeAdapter.runInferenceSuite({
      session: cold.value.session,
      artifactRoot,
      artifact,
      modelId: modelRecord.id,
      tier: modelRecord.tier,
      suiteSha256: runtimeAdapter.inferenceSuiteSha256,
    }))
    if (!isRecord(inference.value)) return blocked('runtime inference suite returned no measured result')

    const previousArtifactSha256 = await deploymentAdapter.readActiveArtifactSha256()
    if (!validSha(previousArtifactSha256) || previousArtifactSha256 === artifact.sha256) {
      return blocked('rollback qualification requires a distinct, currently active known-good artifact')
    }
    let activationAttempted = false
    let restored = false
    let rollbackDurationMs = 0
    let restoreVerificationSha256 = null
    try {
      activationAttempted = true
      await deploymentAdapter.activateArtifact({ artifactRoot, artifact, modelId: modelRecord.id, tier: modelRecord.tier })
      if (await deploymentAdapter.readActiveArtifactSha256() !== artifact.sha256) {
        throw new Error('candidate deployment readback mismatch')
      }
      const rollback = await timed(() => deploymentAdapter.restoreArtifact(previousArtifactSha256))
      rollbackDurationMs = rollback.durationMs
      const activeAfterRollback = await deploymentAdapter.readActiveArtifactSha256()
      restored = activeAfterRollback === previousArtifactSha256
      if (!restored) throw new Error('rollback artifact readback mismatch')
      restoreVerificationSha256 = hash({
        expectedArtifactSha256: previousArtifactSha256,
        activeArtifactSha256: activeAfterRollback,
        environmentId,
      })
    } catch (error) {
      if (activationAttempted && !restored) {
        try {
          await deploymentAdapter.restoreArtifact(previousArtifactSha256)
          restored = await deploymentAdapter.readActiveArtifactSha256() === previousArtifactSha256
        } catch {}
      }
      return blocked(restored ? 'candidate deployment or rollback verification failed' : 'candidate deployment failed and known-good restoration could not be verified')
    }

    const measuredAt = now().toISOString()
    const make = (kind, measurement) => {
      const prepared = prepareKlyvaronPlatformMeasurementReport({
        ...common,
        runId: `${safeRunId()}:${kind}`,
        measuredAt,
        kind,
        measurement,
      })
      return prepared.passed ? prepared.report : null
    }
    const measurements = {
      cold_start: make('cold_start', {
        coldStartMs: cold.durationMs,
        peakResidentBytes: cold.value.peakResidentBytes,
        traceSha256: cold.value.traceSha256,
      }),
      inference: make('inference', {
        suiteSha256: runtimeAdapter.inferenceSuiteSha256,
        caseCount: inference.value.caseCount,
        passedCases: inference.value.passedCases,
        failedCases: inference.value.failedCases,
        totalTokens: inference.value.totalTokens,
        durationMs: inference.durationMs,
        transcriptSha256: inference.value.transcriptSha256,
      }),
      rollback: make('rollback', {
        fromArtifactSha256: artifact.sha256,
        toArtifactSha256: previousArtifactSha256,
        rollbackDurationMs,
        rollbackCompleted: restored,
        restoredArtifactSha256: restored ? previousArtifactSha256 : null,
        restoreVerificationSha256,
      }),
    }
    if (Object.values(measurements).some((report) => report === null)) {
      return blocked('one or more runtime/deployment measurements failed the canonical evidence schema')
    }
    return {
      status: 'passed',
      passed: true,
      blockers: [],
      target: {
        ...common,
        hardwareReport,
        measuredAt,
        measurements,
      },
      artifactIntegrityReportSha256: integrity.reportSha256,
      attestationRequired: true,
    }
  } catch {
    return blocked('runtime or deployment capture failed; no qualification payload was emitted')
  }
}
