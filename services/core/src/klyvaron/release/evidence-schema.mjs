import { canonicalProvenanceSha256 } from '../provenance.mjs'

export const KLYVARON_PRODUCTION_EVIDENCE_FILES = Object.freeze([
  'model-identity.json',
  'artifact-manifest.json',
  'artifact-checksums.sha256',
  'training-provenance.json',
  'evaluation-report.json',
  'performance-report.json',
  'hardware-compatibility.json',
  'security-report.json',
  'deployment-evidence.json',
  'rollback-test.json',
  'independent-review.json',
  'release-decision.json',
])

export const KLYVARON_PRODUCTION_SIGNATURES = Object.freeze({
  evidence: Object.freeze({ file: 'evidence.attestation.json', purpose: 'klyvaron_release_evidence' }),
  deployment: Object.freeze({ file: 'deployment.attestation.json', purpose: 'klyvaron_deployment_verification' }),
  independentReview: Object.freeze({ file: 'independent-review.attestation.json', purpose: 'klyvaron_independent_review' }),
  releaseDecision: Object.freeze({ file: 'release-decision.attestation.json', purpose: 'klyvaron_release_decision' }),
})

const TIERS = Object.freeze({
  lite: 'klyvaron-lite-assistant',
  pro: 'klyvaron-pro-assistant',
  max: 'klyvaron-max-assistant',
})
const SHA256 = /^[a-f0-9]{64}$/i
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ISO_DATETIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/
const PATH = /^[a-z0-9][a-z0-9._/-]{0,239}$/i
const REQUIRED_DEPLOYMENT_TESTS = Object.freeze([
  'artifact_retrieval', 'artifact_signature_verification', 'artifact_checksum_verification', 'model_revision_match',
  'inference', 'streaming', 'cancellation', 'model_selection_routing',
  'access_control', 'request_isolation', 'failure_handling', 'recovery',
])

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function onlyKeys(value, allowed) { return record(value) && Object.keys(value).every((key) => allowed.includes(key)) }
function sha(value) { return typeof value === 'string' && SHA256.test(value) }
function text(value) { return typeof value === 'string' && value.trim().length > 0 }
function date(value) { return typeof value === 'string' && ISO_DATETIME.test(value) && Number.isFinite(Date.parse(value)) }
function safeArtifactPath(value) {
  return typeof value === 'string' && PATH.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..')
}
function positive(value) { return Number.isSafeInteger(value) && value > 0 }
function numericMetrics(value) {
  if (!record(value) || Object.keys(value).length === 0) return false
  return Object.values(value).every((item) => typeof item === 'number' ? Number.isFinite(item)
    : record(item) ? numericMetrics(item) : false)
}
function failed(blockers, reason) { blockers.push(reason) }

export function klyvaronProductionModelId(tier) { return TIERS[tier] ?? null }
export function isKlyvaronProductionVersion(value) { return typeof value === 'string' && VERSION.test(value) }

function commonIdentityMatches(value, identity, label, blockers) {
  if (!record(value)) { failed(blockers, `${label} must be an object`); return }
  if (value.modelId !== identity.modelId || value.tier !== identity.tier || value.version !== identity.version
    || value.modelRevisionSha256 !== identity.modelRevisionSha256 || value.artifactSha256 !== identity.artifactSha256) {
    failed(blockers, `${label} targets a different model, revision, version or artifact`)
  }
  if (value.evidenceClass !== 'production' || value.synthetic !== false || value.mockedResponses !== false) {
    failed(blockers, `${label} must be explicitly production evidence, not synthetic or mocked`)
  }
}

function validateModelIdentity(value, tier, version, blockers) {
  if (!onlyKeys(value, ['schema', 'tier', 'modelId', 'version', 'modelRevisionSha256', 'configurationSha256', 'artifactSha256', 'artifactManifestSha256'])
    || value.schema !== 'klyvaron.production-model-identity.v1') {
    failed(blockers, 'model-identity.json has an unsupported schema')
    return null
  }
  const expectedModelId = TIERS[tier]
  if (!expectedModelId || value.tier !== tier || value.modelId !== expectedModelId || value.version !== version
    || !isKlyvaronProductionVersion(value.version) || !sha(value.modelRevisionSha256)
    || !sha(value.configurationSha256) || !sha(value.artifactSha256) || !sha(value.artifactManifestSha256)) {
    failed(blockers, 'model identity must bind the canonical tier, exact model revision, configuration and artifact')
    return null
  }
  return value
}

