// Klyvaron's release registry and state machine.
//
// This is the release authority, not an inference router: a registry entry never makes a
// model selectable by itself. `isKlyvaronModelAvailable` additionally requires deployment-
// specific artifact and runtime evidence. The existing native runtime readiness checks stay
// in place and remain independent.

import { isVerifiedPinnedLocalFileReport } from './local-provenance.mjs'
import { klyvaronEvidenceAttestationPayload } from './evidence-trust.mjs'
import { isValidKlyvaronEvaluationReport, isValidKlyvaronTrainingRunReport } from './training-evidence.mjs'
import { isQualifiedKlyvaronDeployment, isValidKlyvaronTierQualificationReport } from './qualification-evidence.mjs'
import { verifyKlyvaronProductionEvidencePackage } from './release/signature-verifier.mjs'
import { canonicalProvenanceSha256 } from './provenance.mjs'

export const MODEL_RELEASE_STATES = Object.freeze({
  PLANNED: 'planned',
  TRAINING: 'training',
  TRAINED: 'trained',
  EVALUATED: 'evaluated',
  RELEASE_CANDIDATE: 'release_candidate',
  PRODUCTION_APPROVED: 'production_approved',
  RELEASED: 'released',
  SUSPENDED: 'suspended',
  DEPRECATED: 'deprecated',
  FAILED: 'failed',
})

const STATUS_VALUES = new Set(Object.values(MODEL_RELEASE_STATES))
const SHA256 = /^[a-f0-9]{64}$/i

function publicHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function releaseManifestDigestMatches(manifest) {
  const allowed = new Set(['schema', 'tier', 'modelId', 'version', 'modelRevisionSha256', 'artifactSha256',
    'productionEvidenceManifestSha256', 'status', 'location', 'publishedAt', 'sha256', 'keyId', 'attestation'])
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).some((key) => !allowed.has(key)) || !SHA256.test(manifest.sha256 ?? '')) return false
  const { sha256, keyId, attestation, ...body } = manifest
  try { return canonicalProvenanceSha256(body) === sha256 } catch { return false }
}

