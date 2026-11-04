import { createHash } from 'node:crypto'
import {
  KlyvaronEvidenceTrustStore,
  canonicalKlyvaronEvidenceJson,
  klyvaronEvidenceAttestationPayload,
} from './evidence-trust.mjs'
import { isValidKlyvaronTierQualificationReport, prepareKlyvaronTierQualificationReport } from './qualification-evidence.mjs'

const REQUIRED_PLATFORMS = new Set(['linux', 'macos', 'windows'])
const PURPOSE = 'tier_release_qualification'
const SIGNING_DOMAIN = 'klyvaron-evidence-attestation/v1'
const SHA256 = /^[a-f0-9]{64}$/i

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function validSha(value) { return typeof value === 'string' && SHA256.test(value) }
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function blocked(reason) { return { status: 'blocked', passed: false, blockers: [reason], report: null, signingRequest: null } }

function recordQualificationOptions(record) {
  return {
    modelId: record.id,
    tier: record.tier,
    artifactSha256: record.artifact?.sha256,
    artifactBytes: record.artifact?.bytes,
    minimumRamBytes: record.minimumHardware?.ramBytes,
    supportedRuntimes: record.supportedRuntimes,
  }
}

/**
 * Assemble actual host-capture results into one unsigned cross-platform report and a
 * canonical signing request. This never loads, reads or generates a private key.
 */
export function prepareKlyvaronQualificationSigningRequest({ modelRecord, captures } = {}) {
  if (!isRecord(modelRecord) || !Array.isArray(captures) || captures.length !== REQUIRED_PLATFORMS.size) {
    return blocked('one exact release record and three platform capture results are required')
  }
  const platformNames = captures.map((capture) => capture?.target?.platform)
  if (new Set(platformNames).size !== REQUIRED_PLATFORMS.size
    || [...platformNames].some((platformName) => !REQUIRED_PLATFORMS.has(platformName))) {
    return blocked('capture results must contain exactly one Windows, Linux and macOS target')
  }
  for (const capture of captures) {
    if (capture?.status !== 'passed' || capture.passed !== true || !Array.isArray(capture.blockers) || capture.blockers.length !== 0
      || !isRecord(capture.target) || !validSha(capture.artifactIntegrityReportSha256)
      || capture.target.artifactIntegrityReportSha256 !== capture.artifactIntegrityReportSha256) {
      return blocked('each platform capture must pass and bind its successful local artifact-integrity report')
    }
  }
  const options = recordQualificationOptions(modelRecord)
  const prepared = prepareKlyvaronTierQualificationReport({
    modelId: options.modelId,
    tier: options.tier,
    artifactSha256: options.artifactSha256,
    artifactBytes: options.artifactBytes,
    minimumRamBytes: options.minimumRamBytes,
    supportedRuntimes: options.supportedRuntimes,
    targets: captures.map((capture) => capture.target),
  })
  if (!prepared.passed || !isValidKlyvaronTierQualificationReport(prepared.report, options)) {
    return blocked('cross-platform captures do not form a valid report for the release record')
  }
  const payload = klyvaronEvidenceAttestationPayload({
    purpose: PURPOSE,
    modelId: options.modelId,
    evidenceSha256: prepared.report.reportSha256,
  })
  const canonicalPayloadJson = canonicalKlyvaronEvidenceJson(payload)
  const signingMessage = `${SIGNING_DOMAIN}\n${canonicalPayloadJson}`
  return {
    status: 'ready_for_offline_signature',
    passed: true,
    blockers: [],
    report: prepared.report,
    signingRequest: {
      schema: 'klyvaron.offline-signing-request.v1',
      purpose: PURPOSE,
      modelId: options.modelId,
      evidenceSha256: prepared.report.reportSha256,
      payload,
      canonicalPayloadJson,
      signingMessage,
      signingMessageSha256: hash(signingMessage),
      privateKeyHandling: 'not_performed_by_this_tool',
    },
  }
}

/** Verify the externally signed report against existing operator-managed public trust anchors. */
export function auditKlyvaronQualificationAttestation({ modelRecord, qualificationReport, trustStore } = {}) {
  if (!isRecord(modelRecord) || !isRecord(qualificationReport)) {
    return { status: 'blocked', passed: false, blockers: ['a release record and signed qualification report are required'], keyId: null }
  }
  const options = recordQualificationOptions(modelRecord)
  if (!isValidKlyvaronTierQualificationReport(qualificationReport, options)) {
    return { status: 'blocked', passed: false, blockers: ['qualification report does not match the exact model, tier, artifact, hardware minimum or supported runtimes'], keyId: null }
  }
  if (!(trustStore instanceof KlyvaronEvidenceTrustStore)) {
    return { status: 'blocked', passed: false, blockers: ['an operator-managed public-key trust store is required'], keyId: null }
  }
  let payload
  try {
    payload = klyvaronEvidenceAttestationPayload({
      purpose: PURPOSE,
      modelId: options.modelId,
      evidenceSha256: qualificationReport.reportSha256,
    })
  } catch {
    return { status: 'blocked', passed: false, blockers: ['qualification attestation payload is invalid'], keyId: null }
  }
  const verified = trustStore.verify(payload, qualificationReport.attestation, { purpose: PURPOSE })
  return verified.status === 'verified'
    ? { status: 'verified', passed: true, blockers: [], keyId: verified.keyId, purpose: PURPOSE }
    : { status: 'blocked', passed: false, blockers: [verified.reason], keyId: verified.keyId ?? null }
}
