import { canonicalProvenanceSha256 } from './provenance.mjs'
import { evaluateAdaptiveTraining } from '../adaptive/training-orchestrator.mjs'

const SHA256 = /^[a-f0-9]{64}$/i
const TRAINING_METHODS = new Set(['sft', 'lora', 'qlora', 'full_fine_tune'])
const INTERACTIVE_LIMIT_MS = 120_000
const TRAINING_REPORT_SCHEMA = 'klyvaron.training-run.v1'
const EVALUATION_REPORT_SCHEMA = 'klyvaron.held-out-evaluation.v1'

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hasOnlyKeys(value, keys) { return isRecord(value) && Object.keys(value).every((key) => keys.includes(key)) }
function validModelId(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,127}$/i.test(value) }
function validSha(value) { return typeof value === 'string' && SHA256.test(value) }
function digest(value) {
  try { return canonicalProvenanceSha256(value) } catch { return null }
}
function isJsonValue(value, depth = 0) {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1))
  return isRecord(value) && Object.entries(value).every(([key, child]) =>
    !/(?:api.?key|secret|password|credential|private.?key|prompt|completion|chat|example|raw.?data)/i.test(key)
    && isJsonValue(child, depth + 1))
}
function validConfiguration(value) {
  return isRecord(value)
    && Object.keys(value).length <= 128
    && isJsonValue(value)
    && Buffer.byteLength(JSON.stringify(value), 'utf8') <= 128 * 1024
    && Number.isSafeInteger(value.seed) && value.seed >= 0
    && typeof value.optimizer === 'string' && /^[a-z][a-z0-9_-]{1,31}$/i.test(value.optimizer)
    && Number.isFinite(value.learningRate) && value.learningRate > 0
    && Number.isSafeInteger(value.batchSize) && value.batchSize > 0
    && Number.isSafeInteger(value.epochs) && value.epochs > 0
    && Number.isSafeInteger(value.maxSteps) && value.maxSteps > 0
    && Number.isSafeInteger(value.sequenceLength) && value.sequenceLength > 0
}

function validExecution(value, method) {
  if (!hasOnlyKeys(value, ['environment', 'workerId', 'consent', 'privateChatAutoIngested', 'durationMs', 'budget'])) return false
  if (value.environment !== 'paired_user_computer'
    || typeof value.workerId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value.workerId)
    || value.privateChatAutoIngested !== false
    || !Number.isSafeInteger(value.durationMs) || value.durationMs <= 0) return false
  const consent = value.consent
  if (!hasOnlyKeys(consent, ['confirmed', 'disclosureDigest'])
    || consent.confirmed !== true || !validSha(consent.disclosureDigest)) return false
  const budget = value.budget
  if (!hasOnlyKeys(budget, ['kind', 'approved', 'maxDurationMs']) || budget.approved !== true
    || !Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs < value.durationMs) return false
  if (budget.kind === 'interactive_adapter') {
    return ['lora', 'qlora'].includes(method)
      && budget.maxDurationMs <= INTERACTIVE_LIMIT_MS
      && value.durationMs <= INTERACTIVE_LIMIT_MS
  }
  return budget.kind === 'separately_budgeted'
}

const TRAINING_BODY_KEYS = [
  'schema', 'modelId', 'runId', 'method', 'adaptiveMode', 'foundationModelId', 'foundationRevisionSha256', 'datasetManifestSha256',
  'configuration', 'configurationSha256', 'codeRevisionSha256', 'adaptivePlanSha256',
  'execution', 'artifactSha256', 'artifactBytes',
]

function trainingBody(report) {
  return Object.fromEntries(TRAINING_BODY_KEYS.map((key) => [key, report[key]]))
}

