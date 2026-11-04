import { createHash, createPublicKey, verify } from 'node:crypto'
import { constants } from 'node:fs'
import { closeSync, lstatSync, openSync, readFileSync } from 'node:fs'

const ALLOWED_PURPOSES = new Set([
  'foundation_license_review',
  'dataset_provenance_review',
  'dataset_artifact_integrity',
  'training_run',
  'held_out_evaluation',
  'tier_release_qualification',
  'artifact_integrity',
  'release_manifest',
  'klyvaron_release_evidence',
  'klyvaron_deployment_verification',
  'klyvaron_independent_review',
  'klyvaron_release_decision',
])
const DATASET_SCOPED_PURPOSES = new Set(['dataset_provenance_review', 'dataset_artifact_integrity'])
const PRODUCTION_ROLES = new Set(['release_evidence_custodian', 'deployment_verifier', 'independent_reviewer', 'release_approver'])
const PRODUCTION_ROLE_BY_PURPOSE = Object.freeze({
  klyvaron_release_evidence: 'release_evidence_custodian',
  klyvaron_deployment_verification: 'deployment_verifier',
  klyvaron_independent_review: 'independent_reviewer',
  klyvaron_release_decision: 'release_approver',
})
const ATTESTATION_DOMAIN = 'klyvaron-evidence-attestation/v1'
const SHA256 = /^[a-f0-9]{64}$/i
const PEM_PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----/
const SIGNATURE_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) throw new TypeError('signed evidence must contain JSON-compatible values only')
  const output = {}
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`signed evidence key '${key}' has no JSON representation`)
    output[key] = canonicalize(value[key])
  }
  return output
}

export function canonicalKlyvaronEvidenceJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function klyvaronEvidenceKeyId(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || !PEM_PUBLIC_KEY.test(publicKeyPem) || publicKeyPem.includes('PRIVATE KEY')) {
    throw new TypeError('evidence trust requires a PEM public key only')
  }
  const key = createPublicKey(publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError('evidence trust keys must use Ed25519')
  const der = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex')
}

export function klyvaronEvidenceAttestationPayload({
  purpose, modelId, evidenceSha256, datasetId, datasetVersion, provenanceManifestSha256,
}) {
  if (!ALLOWED_PURPOSES.has(purpose)) throw new TypeError(`unsupported Klyvaron evidence purpose '${purpose}'`)
  if (typeof modelId !== 'string' || !modelId || typeof evidenceSha256 !== 'string' || !SHA256.test(evidenceSha256)) {
    throw new TypeError('evidence attestations require a model id and SHA-256 digest')
  }
  const datasetScopeProvided = [datasetId, datasetVersion, provenanceManifestSha256].some((value) => value !== undefined)
  if (DATASET_SCOPED_PURPOSES.has(purpose)) {
    if (typeof datasetId !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,95}$/i.test(datasetId)
      || typeof datasetVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(datasetVersion)
      || typeof provenanceManifestSha256 !== 'string' || !SHA256.test(provenanceManifestSha256)) {
      throw new TypeError('dataset attestations require dataset id, version and provenance manifest digest')
    }
  } else if (datasetScopeProvided) {
    throw new TypeError('dataset scope is accepted only for dataset evidence attestations')
  }
  return {
    schema: 'klyvaron.evidence-attestation.v1',
    purpose,
    modelId,
    evidenceSha256: evidenceSha256.toLowerCase(),
    ...(DATASET_SCOPED_PURPOSES.has(purpose) ? {
      dataset: {
        id: datasetId,
        version: datasetVersion,
        provenanceManifestSha256: provenanceManifestSha256.toLowerCase(),
      },
    } : {}),
  }
}

/**
 * Installation-local public trust anchors for scoped Klyvaron evidence signatures.
 * Private keys are refused and are never generated, loaded or persisted here. An empty
 * store deliberately verifies nothing; a person must provision each public key and its
 * narrow allowed-purpose set outside the browser.
 */
export class KlyvaronEvidenceTrustStore {
  #keys = new Map()
  #supersededManifestDigests = new Set()