function attestationVerified(trustStore, { purpose, modelId, evidenceSha256, attestation, datasetScope }) {
  if (typeof trustStore?.verify !== 'function' || typeof evidenceSha256 !== 'string' || !SHA256.test(evidenceSha256)) return false
  try {
    const payload = klyvaronEvidenceAttestationPayload({ purpose, modelId, evidenceSha256, ...datasetScope })
    return trustStore.verify(payload, attestation, { purpose }).status === 'verified'
  } catch { return false }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

const MODEL_PLANS = Object.freeze([
  Object.freeze({
    id: 'klyvaron-lite-assistant', displayName: 'Klyvaron Lite', tier: 'lite', version: '0.1.0',
    targetParameterClass: 'not set; decide from foundation license, quality and target-device evidence',
  }),
  Object.freeze({
    id: 'klyvaron-pro-assistant', displayName: 'Klyvaron Pro', tier: 'pro', version: '0.1.0',
    targetParameterClass: 'not set; decide from foundation license, quality and training/inference evidence',
  }),
  Object.freeze({
    id: 'klyvaron-max-assistant', displayName: 'Klyvaron Max', tier: 'max', version: '0.1.0',
    targetParameterClass: 'not set; decide from foundation license, quality, runtime and cost evidence',
  }),
])

function currentArtifactEntry(identity) {
  const backing = identity.backing ?? {}
  const hasEvaluation = Boolean(backing.measured && Object.keys(backing.measured).length)
  return Object.freeze({
    id: identity.id,
    displayName: identity.id,
    tier: identity.tier,
    version: identity.version,
    status: hasEvaluation ? MODEL_RELEASE_STATES.EVALUATED : MODEL_RELEASE_STATES.TRAINED,
    ownership: 'first_party_research_artifact',
    provenance: backing.provenance ?? null,
    foundationModel: backing.baseModel ?? null,
    foundationModelLicense: null,
    artifactLocation: null,
    artifactChecksum: backing.artifactSha256 ?? null,
    artifactBytes: backing.artifactBytes ?? null,
    supportedFormats: [],
    supportedRuntimes: [],
    minimumHardware: null,
    recommendedHardware: null,
    contextLength: backing.contextTokens ?? null,
    quantization: backing.quantization ?? null,
    trainingDatasets: [],
    trainingConfiguration: null,
    tokenizer: null,
    chatTemplate: null,
    evaluationReport: backing.cardPath || backing.runRecordPath
      ? Object.freeze({ modelCardPath: backing.cardPath ?? null, runRecordPath: backing.runRecordPath ?? null, metrics: backing.measured ?? null })
      : null,
    downloadSizeBytes: backing.artifactBytes ?? null,
    modelCardUrl: backing.cardPath ?? null,
    available: false,
    availabilityReason: 'Historical native research artifact; not a released open-foundation Klyvaron assistant.',
  })
}

function plannedAssistantEntry(plan) {
  return Object.freeze({
    ...plan,
    status: MODEL_RELEASE_STATES.PLANNED,
    ownership: 'first_party_fine_tuned_assistant',
    provenance: null,
    foundationModel: null,
    foundationModelLicense: null,
    artifactLocation: null,
    artifactChecksum: null,
    artifactBytes: null,
    supportedFormats: Object.freeze([]),
    supportedRuntimes: Object.freeze([]),
    minimumHardware: null,
    recommendedHardware: null,
    contextLength: null,
    quantization: null,
    trainingDatasets: Object.freeze([]),
    trainingConfiguration: null,
    tokenizer: null,
    chatTemplate: null,
    evaluationReport: null,
    downloadSizeBytes: null,
    modelCardUrl: null,
    available: false,
    availabilityReason: 'Foundation selection, license review, training, evaluation, artifact and runtime qualification are pending.',
  })
}

/** Build the authoritative catalogue while preserving existing research artifact identities. */
export function buildKlyvaronModelRegistry({ liteIdentity, modelIdentities = {} } = {}) {
  const artifacts = [
    ...(liteIdentity ? [liteIdentity] : []),
    ...Object.values(modelIdentities),
  ]
  const entries = Object.fromEntries(artifacts.map((identity) => [identity.id, currentArtifactEntry(identity)]))
  for (const plan of MODEL_PLANS) {
    if (entries[plan.id]) throw new TypeError(`planned model id '${plan.id}' collides with a registered artifact`)
    entries[plan.id] = plannedAssistantEntry(plan)
  }
  return deepFreeze(entries)
}

/**
 * Report release evidence without inferring success from status strings or product labels.
 * A candidate is release-ready only if every non-signature gate passes; release also needs
 * a verified signed manifest. Callers must supply evidence only after the matching verifier
 * succeeds; this policy module checks evidence completeness but does not run those verifiers.
 */
export function klyvaronReleaseGateReport(record = {}, { trustStore = null } = {}) {
  const foundation = record.foundationModel
  const datasets = record.trainingDatasets
  const training = record.trainingConfiguration
  const trainingRun = record.trainingRunEvidence
  const artifact = record.artifact
  const tokenizer = record.tokenizer
  const evaluation = record.evaluationReport
  const runtimes = record.runtimeCompatibility
  const tierQualificationReport = record.tierQualificationReport
  const manifest = record.releaseManifest
  const productionEvidencePackage = record.productionEvidencePackage
  const productionEvidenceVerification = verifyKlyvaronProductionEvidencePackage({
    package: productionEvidencePackage,
    trustStore,
  })
  const productionManifest = productionEvidencePackage?.manifest
  const productionIdentity = productionEvidencePackage?.documents?.['model-identity.json']

  const gates = {
    exactFoundationAndApprovedLicense: Boolean(
      foundation?.id && foundation?.publisher && foundation?.name
      && foundation?.revision && foundation?.license
      && publicHttpsUrl(foundation.sourceUrl)
      && publicHttpsUrl(foundation.licenseSourceUrl)
      && foundation.licenseReviewStatus === 'approved'
      && SHA256.test(foundation.revisionDigest ?? '')
      && SHA256.test(foundation.licenseDocumentSha256 ?? '')
      && SHA256.test(foundation.licenseReviewReportSha256 ?? '')
      && foundation.provenanceValidation?.status === 'passed'
      && SHA256.test(foundation.provenanceValidation?.reportSha256 ?? '')
      && foundation.rightsReview?.fineTuningAllowed === true
      && foundation.rightsReview?.commercialUseAllowed === true
      && foundation.rightsReview?.derivativeWeightDistributionAllowed === true
      && foundation.rightsReview?.redistributionAllowed === true
      && foundation.rightsReview?.attributionSatisfied === true
      && foundation.rightsReview?.acceptableUseReviewed === true,
    ),
    foundationLicenseReviewAttested: attestationVerified(trustStore, {
      purpose: 'foundation_license_review', modelId: record.id,
      evidenceSha256: foundation?.provenanceValidation?.reportSha256,
      attestation: foundation?.licenseReviewAttestation,
    }),
    versionedLicensedDatasets: Array.isArray(datasets) && datasets.length > 0
      && datasets.every((dataset) => Boolean(
        dataset.id && dataset.version && dataset.license
        && SHA256.test(dataset.provenanceManifestSha256 ?? '')
        && dataset.provenanceValidation?.status === 'passed'
        && SHA256.test(dataset.provenanceValidation?.reportSha256 ?? '')
        && dataset.privacyReviewStatus === 'passed'
        && SHA256.test(dataset.privacyReviewReportSha256 ?? '')
        && dataset.deduplicationStatus === 'passed'
        && SHA256.test(dataset.deduplicationReportSha256 ?? '')
        && Number.isSafeInteger(dataset.fileBytes) && dataset.fileBytes > 0
        && SHA256.test(dataset.fileArtifactSha256 ?? '')
        && isVerifiedPinnedLocalFileReport(dataset.fileIntegrityVerification, {
          sha256: dataset.fileArtifactSha256, bytes: dataset.fileBytes,
        }),
      )),
    datasetProvenanceAttested: Array.isArray(datasets) && datasets.length > 0
      && datasets.every((dataset) => attestationVerified(trustStore, {
        purpose: 'dataset_provenance_review', modelId: record.id,
        evidenceSha256: dataset.provenanceValidation?.reportSha256,
        attestation: dataset.provenanceAttestation,
        datasetScope: {
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          provenanceManifestSha256: dataset.provenanceManifestSha256,
        },
      })),
    datasetFileIntegrityAttested: Array.isArray(datasets) && datasets.length > 0
      && datasets.every((dataset) => attestationVerified(trustStore, {
        purpose: 'dataset_artifact_integrity', modelId: record.id,
        evidenceSha256: dataset.fileIntegrityVerification?.reportSha256,
        attestation: dataset.fileIntegrityAttestation,
        datasetScope: {
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          provenanceManifestSha256: dataset.provenanceManifestSha256,
        },
      })), 
    reproducibleTrainingConfiguration: Boolean(
      isValidKlyvaronTrainingRunReport(trainingRun, { modelId: record.id })
      && training?.method === trainingRun.method
      && training?.runId === trainingRun.runId
      && training?.configurationSha256 === trainingRun.configurationSha256
      && training?.runRecordSha256 === trainingRun.reportSha256
      && trainingRun.foundationModelId === foundation?.id
      && trainingRun.foundationRevisionSha256 === foundation?.revisionDigest
      && Array.isArray(datasets) && datasets.some((dataset) => dataset.provenanceManifestSha256 === trainingRun.datasetManifestSha256)
      && trainingRun.artifactSha256 === artifact?.sha256
      && trainingRun.artifactBytes === artifact?.bytes,
    ),
    trainingRunAttested: attestationVerified(trustStore, {
      purpose: 'training_run', modelId: record.id,
      evidenceSha256: trainingRun?.reportSha256,
      attestation: record.trainingRunAttestation,
    }),
    verifiedArtifactAndChecksum: Boolean(
      artifact?.location && artifact?.format && Number.isSafeInteger(artifact?.bytes) && artifact.bytes > 0
      && SHA256.test(artifact.sha256 ?? '')
      && isVerifiedPinnedLocalFileReport(artifact.integrityVerification, { sha256: artifact.sha256, bytes: artifact.bytes }),
    ),
    artifactIntegrityAttested: attestationVerified(trustStore, {
      purpose: 'artifact_integrity', modelId: record.id,
      evidenceSha256: artifact?.integrityVerification?.reportSha256,
      attestation: artifact?.integrityAttestation,
    }),
    tokenizerAndChatTemplatePinned: Boolean(
      tokenizer?.id && SHA256.test(tokenizer.sha256 ?? '')
      && record.chatTemplate?.id && SHA256.test(record.chatTemplate.sha256 ?? ''),
    ),
    heldOutEvaluationPassed: isValidKlyvaronEvaluationReport(evaluation, {
      modelId: record.id,
      trainingRunReportSha256: trainingRun?.reportSha256,
      artifactSha256: artifact?.sha256,
      mode: trainingRun?.adaptiveMode,
    }),
    heldOutEvaluationAttested: attestationVerified(trustStore, {
      purpose: 'held_out_evaluation', modelId: record.id,
      evidenceSha256: evaluation?.reportSha256,
      attestation: evaluation?.attestation,
    }),
    runtimeCompatibilityMeasured: Boolean(
      runtimes?.passed === true && Array.isArray(runtimes.results) && runtimes.results.length > 0
      && runtimes.results.every((result) => result.passed === true && result.modelId === record.id),
    ),
    tierReleaseQualificationMeasured: isValidKlyvaronTierQualificationReport(tierQualificationReport, {
      modelId: record.id,
      tier: record.tier,
      artifactSha256: artifact?.sha256,
      artifactBytes: artifact?.bytes,
      minimumRamBytes: record.minimumHardware?.ramBytes,
      supportedRuntimes: record.supportedRuntimes,
    }),
    tierReleaseQualificationAttested: attestationVerified(trustStore, {
      purpose: 'tier_release_qualification', modelId: record.id,
      evidenceSha256: tierQualificationReport?.reportSha256,
      attestation: tierQualificationReport?.attestation,
    }),
    releaseMetadataComplete: Boolean(
      Array.isArray(record.supportedFormats) && record.supportedFormats.length > 0
      && Array.isArray(record.supportedRuntimes) && record.supportedRuntimes.length > 0
      && record.minimumHardware && record.recommendedHardware
      && Number.isInteger(record.contextLength) && record.contextLength > 0
      && record.quantization && Number.isSafeInteger(record.downloadSizeBytes) && record.downloadSizeBytes > 0
      && typeof record.modelCardUrl === 'string' && record.modelCardUrl.length > 0,
    ),
    productionEvidencePackageVerified: Boolean(
      productionEvidenceVerification.passed
      && productionManifest?.tier === record.tier
      && productionManifest?.modelId === record.id
      && productionManifest?.version === record.version
      && productionManifest?.artifactSha256 === artifact?.sha256
      && productionManifest?.modelRevisionSha256 === record.modelRevisionSha256
      && productionIdentity?.modelId === record.id
      && productionIdentity?.tier === record.tier
      && productionIdentity?.version === record.version
      && productionIdentity?.artifactSha256 === artifact?.sha256
      && productionIdentity?.modelRevisionSha256 === record.modelRevisionSha256,
    ),
    signedReleaseManifestVerified: Boolean(
      manifest?.schema === 'klyvaron.production-publication-manifest.v1'
      && manifest.tier === record.tier && manifest.modelId === record.id && manifest.version === record.version
      && manifest.keyId && manifest.keyId === manifest.attestation?.keyId && releaseManifestDigestMatches(manifest)
      && manifest.status === 'published' && typeof manifest.location === 'string' && manifest.location.trim()
      && typeof manifest.publishedAt === 'string' && Number.isFinite(Date.parse(manifest.publishedAt))
      && !Object.values(productionEvidencePackage?.signatures ?? {}).some((attestation) => attestation?.keyId === manifest.keyId)
      && manifest.artifactSha256 === artifact?.sha256
      && manifest.modelRevisionSha256 === record.modelRevisionSha256
      && manifest.productionEvidenceManifestSha256 === productionManifest?.manifestSha256
      && attestationVerified(trustStore, {
        purpose: 'release_manifest', modelId: record.id,
        evidenceSha256: manifest.sha256,
        attestation: manifest.attestation,
      }),
    ),
  }
  const candidateGateNames = Object.keys(gates).filter((name) => ![
    'productionEvidencePackageVerified', 'signedReleaseManifestVerified',
  ].includes(name))
  const releaseCandidateReady = candidateGateNames.every((name) => gates[name])
  const productionApprovalReady = releaseCandidateReady && gates.productionEvidencePackageVerified
  const releasedReady = productionApprovalReady && gates.signedReleaseManifestVerified
  return {
    releaseCandidateReady,
    productionApprovalReady,
    releasedReady,
    gates,
    blockers: Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name),
  }
}