function validTrainingBody(report, { modelId } = {}) {
  if (!hasOnlyKeys(report, [...TRAINING_BODY_KEYS, 'status', 'passed', 'blockers', 'reportSha256'])
    || report.schema !== TRAINING_REPORT_SCHEMA || !validModelId(report.modelId)
    || (modelId !== undefined && report.modelId !== modelId)
    || typeof report.runId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(report.runId)
    || !TRAINING_METHODS.has(report.method)
    || !['lightweight_adapter', 'full_fine_tune'].includes(report.adaptiveMode)
    || (['lora', 'qlora'].includes(report.method) !== (report.adaptiveMode === 'lightweight_adapter'))
    || typeof report.foundationModelId !== 'string' || !report.foundationModelId.trim() || report.foundationModelId.length > 256
    || !validSha(report.foundationRevisionSha256) || !validSha(report.datasetManifestSha256)
    || !validConfiguration(report.configuration)
    || report.configurationSha256 !== digest(report.configuration)
    || !validSha(report.codeRevisionSha256) || !validSha(report.adaptivePlanSha256)
    || !validExecution(report.execution, report.method)
    || !validSha(report.artifactSha256)
    || !Number.isSafeInteger(report.artifactBytes) || report.artifactBytes <= 0
    || report.status !== 'passed' || report.passed !== true
    || !Array.isArray(report.blockers) || report.blockers.length !== 0
    || !validSha(report.reportSha256)) return false
  return digest(trainingBody(report)) === report.reportSha256
}

/** Prepare a reproducibility record from a completed, consented user-computer training run. */
export function prepareKlyvaronTrainingRunReport(input = {}) {
  const body = {
    schema: TRAINING_REPORT_SCHEMA,
    modelId: input.modelId,
    runId: input.runId,
    method: input.method,
    adaptiveMode: input.adaptiveMode,
    foundationModelId: input.foundationModelId,
    foundationRevisionSha256: input.foundationRevisionSha256,
    datasetManifestSha256: input.datasetManifestSha256,
    configuration: input.configuration,
    configurationSha256: digest(input.configuration),
    codeRevisionSha256: input.codeRevisionSha256,
    adaptivePlanSha256: input.adaptivePlanSha256,
    execution: input.execution,
    artifactSha256: input.artifactSha256,
    artifactBytes: input.artifactBytes,
  }
  const reportBody = trainingBody(body)
  const report = {
    ...reportBody,
    status: 'passed',
    passed: true,
    blockers: [],
    reportSha256: digest(reportBody),
  }
  const complete = validModelId(body.modelId) && validTrainingBody(report)
  if (!complete) return { status: 'blocked', passed: false, blockers: ['training run evidence is incomplete or violates consent, provenance, reproducibility or resource-bound requirements'], report: null, attestationPayload: null }
  return {
    status: 'passed',
    passed: true,
    blockers: [],
    report,
    attestationPayload: {
      schema: 'klyvaron.evidence-attestation.v1',
      purpose: 'training_run',
      modelId: report.modelId,
      evidenceSha256: report.reportSha256,
    },
  }
}

export function isValidKlyvaronTrainingRunReport(report, options = {}) {
  return validTrainingBody(report, options)
}

const EVALUATION_BODY_KEYS = [
  'schema', 'modelId', 'mode', 'trainingRunReportSha256', 'artifactSha256', 'heldOutManifestSha256',
  'outOfDomainManifestSha256', 'heldOutSeparated', 'outOfDomainEvaluated',
  'contaminationReviewStatus', 'metrics', 'adaptiveChecks', 'adaptiveEvaluation',
]

function evaluationBody(report) {
  return Object.fromEntries(EVALUATION_BODY_KEYS.map((key) => [key, report[key]]))
}

function validEvaluationChecks(value) {
  return hasOnlyKeys(value, ['artifactValid', 'evaluationPassed', 'nativeInferencePassed', 'rolledBack', 'measuredWallMs'])
    && typeof value.artifactValid === 'boolean'
    && typeof value.evaluationPassed === 'boolean'
    && typeof value.nativeInferencePassed === 'boolean'
    && typeof value.rolledBack === 'boolean'
    && (value.measuredWallMs === null || (Number.isFinite(value.measuredWallMs) && value.measuredWallMs >= 0))
}

function validMetrics(value) {
  return isRecord(value) && Object.keys(value).length > 0 && Object.keys(value).length <= 128
    && Object.entries(value).every(([name, metric]) => /^[a-z][a-z0-9._-]{0,63}$/i.test(name) && Number.isFinite(metric))
}

