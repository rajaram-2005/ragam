import { canonicalProvenanceSha256 } from './provenance.mjs'
import { isValidKlyvaronPlatformMeasurementReport } from './platform-measurement-evidence.mjs'

const SHA256 = /^[a-f0-9]{64}$/i
const REQUIRED_PLATFORMS = Object.freeze(['linux', 'macos', 'windows'])
const MEASUREMENT_KINDS = Object.freeze(['cold_start', 'inference', 'rollback'])
const TIER_PROFILES = Object.freeze({
  lite: Object.freeze({ modelId: 'klyvaron-lite-assistant', hardwareClass: 'mobile' }),
  pro: Object.freeze({ modelId: 'klyvaron-pro-assistant', hardwareClass: 'laptop' }),
  max: Object.freeze({ modelId: 'klyvaron-max-assistant', hardwareClass: 'workstation' }),
})
const REPORT_SCHEMA = 'klyvaron.tier-release-qualification.v2'
const BODY_KEYS = ['schema', 'modelId', 'tier', 'artifactSha256', 'artifactBytes', 'minimumRamBytes', 'targets']

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validSha(value) { return typeof value === 'string' && SHA256.test(value) }
function digest(value) {
  try { return canonicalProvenanceSha256(value) } catch { return null }
}
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0 }

function validTarget(target, { modelId, tier, artifactSha256, artifactBytes, minimumRamBytes, supportedRuntimes }) {
  const keys = [
    'platform', 'architecture', 'hardwareClass', 'hardwareReportSha256', 'hardwareReport', 'ramBytes', 'runtimeId',
    'runtimeVersion', 'measuredAt', 'artifactSha256', 'artifactBytes', 'artifactIntegrityReportSha256', 'environmentId', 'measurements',
  ]
  const profile = TIER_PROFILES[tier]
  if (!isRecord(target)
    || Object.keys(target).some((key) => !keys.includes(key))
    || !REQUIRED_PLATFORMS.includes(target.platform)
    || !['x64', 'arm64'].includes(target.architecture)
    || target.hardwareClass !== profile.hardwareClass
    || !validSha(target.hardwareReportSha256)
    || !validHardwareReport(target)
    || !positiveInteger(target.ramBytes) || target.ramBytes < minimumRamBytes
    || typeof target.runtimeId !== 'string' || !supportedRuntimes.includes(target.runtimeId)
    || typeof target.runtimeVersion !== 'string' || !/^[a-z0-9][a-z0-9.+_-]{0,63}$/i.test(target.runtimeVersion)
    || !validSha(target.artifactSha256) || target.artifactSha256 !== artifactSha256
    || target.artifactBytes !== artifactBytes
    || !validSha(target.artifactIntegrityReportSha256)
    || typeof target.environmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(target.environmentId)
    || !isRecord(target.measurements)
    || Object.keys(target.measurements).length !== MEASUREMENT_KINDS.length
    || Object.keys(target.measurements).some((key) => !MEASUREMENT_KINDS.includes(key))) return false
  for (const kind of MEASUREMENT_KINDS) {
    if (!isValidKlyvaronPlatformMeasurementReport(target.measurements[kind], {
      kind,
      modelId,
      tier,
      artifactSha256,
      artifactBytes,
      platform: target.platform,
      architecture: target.architecture,
      hardwareClass: target.hardwareClass,
      hardwareReportSha256: target.hardwareReportSha256,
      ramBytes: target.ramBytes,
      runtimeId: target.runtimeId,
      runtimeVersion: target.runtimeVersion,
      environmentId: target.environmentId,
      measuredAt: target.measuredAt,
    })) return false
  }
  return true
}

function validHardwareReport(target) {
  const report = target.hardwareReport
  const keys = ['schema', 'platform', 'architecture', 'hardwareClass', 'cpuModel', 'logicalCores', 'ramBytes', 'freeRamBytes']
  return isRecord(report)
    && Object.keys(report).length === keys.length
    && Object.keys(report).every((key) => keys.includes(key))
    && report.schema === 'klyvaron.measured-hardware.v1'
    && report.platform === target.platform
    && report.architecture === target.architecture
    && report.hardwareClass === target.hardwareClass
    && typeof report.cpuModel === 'string' && report.cpuModel.trim().length > 0 && report.cpuModel.length <= 256
    && positiveInteger(report.logicalCores)
    && report.ramBytes === target.ramBytes
    && Number.isSafeInteger(report.freeRamBytes) && report.freeRamBytes >= 0 && report.freeRamBytes <= report.ramBytes
    && digest(report) === target.hardwareReportSha256
}

