import { createHash } from 'node:crypto'
import { canonicalProvenanceSha256 } from '../provenance.mjs'
import { klyvaronEvidenceAttestationPayload } from '../evidence-trust.mjs'
import {
  KLYVARON_PRODUCTION_EVIDENCE_FILES,
  KLYVARON_PRODUCTION_SIGNATURES,
  klyvaronEvidenceManifestBody,
  klyvaronProductionModelId,
  klyvaronProductionReleaseDecisionDigest,
  validateKlyvaronProductionEvidenceDocuments,
} from './evidence-schema.mjs'

const SHA256 = /^[a-f0-9]{64}$/i
const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const MAX_PRODUCTION_EVIDENCE_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function blocked(reason, verification = []) {
  return { passed: false, status: 'blocked', blockers: [reason], verifications: verification }
}

/** Verify the four purpose-scoped Ed25519 attestations for a parsed production package. */
export function verifyKlyvaronProductionEvidenceSignatures({ manifest, signatures, documents, trustStore, now = new Date() } = {}) {
  const verifications = []
  const blockers = []
  if (!trustStore || typeof trustStore.verify !== 'function'
    || typeof trustStore.isSupersededEvidenceManifest !== 'function') return blocked('production evidence trust store or supersession ledger is missing')
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return blocked('release verifier time is invalid')
  if (!isRecord(manifest) || !isRecord(documents) || !isRecord(signatures)) return blocked('manifest, documents and signatures are required')
  const allowedManifestKeys = new Set(['schema', 'tier', 'modelId', 'version', 'modelRevisionSha256', 'artifactSha256', 'issuedAt', 'expiresAt', 'files', 'manifestSha256'])
  if (Object.keys(manifest).some((key) => !allowedManifestKeys.has(key))) blockers.push('evidence manifest contains unexpected fields')
  const { manifestSha256, ...manifestRest } = manifest
  let computedManifestSha256 = null
  try { computedManifestSha256 = canonicalProvenanceSha256(klyvaronEvidenceManifestBody(manifestRest)) } catch { /* malformed manifest remains blocked */ }
  if (!SHA256.test(manifestSha256 ?? '') || manifestSha256 !== computedManifestSha256) {
    blockers.push('evidence manifest digest is invalid')
  }
  if (trustStore?.isSupersededEvidenceManifest?.(manifestSha256)) {
    blockers.push('production evidence manifest has been superseded or revoked')
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) blockers.push('release verifier time is invalid')
  if (!iso(manifest.issuedAt) || !iso(manifest.expiresAt) || Date.parse(manifest.issuedAt) >= Date.parse(manifest.expiresAt)) {
    blockers.push('evidence manifest issuance or expiry timestamps are invalid')
  } else {
    if (Date.parse(manifest.expiresAt) <= now.getTime()) blockers.push('production evidence package has expired')
    if (Date.parse(manifest.expiresAt) - Date.parse(manifest.issuedAt) > MAX_PRODUCTION_EVIDENCE_VALIDITY_MS) {
      blockers.push('production evidence package validity exceeds the 90-day maximum')
    }
    if (Date.parse(manifest.issuedAt) > now.getTime() + 5 * 60 * 1000) blockers.push('evidence manifest is issued in the future')
    const list = (value) => Array.isArray(value) ? value : []
    const reportTimes = [
      documents['training-provenance.json']?.completedAt,
      documents['evaluation-report.json']?.completedAt,
      ...list(documents['performance-report.json']?.runs).map((item) => item?.measuredAt),
      ...list(documents['hardware-compatibility.json']?.devices).map((item) => item?.verifiedAt),
      documents['security-report.json']?.reviewedAt,
      documents['deployment-evidence.json']?.verifiedAt,
      documents['rollback-test.json']?.completedAt,
      documents['independent-review.json']?.reviewedAt,
      documents['release-decision.json']?.approvedAt,
    ].filter((value) => value !== undefined)
    if (reportTimes.some((value) => !iso(value) || Date.parse(value) > Date.parse(manifest.issuedAt))) {
      blockers.push('evidence reports must have valid timestamps no later than the signed manifest issuance')
    }
  }
  if (manifest.schema !== 'klyvaron.production-evidence-manifest.v1') blockers.push('unsupported evidence manifest schema')

  const digestOrNull = (value) => {
    try { return canonicalProvenanceSha256(value) } catch { return null }
  }
  let releaseDecisionDigest = null
  try { releaseDecisionDigest = klyvaronProductionReleaseDecisionDigest({ manifestSha256, releaseDecision: documents['release-decision.json'] }) } catch { /* invalid report remains blocked */ }
  const expected = [
    ['evidence', KLYVARON_PRODUCTION_SIGNATURES.evidence, manifestSha256, 'release_evidence_custodian', null],
    ['deployment', KLYVARON_PRODUCTION_SIGNATURES.deployment, digestOrNull(documents['deployment-evidence.json']), 'deployment_verifier', documents['deployment-evidence.json']?.verifierId],
    ['independentReview', KLYVARON_PRODUCTION_SIGNATURES.independentReview, digestOrNull(documents['independent-review.json']), 'independent_reviewer', documents['independent-review.json']?.reviewerId],
    ['releaseDecision', KLYVARON_PRODUCTION_SIGNATURES.releaseDecision, releaseDecisionDigest, 'release_approver', documents['release-decision.json']?.approverId],
  ]
  const keyIds = new Map()
  for (const [role, spec, evidenceSha256, requiredRole, requiredPrincipal] of expected) {
    const attestation = signatures[spec.file]
    let result
    if (!SHA256.test(evidenceSha256 ?? '')) {
      result = { status: 'blocked', keyId: null, reason: `${role} evidence digest is invalid` }
    } else {
      try {
        const payload = klyvaronEvidenceAttestationPayload({
          purpose: spec.purpose,
          modelId: manifest.modelId,
          evidenceSha256,
        })
        result = trustStore.verify(payload, attestation, { purpose: spec.purpose })
      } catch {
        result = { status: 'blocked', keyId: attestation?.keyId ?? null, reason: `${role} signature payload is invalid` }
      }
    }
    verifications.push({ role, ...result })
    if (result.status !== 'verified') blockers.push(`${role} signature: ${result.reason ?? 'not verified'}`)
    else {
      keyIds.set(role, result.keyId)
      if (!result.roles?.includes(requiredRole)) blockers.push(`${role} signer lacks required trust role '${requiredRole}'`)
      if (requiredPrincipal && result.principalId !== requiredPrincipal) blockers.push(`${role} signer principal does not match the named reviewer or approver`)
    }
  }
  if (new Set(keyIds.values()).size !== keyIds.size) blockers.push('evidence, deployment, independent review and approval must use distinct trusted signing keys')
  const principalIds = verifications.filter((item) => item.status === 'verified').map((item) => item.principalId)
  if (principalIds.some((item) => !item) || new Set(principalIds).size !== principalIds.length) blockers.push('production signers must have distinct, named trusted principals')
  const review = documents['independent-review.json']
  const decision = documents['release-decision.json']
  if (review?.reviewerId && decision?.approverId && review.reviewerId === decision.approverId) {
    blockers.push('independent reviewer and release approver must be different people')
  }
  if (manifest.tier !== documents['model-identity.json']?.tier
    || manifest.modelId !== documents['model-identity.json']?.modelId
    || manifest.version !== documents['model-identity.json']?.version
    || manifest.modelRevisionSha256 !== documents['model-identity.json']?.modelRevisionSha256
    || manifest.artifactSha256 !== documents['model-identity.json']?.artifactSha256) {
    blockers.push('evidence manifest identity does not match model-identity.json')
  }
  return { passed: blockers.length === 0, status: blockers.length === 0 ? 'verified' : 'blocked', blockers, verifications }
}

