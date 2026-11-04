import { createHash } from 'node:crypto'

const SHA256 = /^[a-f0-9]{64}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DATASET_SOURCE_CLASSES = new Set(['first_party_authored', 'public_domain', 'licensed_content', 'synthetic'])
const DATASET_SPLITS = ['train', 'validation', 'heldOut', 'outOfDomain']
const FOUNDATION_KEYS = new Set(['id', 'publisher', 'name', 'revision', 'revisionDigest', 'sourceUrl', 'license', 'licenseReview'])
const DATASET_KEYS = new Set(['id', 'version', 'createdAt', 'entries', 'splits', 'privacyReview', 'deduplication', 'manifestSha256'])
const ENTRY_KEYS = new Set(['recordId', 'sourceClass', 'sourceRef', 'sourceUrl', 'license'])
const LICENSE_KEYS = new Set(['id', 'sourceUrl', 'textSha256', 'review'])
const REVIEW_KEYS = new Set(['status', 'reviewer', 'reviewedAt', 'reportSha256', 'rights'])
const RIGHTS_KEYS = new Set(['fineTuningAllowed', 'commercialUseAllowed', 'derivativeWeightDistributionAllowed', 'redistributionAllowed', 'attributionSatisfied', 'acceptableUseReviewed'])

function isSha256(value) { return typeof value === 'string' && SHA256.test(value) }
function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
function isHttpsUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
function isReviewerId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
}
function isOpaqueSourceRef(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:/#-]{0,255}$/i.test(value)
}
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hasOnlyKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.has(key))
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) throw new TypeError('provenance records must contain JSON-compatible values only')
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]))
}

export function canonicalProvenanceSha256(value) {
  const canonical = JSON.stringify(canonicalValue(value))
  return createHash('sha256').update(canonical).digest('hex')
}

function reviewRecordPasses(review, rightsKeys) {
  return isRecord(review)
    && review.status === 'approved'
    && isReviewerId(review.reviewer)
    && isIsoDate(review.reviewedAt)
    && isSha256(review.reportSha256)
    && isRecord(review.rights)
    && Object.keys(review.rights).length === rightsKeys.length
    && rightsKeys.every((key) => review.rights[key] === true)
    && Object.keys(review.rights).every((key) => rightsKeys.includes(key))
}

/**
 * Validate a human-supplied foundation provenance and license-review record. This verifies
 * record completeness and pinning only; it does not fetch a model/license or give legal advice.
 * No review is ever promoted from pending to approved by this function.
 */
export function validateFoundationProvenance(input) {
  const license = input?.license
  const review = input?.licenseReview
  const foundationIdentityPinned = Boolean(
    hasOnlyKeys(input, FOUNDATION_KEYS)
    && typeof input.id === 'string' && input.id.trim()
    && typeof input.publisher === 'string' && input.publisher.trim()
    && typeof input.name === 'string' && input.name.trim()
    && typeof input.revision === 'string' && input.revision.trim()
    && isSha256(input.revisionDigest)
    && isHttpsUrl(input.sourceUrl),
  )
  const licenseDocumentPinned = Boolean(
    hasOnlyKeys(license, LICENSE_KEYS)
    && typeof license.id === 'string' && license.id.trim()
    && isHttpsUrl(license.sourceUrl)
    && isSha256(license.textSha256),
  )
  const licenseReviewRecorded = Boolean(
    hasOnlyKeys(review, REVIEW_KEYS)
    && isReviewerId(review.reviewer)
    && isIsoDate(review.reviewedAt)
    && isSha256(review.reportSha256),
  )
  const rightsExplicitAndApproved = reviewRecordPasses(review, [...RIGHTS_KEYS])
  const gates = {
    foundationIdentityPinned,
    licenseDocumentPinned,
    licenseReviewRecorded,
    rightsExplicitAndApproved,
  }
  const passed = Object.values(gates).every(Boolean)
  const sourceRecord = {
    schema: 'klyvaron.foundation-provenance.v1',
    input: isRecord(input) ? input : null,
  }
  let reportSha256 = null
  try { reportSha256 = canonicalProvenanceSha256(sourceRecord) } catch { /* malformed inputs have a null digest */ }
  const status = passed ? 'passed' : 'blocked'
  const evidence = passed ? {
    id: input.id,
    publisher: input.publisher,
    name: input.name,
    revision: input.revision,
    revisionDigest: input.revisionDigest.toLowerCase(),
    sourceUrl: input.sourceUrl,
    license: license.id,
    licenseSourceUrl: license.sourceUrl,
    licenseDocumentSha256: license.textSha256.toLowerCase(),
    licenseReviewStatus: review.status,
    licenseReviewReportSha256: review.reportSha256.toLowerCase(),
    rightsReview: { ...review.rights },
    provenanceValidation: { status, reportSha256, gates },
  } : null
  return {
    status,
    passed,
    reportSha256,
    gates,
    blockers: Object.entries(gates).filter(([, value]) => !value).map(([name]) => name),
    evidence,
  }
}