function validateArtifactManifest(value, identity, blockers) {
  if (!onlyKeys(value, ['schema', 'tier', 'modelId', 'version', 'modelRevisionSha256', 'artifactSha256', 'evidenceClass', 'synthetic', 'mockedResponses', 'formats', 'tokenizer', 'files'])
    || value.schema !== 'klyvaron.production-artifact-manifest.v1') {
    failed(blockers, 'artifact-manifest.json has an unsupported schema')
    return []
  }
  commonIdentityMatches(value, identity, 'artifact manifest', blockers)
  if (!Array.isArray(value.formats) || value.formats.length === 0 || value.formats.some((item) => !text(item))) {
    failed(blockers, 'artifact manifest must name supported artifact formats')
  }
  if (!onlyKeys(value.tokenizer, ['name', 'version', 'format']) || !text(value.tokenizer.name) || !text(value.tokenizer.version)
    || !text(value.tokenizer.format)) failed(blockers, 'artifact manifest must identify its tokenizer and format')
  if (!Array.isArray(value.files) || value.files.length < 2) {
    failed(blockers, 'artifact manifest must list weight and tokenizer files')
    return []
  }
  const files = value.files
  if (!files.every((file) => onlyKeys(file, ['path', 'sha256', 'bytes', 'role']) && safeArtifactPath(file.path) && sha(file.sha256)
    && positive(file.bytes) && ['weights', 'tokenizer', 'configuration', 'other'].includes(file.role))) {
    failed(blockers, 'every artifact file needs a safe path, SHA-256, byte count and role')
    return []
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) failed(blockers, 'artifact manifest contains duplicate paths')
  if (!files.some((file) => file.role === 'weights') || !files.some((file) => file.role === 'tokenizer')) {
    failed(blockers, 'artifact manifest must include at least one weights file and one tokenizer file')
  }
  const artifactDigest = canonicalProvenanceSha256({
    schema: 'klyvaron.production-artifact-files.v1',
    files: [...files].map(({ path, sha256, bytes, role }) => ({ path, sha256: sha256.toLowerCase(), bytes, role }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  })
  if (artifactDigest !== identity.artifactSha256) failed(blockers, 'artifact manifest file set does not produce the model identity artifact digest')
  return files
}

function validateReportSet(documents, identity, artifactFiles, blockers) {
  const commonKeys = ['schema', 'tier', 'modelId', 'version', 'modelRevisionSha256', 'artifactSha256', 'evidenceClass', 'synthetic', 'mockedResponses']
  const schemaByFile = {
    'training-provenance.json': ['klyvaron.production-training-provenance.v1', [...commonKeys, 'sourceType', 'method', 'thirdPartyBasePresentedAsOriginal', 'foundationModel', 'trainingEnvironment', 'datasets', 'trainingConfigurationSha256', 'trainingRunSha256', 'trainingRunId', 'completedAt', 'privateChatAutoIngested', 'privateChatsIncluded']],
    'evaluation-report.json': ['klyvaron.production-evaluation-report.v1', [...commonKeys, 'passed', 'evaluationSuiteSha256', 'runId', 'completedAt', 'qualityMetrics', 'safetyMetrics', 'mandatoryChecks']],
    'performance-report.json': ['klyvaron.production-performance-report.v1', [...commonKeys, 'passed', 'runs']],
    'hardware-compatibility.json': ['klyvaron.production-hardware-compatibility.v1', [...commonKeys, 'passed', 'devices']],
    'security-report.json': ['klyvaron.production-security-report.v1', [...commonKeys, 'decision', 'reviewerId', 'reviewedAt', 'testSuiteSha256', 'findings']],
    'deployment-evidence.json': ['klyvaron.production-deployment-evidence.v1', [...commonKeys, 'passed', 'verificationMode', 'verifierId', 'verifierOrganization', 'independentOfTraining', 'independentOfDeployment', 'deploymentId', 'verifiedAt', 'testSuiteSha256', 'targets']],
    'rollback-test.json': ['klyvaron.production-rollback-test.v1', [...commonKeys, 'passed', 'rollbackCompleted', 'recoveryVerified', 'testRunId', 'completedAt', 'previousArtifactSha256', 'restoredArtifactSha256', 'recoveryProbeSha256']],
    'independent-review.json': ['klyvaron.production-independent-review.v1', [...commonKeys, 'decision', 'independent', 'involvedInTraining', 'involvedInDeployment', 'involvedInArtifactAuthoring', 'reviewerId', 'organization', 'reviewedAt', 'findings']],
    'release-decision.json': ['klyvaron.production-release-decision.v1', [...commonKeys, 'decision', 'authorized', 'approverId', 'authorityRole', 'reason', 'approvedAt']],
  }
  for (const [file, [schema, allowedKeys]] of Object.entries(schemaByFile)) {
    const item = documents[file]
    if (!onlyKeys(item, allowedKeys) || item.schema !== schema) failed(blockers, `${file} has an unsupported schema or unapproved fields`)
    else commonIdentityMatches(item, identity, file, blockers)
  }

  const training = documents['training-provenance.json']
  if (record(training)) {
    if (training.sourceType !== 'licensed_open_weight_foundation'
      || training.method !== 'first_party_fine_tuning'
      || training.thirdPartyBasePresentedAsOriginal !== false
      || !onlyKeys(training.foundationModel, ['id', 'isOpenWeight', 'revision', 'revisionSha256', 'license', 'licenseReviewStatus', 'licenseReviewReportSha256'])
      || training.foundationModel.isOpenWeight !== true
      || !text(training.foundationModel.id) || !text(training.foundationModel.revision)
      || !sha(training.foundationModel.revisionSha256) || !text(training.foundationModel.license)
      || training.foundationModel.licenseReviewStatus !== 'approved' || !sha(training.foundationModel.licenseReviewReportSha256)) {
      failed(blockers, 'training provenance must pin an approved licensed open-weight foundation and first-party fine-tuning without third-party-original claims')
    }
    if (!onlyKeys(training.trainingEnvironment, ['hostId', 'resourceClass']) || !text(training.trainingEnvironment.hostId)
      || !['local_low_resource', 'dedicated_gpu', 'cloud_gpu'].includes(training.trainingEnvironment.resourceClass)
      || (identity.tier !== 'lite' && training.trainingEnvironment.resourceClass === 'local_low_resource')) {
      failed(blockers, 'training provenance must identify the host class; Pro and Max cannot train on a low-resource host')
    }
    if (!Array.isArray(training.datasets) || training.datasets.length === 0
      || !training.datasets.every((dataset) => onlyKeys(dataset, ['id', 'version', 'sourceClass', 'license', 'manifestSha256', 'contentSha256'])
        && text(dataset.id) && isKlyvaronProductionVersion(dataset.version)
        && ['first_party_authored', 'public_domain', 'licensed_content'].includes(dataset.sourceClass)
        && text(dataset.license) && sha(dataset.manifestSha256) && sha(dataset.contentSha256))) {
      failed(blockers, 'training provenance must pin versioned, licensed dataset manifests and content digests')
    }
    if (!sha(training.trainingConfigurationSha256) || !sha(training.trainingRunSha256)
      || !text(training.trainingRunId) || !date(training.completedAt)
      || training.privateChatAutoIngested !== false || training.privateChatsIncluded !== false) {
      failed(blockers, 'training provenance must bind its configuration/run and attest that private chats were not auto-ingested')
    }
  }

  const evaluation = documents['evaluation-report.json']
  if (record(evaluation)) {
    if (evaluation.passed !== true || !sha(evaluation.evaluationSuiteSha256) || !text(evaluation.runId)
      || !date(evaluation.completedAt) || !numericMetrics(evaluation.qualityMetrics) || !numericMetrics(evaluation.safetyMetrics)
      || !Array.isArray(evaluation.mandatoryChecks) || evaluation.mandatoryChecks.length === 0
      || !evaluation.mandatoryChecks.every((check) => onlyKeys(check, ['id', 'passed', 'resultSha256'])
        && text(check.id) && check.passed === true && sha(check.resultSha256))) {
      failed(blockers, 'evaluation report must contain passing, reproducible quality and safety checks')
    }
  }

  const performance = documents['performance-report.json']
  if (record(performance)) {
    if (performance.passed !== true || !Array.isArray(performance.runs) || performance.runs.length === 0
      || !performance.runs.every((run) => onlyKeys(run, ['deviceId', 'os', 'runtimeId', 'runtimeVersion', 'measuredAt', 'runSha256', 'metrics'])
        && text(run.deviceId) && text(run.os) && text(run.runtimeId)
        && text(run.runtimeVersion) && date(run.measuredAt) && sha(run.runSha256) && record(run.metrics)
        && Number.isFinite(run.metrics.p50LatencyMs) && run.metrics.p50LatencyMs > 0
        && Number.isFinite(run.metrics.p95LatencyMs) && run.metrics.p95LatencyMs >= run.metrics.p50LatencyMs
        && Number.isFinite(run.metrics.tokensPerSecond) && run.metrics.tokensPerSecond > 0
        && positive(run.metrics.peakResidentBytes)
        && onlyKeys(run.metrics, ['p50LatencyMs', 'p95LatencyMs', 'tokensPerSecond', 'peakResidentBytes']))) {
      failed(blockers, 'performance report requires measured latency, throughput and memory on real hardware')
    }
  }

  const hardware = documents['hardware-compatibility.json']
  if (record(hardware)) {
    if (hardware.passed !== true || !Array.isArray(hardware.devices) || hardware.devices.length === 0
      || !hardware.devices.every((device) => onlyKeys(device, ['deviceId', 'os', 'architecture', 'runtimeId', 'runtimeVersion', 'compatible', 'measurementReportSha256', 'verifiedAt'])
        && text(device.deviceId) && text(device.os)
        && ['x64', 'arm64'].includes(device.architecture) && text(device.runtimeId) && text(device.runtimeVersion)
        && device.compatible === true && sha(device.measurementReportSha256) && date(device.verifiedAt))) {
      failed(blockers, 'hardware compatibility requires verified device/runtime measurements')
    }
  }

  const security = documents['security-report.json']
  if (record(security)) {
    if (security.decision !== 'pass' || !text(security.reviewerId) || !date(security.reviewedAt)
      || !sha(security.testSuiteSha256) || !Array.isArray(security.findings)
      || security.findings.some((finding) => !onlyKeys(finding, ['id', 'severity', 'status', 'resolutionReportSha256'])
        || !text(finding.id) || !['low', 'medium', 'high', 'critical'].includes(finding.severity)
        || finding.status !== 'resolved' || !sha(finding.resolutionReportSha256))) {
      failed(blockers, 'security review must pass with all findings resolved')
    }
  }

  const deployment = documents['deployment-evidence.json']
  if (record(deployment)) {
    if (deployment.passed !== true || deployment.verificationMode !== 'independent_pipeline'
      || !text(deployment.verifierId) || !text(deployment.verifierOrganization)
      || deployment.independentOfTraining !== true || deployment.independentOfDeployment !== true
      || !text(deployment.deploymentId) || !date(deployment.verifiedAt) || !sha(deployment.testSuiteSha256)
      || !Array.isArray(deployment.targets) || deployment.targets.length === 0
      || !deployment.targets.every((target) => onlyKeys(target, ['targetId', 'targetKind', 'deviceClass', 'deviceVerified', 'gpuVerified', 'gpuModel', 'os', 'architecture', 'runtimeId', 'runtimeVersion', 'actualInference', 'inferenceRunSha256', 'hardwareReportSha256', 'observedMetrics', 'tests'])
        && target.actualInference === true
        && sha(target.inferenceRunSha256) && text(target.targetId) && text(target.targetKind)
        && text(target.os) && text(target.architecture) && text(target.runtimeId)
        && text(target.runtimeVersion) && sha(target.hardwareReportSha256)
        && record(target.observedMetrics) && Number.isFinite(target.observedMetrics.p95LatencyMs)
        && target.observedMetrics.p95LatencyMs > 0 && Number.isFinite(target.observedMetrics.tokensPerSecond)
        && target.observedMetrics.tokensPerSecond > 0 && positive(target.observedMetrics.peakResidentBytes)
        && onlyKeys(target.observedMetrics, ['p95LatencyMs', 'tokensPerSecond', 'peakResidentBytes'])
        && Array.isArray(target.tests) && target.tests.every((check) => onlyKeys(check, ['id', 'passed', 'traceSha256']))
        && REQUIRED_DEPLOYMENT_TESTS.every((id) =>
          target.tests.some((check) => check?.id === id && check.passed === true && sha(check.traceSha256))))) {
      failed(blockers, 'deployment evidence must come from an independent real deployment pipeline and pass inference, streaming, cancellation, routing, access, isolation, recovery and resource tests')
    } else {
      const realTargets = deployment.targets
      const hasLocalConsumer = realTargets.some((target) => target.targetKind === 'local_consumer_device'
        && target.deviceVerified === true && target.deviceClass === 'consumer')
      const hasCloudGpu = realTargets.some((target) => target.targetKind === 'cloud_gpu_endpoint'
        && target.gpuVerified === true && text(target.gpuModel))
      if (!hasLocalConsumer && !hasCloudGpu) failed(blockers, 'deployment evidence needs a verified local consumer device or a real cloud GPU endpoint')
      for (const target of realTargets) {
        if (target.targetKind === 'local_consumer_device' && (target.deviceVerified !== true || target.deviceClass !== 'consumer')) {
          failed(blockers, `local deployment target '${target.targetId}' is not a verified consumer device`)
        } else if (target.targetKind === 'cloud_gpu_endpoint' && (target.gpuVerified !== true || !text(target.gpuModel))) {
          failed(blockers, `cloud deployment target '${target.targetId}' is not a verified GPU endpoint`)
        } else if (!['local_consumer_device', 'cloud_gpu_endpoint'].includes(target.targetKind)) {
          failed(blockers, `deployment target '${target.targetId}' has an unsupported target kind`)
        }
      }
    }
  }

  const rollback = documents['rollback-test.json']
  if (record(rollback)) {
    if (rollback.passed !== true || rollback.rollbackCompleted !== true || rollback.recoveryVerified !== true
      || !text(rollback.testRunId) || !date(rollback.completedAt) || !sha(rollback.previousArtifactSha256)
      || rollback.previousArtifactSha256 === identity.artifactSha256 || !sha(rollback.restoredArtifactSha256)
      || rollback.restoredArtifactSha256 !== rollback.previousArtifactSha256 || !sha(rollback.recoveryProbeSha256)) {
      failed(blockers, 'rollback test must restore the previous artifact and pass a recovery probe')
    }
  }

  const review = documents['independent-review.json']
  if (record(review)) {
    if (review.decision !== 'approve' || review.independent !== true || review.involvedInTraining === true
      || review.involvedInDeployment === true || review.involvedInArtifactAuthoring === true
      || !text(review.reviewerId) || !text(review.organization) || !date(review.reviewedAt)
      || !Array.isArray(review.findings) || review.findings.some((finding) => !onlyKeys(finding, ['id', 'status', 'resolutionReportSha256'])
        || !text(finding.id) || finding.status !== 'resolved' || !sha(finding.resolutionReportSha256))) {
      failed(blockers, 'independent review must approve without conflicts and resolve all findings')
    }
  }

  const decision = documents['release-decision.json']
  if (record(decision)) {
    if (decision.decision !== 'approve' || decision.authorized !== true || !text(decision.approverId)
      || !text(decision.authorityRole) || !text(decision.reason) || !date(decision.approvedAt)) {
      failed(blockers, 'release decision must explicitly approve with an authorized approver and reason')
    }
  }

  if (artifactFiles.length) {
    const hardwareDevices = record(documents['hardware-compatibility.json']) && Array.isArray(documents['hardware-compatibility.json'].devices)
      ? documents['hardware-compatibility.json'].devices : []
    const perfRuns = record(documents['performance-report.json']) && Array.isArray(documents['performance-report.json'].runs)
      ? documents['performance-report.json'].runs : []
    const deploymentTargets = record(documents['deployment-evidence.json']) && Array.isArray(documents['deployment-evidence.json'].targets)
      ? documents['deployment-evidence.json'].targets : []
    for (const device of hardwareDevices) {
      if (!perfRuns.some((run) => run.deviceId === device.deviceId && run.os === device.os
        && run.runtimeId === device.runtimeId && run.runtimeVersion === device.runtimeVersion)) {
        failed(blockers, `hardware target '${device.deviceId}' has no matching measured performance run`)
      }
    }
    for (const target of deploymentTargets) {
      if (!hardwareDevices.some((device) => device.deviceId === target.targetId && device.os === target.os
        && device.architecture === target.architecture && device.runtimeId === target.runtimeId
        && device.runtimeVersion === target.runtimeVersion && device.measurementReportSha256 === target.hardwareReportSha256)) {
        failed(blockers, `deployment target '${target.targetId}' does not match a signed hardware compatibility row`)
      }
    }
  }
}

/** Validate report shapes and cross-bindings. File hashes and signatures are checked elsewhere. */
export function validateKlyvaronProductionEvidenceDocuments({ tier, version, documents } = {}) {
  const blockers = []
  if (!Object.hasOwn(TIERS, tier) || !isKlyvaronProductionVersion(version)) {
    return { passed: false, blockers: ['a canonical Lite, Pro or Max tier and semantic version are required'], identity: null, artifactFiles: [] }
  }
  if (!record(documents)) return { passed: false, blockers: ['production evidence documents are required'], identity: null, artifactFiles: [] }
  for (const file of KLYVARON_PRODUCTION_EVIDENCE_FILES) {
    if (!Object.hasOwn(documents, file)) failed(blockers, `missing required evidence file '${file}'`)
  }
  for (const file of Object.keys(documents)) {
    if (!KLYVARON_PRODUCTION_EVIDENCE_FILES.includes(file)) failed(blockers, `unexpected evidence file '${file}'`)
  }
  const identity = validateModelIdentity(documents['model-identity.json'], tier, version, blockers)
  let artifactFiles = []
  if (identity) {
    const artifactManifest = documents['artifact-manifest.json']
    artifactFiles = validateArtifactManifest(artifactManifest, identity, blockers)
    if (record(artifactManifest)) {
      if (canonicalProvenanceSha256(artifactManifest) !== identity.artifactManifestSha256) {
        failed(blockers, 'artifact manifest digest does not match model identity')
      }
    }
    if (record(artifactManifest) && Array.isArray(artifactManifest.files)) {
      const checksumText = documents['artifact-checksums.sha256']
      if (typeof checksumText !== 'string') failed(blockers, 'artifact-checksums.sha256 must be a text file')
      else {
        const expected = [...artifactManifest.files].map((file) => `${file.sha256.toLowerCase()}  ${file.path}`).sort().join('\n') + '\n'
        if (checksumText !== expected) failed(blockers, 'artifact checksum text does not exactly match the artifact manifest')
      }
    }
    validateReportSet(documents, identity, artifactFiles, blockers)
  }
  return { passed: blockers.length === 0, blockers, identity, artifactFiles }
}

export function klyvaronEvidenceManifestBody({ tier, modelId, version, modelRevisionSha256, artifactSha256, issuedAt, expiresAt, files } = {}) {
  return {
    schema: 'klyvaron.production-evidence-manifest.v1',
    tier, modelId, version, modelRevisionSha256, artifactSha256, issuedAt, expiresAt,
    files: (Array.isArray(files) ? [...files] : []).sort((a, b) => String(a?.path ?? '').localeCompare(String(b?.path ?? ''))),
  }
}

export function klyvaronProductionReleaseDecisionDigest({ manifestSha256, releaseDecision } = {}) {
  return canonicalProvenanceSha256({
    schema: 'klyvaron.production-release-decision-binding.v1',
    manifestSha256,
    releaseDecision,
  })
}