/** Reverify a package already loaded by the CI verifier before storing it in the registry. */
export function verifyKlyvaronProductionEvidencePackage({ package: evidencePackage, trustStore, now = new Date() } = {}) {
  if (!isRecord(evidencePackage) || Object.keys(evidencePackage).some((key) => !['schema', 'manifest', 'signatures', 'documents', 'fileContents', 'artifactVerification'].includes(key))
    || evidencePackage.schema !== 'klyvaron.production-evidence-package.v1'
    || !isRecord(evidencePackage.manifest) || !isRecord(evidencePackage.signatures) || !isRecord(evidencePackage.fileContents)
    || !isRecord(evidencePackage.documents)) {
    return blocked('production evidence package object is missing or has an unsupported schema')
  }
  const blockers = []
  const expectedSignatureFiles = Object.values(KLYVARON_PRODUCTION_SIGNATURES).map((entry) => entry.file)
  if (Object.keys(evidencePackage.signatures).length !== expectedSignatureFiles.length
    || Object.keys(evidencePackage.signatures).some((filename) => !expectedSignatureFiles.includes(filename))) {
    blockers.push('production evidence package has missing or unexpected signature files')
  }
  const documents = {}
  const manifest = evidencePackage.manifest
  const entries = manifest.files
  if (!Array.isArray(entries) || entries.length !== KLYVARON_PRODUCTION_EVIDENCE_FILES.length) {
    blockers.push('production evidence package does not pin the complete required file set')
  }
  for (const filename of KLYVARON_PRODUCTION_EVIDENCE_FILES) {
    const content = evidencePackage.fileContents[filename]
    const entry = Array.isArray(entries) ? entries.find((item) => item?.path === filename) : null
    if (typeof content !== 'string' || !entry) {
      blockers.push(`production evidence package is missing '${filename}'`)
      continue
    }
    const bytes = Buffer.from(content, 'utf8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (entry.sha256 !== sha256 || entry.bytes !== bytes.length) blockers.push(`stored evidence bytes changed for '${filename}'`)
    if (filename === 'artifact-checksums.sha256') documents[filename] = content
    else {
      try { documents[filename] = JSON.parse(content) } catch { blockers.push(`stored evidence JSON is invalid for '${filename}'`) }
    }
    if (documents[filename] && (evidencePackage.documents[filename] === undefined
      || canonicalProvenanceSha256(documents[filename]) !== canonicalProvenanceSha256(evidencePackage.documents[filename]))) {
      blockers.push(`stored parsed evidence differs from '${filename}'`)
    }
  }
  if (Object.keys(evidencePackage.fileContents).some((filename) => !KLYVARON_PRODUCTION_EVIDENCE_FILES.includes(filename))) {
    blockers.push('production evidence package contains unexpected report files')
  }
  const tier = manifest.tier
  const version = manifest.version
  if (!klyvaronProductionModelId(tier) || !isRecord(documents['model-identity.json'])) {
    blockers.push('production package tier/model identity is invalid')
  } else {
    const shape = validateKlyvaronProductionEvidenceDocuments({ tier, version, documents })
    blockers.push(...shape.blockers)
  }
  const signatureReport = verifyKlyvaronProductionEvidenceSignatures({
    manifest,
    signatures: evidencePackage.signatures,
    documents,
    trustStore,
    now,
  })
  blockers.push(...signatureReport.blockers)
  const artifactFiles = documents['artifact-manifest.json']?.files
  const verifiedFiles = evidencePackage.artifactVerification?.files
  const artifactReport = evidencePackage.artifactVerification
  const artifactReportShape = isRecord(artifactReport)
    && Object.keys(artifactReport).every((key) => ['passed', 'artifactSha256', 'files', 'totalBytes', 'localFileReportSha256'].includes(key))
    && /^[a-f0-9]{64}$/i.test(artifactReport.localFileReportSha256 ?? '')
    && Number.isSafeInteger(artifactReport.totalBytes) && artifactReport.totalBytes > 0
    && Array.isArray(verifiedFiles) && verifiedFiles.every((file) => isRecord(file)
      && Object.keys(file).every((key) => ['path', 'expectedSha256', 'actualSha256', 'bytes', 'verified', 'reason'].includes(key)))
  const artifactVerified = artifactReportShape && artifactReport?.passed === true
    && evidencePackage.artifactVerification?.artifactSha256 === manifest.artifactSha256
    && Array.isArray(artifactFiles) && Array.isArray(verifiedFiles)
    && verifiedFiles.length === artifactFiles.length
    && verifiedFiles.reduce((sum, file) => sum + file.bytes, 0) === artifactReport.totalBytes
    && artifactFiles.every((expected) => verifiedFiles.some((actual) => actual.path === expected.path
      && actual.expectedSha256 === expected.sha256.toLowerCase() && actual.actualSha256 === expected.sha256.toLowerCase()
      && actual.bytes === expected.bytes && actual.verified === true && actual.reason === null))
  if (!artifactVerified) blockers.push('production package lacks successful byte verification for every exact artifact file')
  return {
    passed: blockers.length === 0,
    status: blockers.length === 0 ? 'verified' : 'blocked',
    blockers: [...new Set(blockers)],
    verifications: signatureReport.verifications,
  }
}