const TRANSITIONS = Object.freeze({
  [MODEL_RELEASE_STATES.PLANNED]: [MODEL_RELEASE_STATES.TRAINING, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.TRAINING]: [MODEL_RELEASE_STATES.TRAINED, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.TRAINED]: [MODEL_RELEASE_STATES.EVALUATED, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.EVALUATED]: [MODEL_RELEASE_STATES.RELEASE_CANDIDATE, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.RELEASE_CANDIDATE]: [MODEL_RELEASE_STATES.PRODUCTION_APPROVED, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.PRODUCTION_APPROVED]: [MODEL_RELEASE_STATES.RELEASED, MODEL_RELEASE_STATES.SUSPENDED, MODEL_RELEASE_STATES.FAILED],
  [MODEL_RELEASE_STATES.RELEASED]: [MODEL_RELEASE_STATES.SUSPENDED, MODEL_RELEASE_STATES.DEPRECATED],
  [MODEL_RELEASE_STATES.SUSPENDED]: [],
  [MODEL_RELEASE_STATES.FAILED]: [MODEL_RELEASE_STATES.PLANNED],
  [MODEL_RELEASE_STATES.DEPRECATED]: [],
})

/** Advance a release record only when the next lifecycle stage has its required evidence. */
export function advanceKlyvaronModelRelease(record, nextStatus, evidence = {}, { trustStore = null } = {}) {
  if (!record || !STATUS_VALUES.has(record.status)) throw new TypeError('model record has an unknown release status')
  if (!STATUS_VALUES.has(nextStatus)) throw new TypeError(`unknown model release status '${nextStatus}'`)
  if (!TRANSITIONS[record.status].includes(nextStatus)) {
    throw new Error(`invalid model release transition '${record.status}' -> '${nextStatus}'`)
  }

  if (record.status === MODEL_RELEASE_STATES.PRODUCTION_APPROVED && nextStatus !== MODEL_RELEASE_STATES.SUSPENDED
    && !klyvaronReleaseGateReport(record, { trustStore }).productionApprovalReady) {
    throw new Error('an unverifiable production approval cannot be transitioned or advertised')
  }
  if (record.status === MODEL_RELEASE_STATES.RELEASED
    && ![MODEL_RELEASE_STATES.SUSPENDED, MODEL_RELEASE_STATES.DEPRECATED].includes(nextStatus)
    && !klyvaronReleaseGateReport(record, { trustStore }).releasedReady) {
    throw new Error('an unverifiable release cannot be transitioned or advertised')
  }
  const next = { ...structuredClone(record), ...structuredClone(evidence), status: nextStatus }
  if ([MODEL_RELEASE_STATES.FAILED, MODEL_RELEASE_STATES.SUSPENDED, MODEL_RELEASE_STATES.DEPRECATED].includes(nextStatus)
    && !(typeof next.reason === 'string' && next.reason.trim())) {
    throw new Error(`transition to '${nextStatus}' requires a non-empty reason`)
  }
  if (record.status === MODEL_RELEASE_STATES.FAILED && nextStatus === MODEL_RELEASE_STATES.PLANNED
    && (!next.version || next.version === record.version)) {
    throw new Error('replanning a failed model requires a new version')
  }

  const gates = klyvaronReleaseGateReport(next, { trustStore })
  if (nextStatus === MODEL_RELEASE_STATES.TRAINED && !gates.gates.verifiedArtifactAndChecksum) {
    throw new Error('a model cannot become trained without an artifact whose checksum was verified')
  }
  if (nextStatus === MODEL_RELEASE_STATES.TRAINED
    && (!gates.gates.reproducibleTrainingConfiguration || !gates.gates.trainingRunAttested)) {
    throw new Error('a model cannot become trained without a valid, trusted training-run report')
  }
  if (nextStatus === MODEL_RELEASE_STATES.EVALUATED
    && (!gates.gates.heldOutEvaluationPassed || !gates.gates.heldOutEvaluationAttested)) {
    throw new Error('a model cannot become evaluated without a valid, trusted Adaptive held-out evaluation report')
  }
  if (nextStatus === MODEL_RELEASE_STATES.RELEASE_CANDIDATE && !gates.releaseCandidateReady) {
    throw new Error(`release-candidate gates are incomplete: ${gates.blockers.join(', ')}`)
  }
  if (nextStatus === MODEL_RELEASE_STATES.PRODUCTION_APPROVED && !gates.productionApprovalReady) {
    throw new Error(`production approval gates are incomplete: ${gates.blockers.join(', ')}`)
  }
  if (nextStatus === MODEL_RELEASE_STATES.RELEASED && !gates.releasedReady) {
    throw new Error(`release gates are incomplete: ${gates.blockers.join(', ')}`)
  }
  return deepFreeze(next)
}

/** Registry presence is not availability; require a released, verified artifact and runtime. */
export function isKlyvaronModelAvailable(record, deployment = {}, { trustStore = null } = {}) {
  if (record?.status !== MODEL_RELEASE_STATES.RELEASED) return false
  const gates = klyvaronReleaseGateReport(record, { trustStore })
  return gates.releasedReady && isQualifiedKlyvaronDeployment(record.tierQualificationReport, deployment, {
    modelId: record.id,
    tier: record.tier,
    artifactSha256: record.artifact?.sha256,
    artifactBytes: record.artifact?.bytes,
    minimumRamBytes: record.minimumHardware?.ramBytes,
    supportedRuntimes: record.supportedRuntimes,
  })
}