function deriveAdaptiveEvaluation(checks, mode) {
  return evaluateAdaptiveTraining({
    mode,
    artifactValid: checks.artifactValid,
    evaluationPassed: checks.evaluationPassed,
    nativeInferencePassed: checks.nativeInferencePassed,
    rolledBack: checks.rolledBack,
    measuredWallMs: checks.measuredWallMs,
  })
}

function validEvaluationBody(report, { modelId, trainingRunReportSha256, artifactSha256, mode } = {}) {
  if (!hasOnlyKeys(report, [...EVALUATION_BODY_KEYS, 'status', 'passed', 'blockers', 'reportSha256', 'attestation'])
    || report.schema !== EVALUATION_REPORT_SCHEMA || !validModelId(report.modelId)
    || (modelId !== undefined && report.modelId !== modelId)
    || !['lightweight_adapter', 'full_fine_tune'].includes(report.mode)
    || (mode !== undefined && report.mode !== mode)
    || !validSha(report.trainingRunReportSha256)
    || (trainingRunReportSha256 !== undefined && report.trainingRunReportSha256 !== trainingRunReportSha256)
    || !validSha(report.artifactSha256) || (artifactSha256 !== undefined && report.artifactSha256 !== artifactSha256)
    || !validSha(report.heldOutManifestSha256) || !validSha(report.outOfDomainManifestSha256)
    || report.heldOutManifestSha256 === report.outOfDomainManifestSha256
    || report.heldOutSeparated !== true || report.outOfDomainEvaluated !== true
    || report.contaminationReviewStatus !== 'passed'
    || !validMetrics(report.metrics) || !validEvaluationChecks(report.adaptiveChecks)
    || report.status !== 'passed' || report.passed !== true
    || !Array.isArray(report.blockers) || report.blockers.length !== 0
    || !validSha(report.reportSha256)) return false
  let expectedAdaptive
  try { expectedAdaptive = deriveAdaptiveEvaluation(report.adaptiveChecks, report.mode) } catch { return false }
  if (!expectedAdaptive.passed || canonicalProvenanceSha256(expectedAdaptive) !== canonicalProvenanceSha256(report.adaptiveEvaluation)) return false
  return digest(evaluationBody(report)) === report.reportSha256
}

/** Prepare an evaluation record; Adaptive alone determines whether its independent checks pass. */
export function prepareKlyvaronEvaluationReport(input = {}) {
  const adaptiveChecks = input.adaptiveChecks
  let adaptiveEvaluation = null
  if (validEvaluationChecks(adaptiveChecks)) adaptiveEvaluation = deriveAdaptiveEvaluation(adaptiveChecks, input.mode)
  const body = {
    schema: EVALUATION_REPORT_SCHEMA,
    modelId: input.modelId,
    mode: input.mode,
    trainingRunReportSha256: input.trainingRunReportSha256,
    artifactSha256: input.artifactSha256,
    heldOutManifestSha256: input.heldOutManifestSha256,
    outOfDomainManifestSha256: input.outOfDomainManifestSha256,
    heldOutSeparated: input.heldOutSeparated,
    outOfDomainEvaluated: input.outOfDomainEvaluated,
    contaminationReviewStatus: input.contaminationReviewStatus,
    metrics: input.metrics,
    adaptiveChecks,
    adaptiveEvaluation,
  }
  const reportBody = evaluationBody(body)
  const report = {
    ...reportBody,
    status: 'passed',
    passed: true,
    blockers: [],
    reportSha256: digest(reportBody),
  }
  const complete = validModelId(body.modelId) && validEvaluationBody(report)
  if (!complete) return { status: 'blocked', passed: false, blockers: ['held-out evaluation evidence is incomplete or Adaptive rejected its checks'], report: null, attestationPayload: null }
  return {
    status: 'passed',
    passed: true,
    blockers: [],
    report,
    attestationPayload: {
      schema: 'klyvaron.evidence-attestation.v1',
      purpose: 'held_out_evaluation',
      modelId: report.modelId,
      evidenceSha256: report.reportSha256,
    },
  }
}

export function isValidKlyvaronEvaluationReport(report, options = {}) {
  return validEvaluationBody(report, options)
}