function validDatasetLicense(license) {
  return hasOnlyKeys(license, LICENSE_KEYS)
    && typeof license.id === 'string' && license.id.trim()
    && isHttpsUrl(license.sourceUrl)
    && isSha256(license.textSha256)
    && reviewRecordPasses(license.review, [...RIGHTS_KEYS])
}

function validReviewSummary(review) {
  return isRecord(review)
    && review.status === 'passed'
    && isReviewerId(review.reviewer)
    && isIsoDate(review.reviewedAt)
    && isSha256(review.reportSha256)
}

/**
 * Validate a metadata-only, versioned training-data manifest. Sample IDs must be SHA-256
 * digests (not raw text), user chat/private-data sources are excluded, and the four split
 * manifests must be non-empty, complete and disjoint. The function never reads dataset bytes.
 */
export function validateKlyvaronDatasetManifest(input) {
  const schemaPinned = hasOnlyKeys(input, DATASET_KEYS)
    && typeof input.id === 'string' && /^[a-z0-9][a-z0-9._-]{1,95}$/i.test(input.id)
    && typeof input.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(input.version)
    && isIsoDate(input.createdAt)
  const entries = Array.isArray(input?.entries) ? input.entries : []
  const entryIds = entries.map((entry) => entry?.recordId)
  const entryRecordsValid = entries.length > 0 && entries.every((entry) =>
    hasOnlyKeys(entry, ENTRY_KEYS)
    && isSha256(entry.recordId)
    && DATASET_SOURCE_CLASSES.has(entry.sourceClass)
    && isOpaqueSourceRef(entry.sourceRef)
    && (entry.sourceUrl === undefined || isHttpsUrl(entry.sourceUrl))
    && validDatasetLicense(entry.license))
    && new Set(entryIds).size === entryIds.length
  const splits = isRecord(input?.splits) ? input.splits : {}
  const splitsCompleteAndDisjoint = DATASET_SPLITS.every((name) =>
    Array.isArray(splits[name]) && splits[name].length > 0 && splits[name].every(isSha256))
    && Object.keys(splits).length === DATASET_SPLITS.length
    && DATASET_SPLITS.every((name) => Object.hasOwn(splits, name))
    && DATASET_SPLITS.every((name) => new Set(splits[name]).size === splits[name].length)
    && (() => {
      const all = DATASET_SPLITS.flatMap((name) => splits[name] ?? [])
      return new Set(all).size === all.length
        && all.length === entryIds.length
        && all.every((id) => entryIds.includes(id))
    })()
  const privacyReviewPassed = validReviewSummary(input?.privacyReview)
  const deduplicationPassed = validReviewSummary(input?.deduplication)
    && typeof input.deduplication.method === 'string' && input.deduplication.method.trim().length > 0
  const gates = {
    metadataOnlyVersionedManifest: schemaPinned,
    perRecordLicenseAndRightsReviewed: entryRecordsValid,
    trainValidationHeldOutAndOutOfDomainSplitsDisjoint: splitsCompleteAndDisjoint,
    privacyReviewPassed,
    deduplicationReviewPassed: deduplicationPassed,
  }
  const passed = Object.values(gates).every(Boolean)
  const manifestBody = isRecord(input) ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'manifestSha256')) : null
  let manifestSha256 = null
  try { manifestSha256 = canonicalProvenanceSha256(manifestBody) } catch { /* malformed inputs have a null digest */ }
  const declaredDigestValid = input?.manifestSha256 === undefined || input.manifestSha256 === manifestSha256
  gates.declaredManifestDigestMatches = declaredDigestValid
  const ready = passed && declaredDigestValid
  const reportSha256 = canonicalProvenanceSha256({ schema: 'klyvaron.dataset-validation.v1', manifestSha256, gates })
  const evidence = ready ? {
    id: input.id,
    version: input.version,
    license: 'per-record-reviewed',
    provenanceManifestSha256: manifestSha256,
    provenanceValidation: { status: 'passed', reportSha256 },
    privacyReviewStatus: input.privacyReview.status,
    privacyReviewReportSha256: input.privacyReview.reportSha256.toLowerCase(),
    deduplicationStatus: input.deduplication.status,
    deduplicationReportSha256: input.deduplication.reportSha256.toLowerCase(),
  } : null
  return {
    status: ready ? 'passed' : 'blocked',
    passed: ready,
    manifestSha256,
    reportSha256,
    gates,
    blockers: Object.entries(gates).filter(([, value]) => !value).map(([name]) => name),
    evidence,
  }
}