  constructor({ keys = [], supersededEvidenceManifestSha256 = [] } = {}) {
    if (!Array.isArray(keys) || keys.length > 128) throw new TypeError('Klyvaron evidence trust keys must be an array of at most 128 entries')
    if (!Array.isArray(supersededEvidenceManifestSha256)
      || supersededEvidenceManifestSha256.some((digest) => typeof digest !== 'string' || !SHA256.test(digest))
      || new Set(supersededEvidenceManifestSha256.map((digest) => digest.toLowerCase())).size !== supersededEvidenceManifestSha256.length) {
      throw new TypeError('superseded evidence manifest entries must be unique SHA-256 digests')
    }
    this.#supersededManifestDigests = new Set(supersededEvidenceManifestSha256.map((digest) => digest.toLowerCase()))
    for (const entry of keys) {
      if (!isRecord(entry) || Object.keys(entry).some((key) => !['keyId', 'publicKeyPem', 'label', 'purposes', 'principalId', 'roles'].includes(key))) {
        throw new TypeError('each Klyvaron evidence trust entry must contain only public-key fields')
      }
      const keyId = klyvaronEvidenceKeyId(entry.publicKeyPem)
      if (entry.keyId !== undefined && entry.keyId !== keyId) throw new TypeError('evidence trust key id does not match its public key')
      if (typeof entry.label !== 'string' || (entry.label && !/^[a-z0-9][a-z0-9 ._:/-]{0,159}$/i.test(entry.label))) throw new TypeError('evidence trust key label must be a short non-sensitive label')
      if (!Array.isArray(entry.purposes) || entry.purposes.length === 0
        || entry.purposes.some((purpose) => !ALLOWED_PURPOSES.has(purpose))
        || new Set(entry.purposes).size !== entry.purposes.length) {
        throw new TypeError('evidence trust keys require a non-empty, unique allowlist of known purposes')
      }
      const productionPurposes = entry.purposes.filter((purpose) => PRODUCTION_ROLE_BY_PURPOSE[purpose])
      if (productionPurposes.length) {
        if (typeof entry.principalId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(entry.principalId)
          || !Array.isArray(entry.roles) || entry.roles.some((role) => !PRODUCTION_ROLES.has(role))
          || new Set(entry.roles).size !== entry.roles.length
          || productionPurposes.some((purpose) => !entry.roles.includes(PRODUCTION_ROLE_BY_PURPOSE[purpose]))) {
          throw new TypeError('production evidence trust keys require a principal id and matching production role allowlist')
        }
      } else if (entry.roles !== undefined && (!Array.isArray(entry.roles)
        || entry.roles.some((role) => !PRODUCTION_ROLES.has(role)) || new Set(entry.roles).size !== entry.roles.length)) {
        throw new TypeError('evidence trust roles must be an array of role identifiers')
      }
      if (this.#keys.has(keyId)) throw new TypeError(`duplicate Klyvaron evidence key '${keyId}'`)
      this.#keys.set(keyId, Object.freeze({
        keyId,
        publicKeyPem: entry.publicKeyPem,
        label: entry.label,
        purposes: Object.freeze([...entry.purposes]),
        principalId: entry.principalId ?? null,
        roles: Object.freeze([...(entry.roles ?? [])]),
      }))
    }
  }

  get size() { return this.#keys.size }

  isSupersededEvidenceManifest(digest) {
    return typeof digest === 'string' && this.#supersededManifestDigests.has(digest.toLowerCase())
  }

  list() {
    return [...this.#keys.values()].map(({ keyId, label, purposes }) => ({ keyId, label, purposes: [...purposes] }))
  }

  verify(payload, attestation, { purpose } = {}) {
    if (!isRecord(payload) || !isRecord(attestation)
      || Object.keys(attestation).some((key) => !['algorithm', 'keyId', 'purpose', 'signature'].includes(key))
      || attestation.algorithm !== 'ed25519'
      || typeof attestation.keyId !== 'string' || !/^[a-f0-9]{64}$/i.test(attestation.keyId)
      || typeof attestation.signature !== 'string' || !SIGNATURE_B64.test(attestation.signature)
      || Buffer.from(attestation.signature, 'base64').length !== 64
      || Buffer.from(attestation.signature, 'base64').toString('base64') !== attestation.signature
      || !ALLOWED_PURPOSES.has(purpose)
      || attestation.purpose !== purpose
      || payload.purpose !== purpose
      || payload.schema !== 'klyvaron.evidence-attestation.v1') {
      return { status: 'blocked', keyId: attestation?.keyId ?? null, reason: 'malformed or cross-purpose evidence attestation' }
    }
    const trusted = this.#keys.get(attestation.keyId)
    if (!trusted) return { status: 'blocked', keyId: attestation.keyId, reason: 'evidence signing key is not trusted' }
    if (!trusted.purposes.includes(purpose)) {
      return { status: 'blocked', keyId: attestation.keyId, reason: 'trusted key is not authorized for this evidence purpose' }
    }
    let valid = false
    try {
      const signedBytes = `${ATTESTATION_DOMAIN}\n${canonicalKlyvaronEvidenceJson(payload)}`
      valid = verify(null, Buffer.from(signedBytes, 'utf8'), trusted.publicKeyPem, Buffer.from(attestation.signature, 'base64'))
    } catch {
      return { status: 'blocked', keyId: attestation.keyId, reason: 'evidence signature could not be verified' }
    }
    return valid
      ? { status: 'verified', keyId: attestation.keyId, purpose, principalId: trusted.principalId, roles: [...trusted.roles] }
      : { status: 'blocked', keyId: attestation.keyId, reason: 'evidence signature does not match the payload' }
  }
}

/** Load public trust anchors from an operator-managed local JSON file; missing means empty. */
export function loadKlyvaronEvidenceTrustStore(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('a local evidence trust-file path is required')
  let info
  try { info = lstatSync(filePath) } catch (error) {
    if (error.code === 'ENOENT') return new KlyvaronEvidenceTrustStore()
    throw new Error(`Klyvaron evidence trust file cannot be inspected (${error.code ?? 'io_error'})`)
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > 256 * 1024) {
    throw new Error('Klyvaron evidence trust file must be a small regular non-symlink file')
  }
  const noFollow = constants.O_NOFOLLOW ?? 0
  let document
  try {
    const descriptor = openSync(filePath, constants.O_RDONLY | noFollow)
    try { document = JSON.parse(readFileSync(descriptor, 'utf8')) } finally { closeSync(descriptor) }
  } catch (error) {
    throw new Error(`Klyvaron evidence trust file is unreadable or invalid (${error.code ?? 'invalid_json'})`)
  }
  if (!isRecord(document) || document.format !== 'klyvaron-evidence-trust/v1'
    || Object.keys(document).some((key) => !['format', 'keys', 'supersededEvidenceManifestSha256'].includes(key))
    || !Array.isArray(document.keys)
    || (document.supersededEvidenceManifestSha256 !== undefined && !Array.isArray(document.supersededEvidenceManifestSha256))) {
    throw new Error('Klyvaron evidence trust file has an unsupported schema')
  }
  return new KlyvaronEvidenceTrustStore({
    keys: document.keys,
    supersededEvidenceManifestSha256: document.supersededEvidenceManifestSha256 ?? [],
  })
}
