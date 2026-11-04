import { canonicalProvenanceSha256, validateKlyvaronDatasetManifest } from './provenance.mjs'
import { verifyPinnedLocalFiles } from './local-provenance.mjs'
import { klyvaronEvidenceAttestationPayload } from './evidence-trust.mjs'

const INTAKE_SCHEMA = 'klyvaron.dataset-intake-verification.v1'

function reportDigest(body) { return canonicalProvenanceSha256(body) }

function blockedIntake({ modelId = null, provenance = null, fileReport = null, blockers }) {
  const body = {
    schema: INTAKE_SCHEMA,
    status: 'blocked',
    modelId,
    datasetId: provenance?.evidence?.id ?? null,
    datasetVersion: provenance?.evidence?.version ?? null,
    provenanceManifestSha256: provenance?.manifestSha256 ?? null,
    provenanceReportSha256: provenance?.reportSha256 ?? null,
    fileVerificationReportSha256: fileReport?.reportSha256 ?? null,
    sourceAuthenticity: 'not_established',
    blockers,
  }
  return {
    ...body,
    passed: false,
    reportSha256: reportDigest(body),
    provenanceValidation: provenance,
    fileIntegrityVerification: fileReport,
    evidence: null,
    attestationPayloads: null,
  }
}

/**
 * Assemble validator-generated metadata and local-byte reports into one dataset intake result.
 * It performs no network access, never reads private chats by default, and does not authenticate
 * URLs, expected hashes, reviewer identity, legal rights or source authenticity. Returned
 * attestation payloads are unsigned; signing remains an explicit operator action outside Core.
 */
export async function verifyKlyvaronDatasetIntake({
  modelId,
  manifest,
  root,
  files,
  maxFileBytes,
  maxTotalBytes,
} = {}) {
  if (typeof modelId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(modelId)) {
    return blockedIntake({ blockers: ['a valid model id is required'] })
  }

  const provenance = validateKlyvaronDatasetManifest(manifest)
  if (!provenance.passed) {
    return blockedIntake({
      modelId,
      provenance,
      blockers: provenance.blockers.map((reason) => `dataset metadata: ${reason}`),
    })
  }

  const fileReport = await verifyPinnedLocalFiles({ root, files, maxFileBytes, maxTotalBytes })
  if (!fileReport.passed) {
    return blockedIntake({
      modelId,
      provenance,
      fileReport,
      blockers: fileReport.blockers.length ? fileReport.blockers : ['local dataset bytes did not verify'],
    })
  }

  const dataset = provenance.evidence
  const datasetScope = {
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    provenanceManifestSha256: dataset.provenanceManifestSha256,
  }
  const evidence = {
    ...dataset,
    fileBytes: fileReport.totalBytes,
    fileArtifactSha256: fileReport.artifactSha256,
    fileIntegrityVerification: fileReport,
  }
  const attestationPayloads = {
    datasetProvenanceReview: klyvaronEvidenceAttestationPayload({
      purpose: 'dataset_provenance_review',
      modelId,
      evidenceSha256: dataset.provenanceValidation.reportSha256,
      ...datasetScope,
    }),
    datasetArtifactIntegrity: klyvaronEvidenceAttestationPayload({
      purpose: 'dataset_artifact_integrity',
      modelId,
      evidenceSha256: fileReport.reportSha256,
      ...datasetScope,
    }),
  }
  const body = {
    schema: INTAKE_SCHEMA,
    status: 'passed',
    modelId,
    datasetId: dataset.id,
    datasetVersion: dataset.version,
    provenanceManifestSha256: dataset.provenanceManifestSha256,
    provenanceReportSha256: dataset.provenanceValidation.reportSha256,
    fileVerificationReportSha256: fileReport.reportSha256,
    artifactSha256: fileReport.artifactSha256,
    totalBytes: fileReport.totalBytes,
    sourceAuthenticity: 'not_established',
    blockers: [],
  }
  return {
    ...body,
    passed: true,
    reportSha256: reportDigest(body),
    provenanceValidation: provenance,
    fileIntegrityVerification: fileReport,
    evidence,
    attestationPayloads,
  }
}