function bodyOf(report) { return Object.fromEntries(BODY_KEYS.map((key) => [key, report[key]])) }

function validReport(report, { modelId, tier, artifactSha256, artifactBytes, minimumRamBytes, supportedRuntimes } = {}) {
  if (!isRecord(report)
    || Object.keys(report).some((key) => ![...BODY_KEYS, 'status', 'passed', 'blockers', 'reportSha256', 'attestation'].includes(key))
    || report.schema !== REPORT_SCHEMA
    || !Object.hasOwn(TIER_PROFILES, report.tier)
    || report.modelId !== TIER_PROFILES[report.tier].modelId
    || (modelId !== undefined && report.modelId !== modelId)
    || (tier !== undefined && report.tier !== tier)
    || !validSha(report.artifactSha256)
    || (artifactSha256 !== undefined && report.artifactSha256 !== artifactSha256)
    || !positiveInteger(report.artifactBytes)
    || (artifactBytes !== undefined && report.artifactBytes !== artifactBytes)
    || !positiveInteger(report.minimumRamBytes)
    || (minimumRamBytes !== undefined && report.minimumRamBytes !== minimumRamBytes)
    || !Array.isArray(supportedRuntimes) || supportedRuntimes.length === 0
    || !Array.isArray(report.targets) || report.targets.length !== REQUIRED_PLATFORMS.length
    || !Array.isArray(report.blockers) || report.blockers.length !== 0
    || report.status !== 'passed' || report.passed !== true || !validSha(report.reportSha256)) return false
  const platforms = report.targets.map((target) => target?.platform)
  if (new Set(platforms).size !== REQUIRED_PLATFORMS.length
    || [...platforms].sort().join('|') !== [...REQUIRED_PLATFORMS].sort().join('|')) return false
  if (!report.targets.every((target) => validTarget(target, {
    modelId: report.modelId,
    tier: report.tier,
    artifactSha256: report.artifactSha256,
    artifactBytes: report.artifactBytes,
    minimumRamBytes: report.minimumRamBytes,
    supportedRuntimes,
  }))) return false
  return digest(bodyOf(report)) === report.reportSha256
}

/** Prepare a signed-ready qualification report for one exact assistant artifact and tier. */
export function prepareKlyvaronTierQualificationReport({
  modelId,
  tier,
  artifactSha256,
  artifactBytes,
  minimumRamBytes,
  supportedRuntimes,
  targets,
} = {}) {
  const reportBody = {
    schema: REPORT_SCHEMA,
    modelId,
    tier,
    artifactSha256,
    artifactBytes,
    minimumRamBytes,
    targets: Array.isArray(targets) ? [...targets].sort((a, b) => String(a?.platform).localeCompare(String(b?.platform))) : targets,
  }
  const report = {
    ...reportBody,
    status: 'passed',
    passed: true,
    blockers: [],
    reportSha256: digest(reportBody),
  }
  if (!validReport(report, { modelId, tier, artifactSha256, artifactBytes, minimumRamBytes, supportedRuntimes })) {
    return { status: 'blocked', passed: false, blockers: ['tier qualification requires canonical, target-bound cold-start, inference and rollback measurement reports for Windows, Linux and macOS'], report: null, attestationPayload: null }
  }
  return {
    status: 'passed',
    passed: true,
    blockers: [],
    report,
    attestationPayload: {
      schema: 'klyvaron.evidence-attestation.v1',
      purpose: 'tier_release_qualification',
      modelId,
      evidenceSha256: report.reportSha256,
    },
  }
}

export function isValidKlyvaronTierQualificationReport(report, options = {}) {
  return validReport(report, options)
}

/** Match one live deployment to an independently-qualified target row. */
export function isQualifiedKlyvaronDeployment(report, deployment = {}, options = {}) {
  if (!validReport(report, options)
    || deployment.qualificationReportSha256 !== report.reportSha256
    || deployment.modelId !== report.modelId
    || deployment.artifactSha256 !== report.artifactSha256) return false
  return report.targets.some((target) => target.platform === deployment.platform
    && target.architecture === deployment.architecture
    && target.runtimeId === deployment.runtimeId
    && target.runtimeVersion === deployment.runtimeVersion
    && target.hardwareClass === deployment.hardwareClass
    && target.hardwareReportSha256 === deployment.hardwareReportSha256
    && Number.isSafeInteger(deployment.ramBytes) && deployment.ramBytes >= report.minimumRamBytes
    && deployment.runtimeVerified === true
    && deployment.hardwareCompatible === true)
}
