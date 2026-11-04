import { canonicalProvenanceSha256 } from './provenance.mjs'

const SHA256 = /^[a-f0-9]{64}$/i
const KINDS = Object.freeze(['cold_start', 'inference', 'rollback'])
const TIERS = Object.freeze({
  lite: 'klyvaron-lite-assistant',
  pro: 'klyvaron-pro-assistant',
  max: 'klyvaron-max-assistant',
})
const COMMON_KEYS = [
  'schema', 'kind', 'modelId', 'tier', 'artifactSha256', 'artifactBytes', 'platform', 'architecture',
  'hardwareClass', 'hardwareReportSha256', 'ramBytes', 'runtimeId', 'runtimeVersion', 'environmentId',
  'runId', 'measuredAt', 'measurement',
]
const SCHEMA = 'klyvaron.platform-measurement.v1'

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validSha(value) { return typeof value === 'string' && SHA256.test(value) }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0 }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
}
function digest(value) {
  try { return canonicalProvenanceSha256(value) } catch { return null }
}
function bodyOf(report) { return Object.fromEntries(COMMON_KEYS.map((key) => [key, report[key]])) }

function validMeasurement(kind, measurement, artifactSha256) {
  if (!isRecord(measurement)) return false
  if (kind === 'cold_start') {
    return Object.keys(measurement).every((key) => ['coldStartMs', 'peakResidentBytes', 'traceSha256'].includes(key))
      && positiveInteger(measurement.coldStartMs)
      && positiveInteger(measurement.peakResidentBytes)
      && validSha(measurement.traceSha256)
  }
  if (kind === 'inference') {
    return Object.keys(measurement).every((key) => [
      'suiteSha256', 'caseCount', 'passedCases', 'failedCases', 'totalTokens', 'durationMs', 'transcriptSha256',
    ].includes(key))
      && validSha(measurement.suiteSha256)
      && positiveInteger(measurement.caseCount)
      && measurement.passedCases === measurement.caseCount
      && measurement.failedCases === 0
      && positiveInteger(measurement.totalTokens)
      && positiveInteger(measurement.durationMs)
      && validSha(measurement.transcriptSha256)
  }
  if (kind === 'rollback') {
    return Object.keys(measurement).every((key) => [
      'fromArtifactSha256', 'toArtifactSha256', 'rollbackDurationMs', 'rollbackCompleted',
      'restoredArtifactSha256', 'restoreVerificationSha256',
    ].includes(key))
      && measurement.fromArtifactSha256 === artifactSha256
      && validSha(measurement.toArtifactSha256)
      && measurement.toArtifactSha256 !== artifactSha256
      && positiveInteger(measurement.rollbackDurationMs)
      && measurement.rollbackCompleted === true
      && measurement.restoredArtifactSha256 === measurement.toArtifactSha256
      && validSha(measurement.restoreVerificationSha256)
  }
  return false
}

function validReport(report, expected = {}) {
  if (!isRecord(report)
    || Object.keys(report).some((key) => ![...COMMON_KEYS, 'status', 'passed', 'reportSha256'].includes(key))
    || report.schema !== SCHEMA
    || !KINDS.includes(report.kind)
    || !Object.hasOwn(TIERS, report.tier)
    || report.modelId !== TIERS[report.tier]
    || !validSha(report.artifactSha256)
    || !positiveInteger(report.artifactBytes)
    || !['linux', 'macos', 'windows'].includes(report.platform)
    || !['x64', 'arm64'].includes(report.architecture)
    || !['mobile', 'laptop', 'workstation'].includes(report.hardwareClass)
    || !validSha(report.hardwareReportSha256)
    || !positiveInteger(report.ramBytes)
    || typeof report.runtimeId !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(report.runtimeId)
    || typeof report.runtimeVersion !== 'string' || !/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(report.runtimeVersion)
    || typeof report.environmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(report.environmentId)
    || typeof report.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(report.runId)
    || !validDate(report.measuredAt)
    || !validMeasurement(report.kind, report.measurement, report.artifactSha256)
    || report.status !== 'passed' || report.passed !== true || !validSha(report.reportSha256)) return false
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && report[key] !== value) return false
  }
  return digest(bodyOf(report)) === report.reportSha256
}

/** Canonicalize one platform measurement record; this does not execute or attest a measurement. */
export function prepareKlyvaronPlatformMeasurementReport(input = {}) {
  const body = { schema: SCHEMA, ...Object.fromEntries(COMMON_KEYS.slice(1).map((key) => [key, input[key]])) }
  const report = { ...body, status: 'passed', passed: true, reportSha256: digest(body) }
  if (!validReport(report)) return { status: 'blocked', passed: false, report: null }
  return { status: 'passed', passed: true, report }
}

export function isValidKlyvaronPlatformMeasurementReport(report, expected = {}) {
  return validReport(report, expected)
}
