// Publisher signatures for plugin manifests.
//
// What this does and does not establish, stated first because the temptation to overstate
// a signature is strong:
//
//   • A valid signature means the manifest was signed by the holder of a key that was
//     already in the local trust store. It means nothing about whether the code is safe,
//     useful, or free of malice. It does not replace scopes, approval gates or the handler
//     sandbox: a signed plugin still runs with the permissions it was granted and no
//     others. The feature matrix records it that way.
//   • Trust is a local decision made by a person. This module cannot decide that a key is
//     trustworthy; it can only refuse a manifest signed by a key that is not already
//     trusted, and it never fetches a key from anywhere.
//   • What it does prevent, concretely: a manifest whose contents changed after it was
//     signed (the signed bytes no longer match), a signature moved from another plugin or
//     another version (the payload is domain-separated and includes id and version), and a
//     trust-store entry that does not match its own key id.
//
// Verification happens twice -- at install, and again before a capability runs -- because
// the record installed is an object in memory that anything in this process could mutate.
// The second check is what turns "it was signed when we installed it" into "the manifest
// the capability is running from is the one that was signed".
//
// Keys are Ed25519, from `node:crypto`. No dependency is added for this: an implementation
// of a signature scheme, or a package that wraps one, is exactly the dependency a
// zero-dependency core should not take on.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** Domain separator. A signature over one protocol must not verify in another. */
const DOMAIN = 'aetheris-plugin-manifest/v1'

export const SIGNATURE_STATE = Object.freeze({
  UNSIGNED: 'unsigned',
  VERIFIED: 'verified',
  INVALID: 'invalid',
  UNTRUSTED_KEY: 'untrusted_key',
  MALFORMED: 'malformed',
})

export class PluginSignatureError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   * @param {number} [details.status] HTTP status. Defaults to 403: a manifest this host
   *        refuses to install is a refusal, not a server fault. A malformed signature block
   *        is a bad request, and says 400.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'PluginSignatureError'
    this.code = 'plugin_signature_rejected'
    this.status = details.status ?? 403
    Object.assign(this, details)
  }
}

/**
 * A canonical JSON byte string for a value.
 *
 * The signed bytes have to be reproducible by a publisher who never runs this code, so the
 * rule is stated rather than left to `JSON.stringify`'s insertion order: object keys are
 * sorted, arrays keep their order, and anything that has no unambiguous JSON form throws
 * instead of being silently dropped. A value that silently serialises differently on two
 * machines is a signature that verifies on one and not the other.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PluginSignatureError('a manifest cannot contain a non-finite number', { code: 'manifest_not_canonical' })
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new PluginSignatureError(`cannot canonicalise '${key}': undefined has no JSON form and dropping it would change what was signed`, { code: 'manifest_not_canonical' })
      }
      out[key] = canonicalize(value[key])
    }
    return out
  }
  throw new PluginSignatureError(`cannot canonicalise a ${typeof value}: it has no JSON form`, { code: 'manifest_not_canonical' })
}

/** The exact bytes a signature covers: everything except the signature block itself. */
export function signedPayload(manifest) {
  const { signature, ...rest } = manifest ?? {}
  return `${DOMAIN}\n${canonicalJson(rest)}`
}

/** SHA-256 of the signed payload, in hex. This is what gets pinned at install. */
export function manifestDigest(manifest) {
  return createHash('sha256').update(signedPayload(manifest), 'utf8').digest('hex')
}

/** A short, stable id for a public key: the first 16 hex characters of its SHA-256. */
export function keyIdOf(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** Sign a manifest. The counterpart to `verifyManifest`, used by tests and by publishers. */
export function signManifest(manifest, privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem)
  const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  const keyId = keyIdOf(publicKeyPem)
  const signature = sign(null, Buffer.from(signedPayload(manifest), 'utf8'), privateKey).toString('base64')
  return { ...manifest, signature: { algorithm: 'ed25519', keyId, signature } }
}

/** Generate a key pair, for the tests and for a publisher setting themselves up. */
export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: keyIdOf(publicKey.export({ type: 'spki', format: 'pem' })),
  }
}

/**
 * Verify a manifest's signature against the local trust store.
 *
 * Returns a state rather than throwing, because the caller decides what to do with each
 * one: an unsigned manifest is acceptable on a host that has not asked for signatures, and
 * a manifest whose signature is *invalid* is never acceptable.
 */
export function verifyManifest(manifest, { trustStore = null } = {}) {
  const digest = manifestDigest(manifest)
  const block = manifest?.signature
  if (block === undefined || block === null) return { state: SIGNATURE_STATE.UNSIGNED, keyId: null, digest }

  if (typeof block !== 'object' || Array.isArray(block)) {
    return { state: SIGNATURE_STATE.MALFORMED, keyId: null, digest, reason: 'signature must be an object' }
  }
  if (block.algorithm !== 'ed25519') {
    return { state: SIGNATURE_STATE.MALFORMED, keyId: null, digest, reason: `unsupported algorithm '${block.algorithm}'` }
  }
  if (typeof block.keyId !== 'string' || !block.keyId) {
    return { state: SIGNATURE_STATE.MALFORMED, keyId: null, digest, reason: 'signature must name a key id' }
  }
  if (typeof block.signature !== 'string' || !block.signature) {
    return { state: SIGNATURE_STATE.MALFORMED, keyId: block.keyId, digest, reason: 'signature must carry a signature' }
  }

  const entry = trustStore?.get(block.keyId) ?? null
  if (!entry) {
    return { state: SIGNATURE_STATE.UNTRUSTED_KEY, keyId: block.keyId, digest, reason: `key '${block.keyId}' is not in the trust store` }
  }

  let ok = false
  try {
    ok = verify(null, Buffer.from(signedPayload(manifest), 'utf8'), entry.pem, Buffer.from(block.signature, 'base64'))
  } catch (error) {
    return { state: SIGNATURE_STATE.MALFORMED, keyId: block.keyId, digest, reason: `signature could not be checked: ${error.message}` }
  }
  if (!ok) return { state: SIGNATURE_STATE.INVALID, keyId: block.keyId, digest, reason: 'the signature does not match this manifest' }
  return { state: SIGNATURE_STATE.VERIFIED, keyId: block.keyId, digest }
}

/**
 * The keys this host has chosen to trust.
 *
 * A file of public keys, and nothing else: no fetching, no expiry, no revocation list. If
 * a file is not given, the store lives in memory only, which is what a test wants.
 */
export class TrustStore {
  constructor({ file = null, keys = [] } = {}) {
    this.file = file
    /** @type {Map<string, {keyId:string, pem:string, label:string, addedAt:number}>} */
    this.keys = new Map()
    for (const key of keys) this.add(key.pem, { label: key.label ?? '', at: key.addedAt ?? null })
    if (file) this.load()
  }

  /** Add a public key. The key id is derived from the key, never supplied by the caller. */
  add(pem, { label = '', at = null } = {}) {
    if (typeof pem !== 'string' || !pem.includes('PUBLIC KEY')) {
      throw new PluginSignatureError('a trusted key must be a PEM public key', { code: 'key_not_a_public_key' })
    }
    let keyId
    try {
      keyId = keyIdOf(pem)
    } catch (error) {
      throw new PluginSignatureError(`could not read that public key: ${error.message}`, { code: 'key_unreadable' })
    }
    const existing = this.keys.get(keyId)
    if (existing) return { keyId, added: false, label: existing.label }
    this.keys.set(keyId, { keyId, pem, label, addedAt: at ?? Date.now() })
    if (this.file) this.save()
    return { keyId, added: true, label }
  }

  remove(keyId) {
    const removed = this.keys.delete(keyId)
    if (removed && this.file) this.save()
    return removed
  }

  get(keyId) {
    return this.keys.get(keyId) ?? null
  }

  has(keyId) {
    return this.keys.has(keyId)
  }

  list() {
    return [...this.keys.values()].map(({ keyId, label, addedAt }) => ({ keyId, label, addedAt }))
  }

  get size() {
    return this.keys.size
  }

  save() {
    if (!this.file) return false
    // The file holds public keys and labels. A private key pasted here in error would be
    // written to disk in the clear, so it is refused rather than stored.
    for (const entry of this.keys.values()) {
      if (entry.pem.includes('PRIVATE KEY')) {
        throw new PluginSignatureError(`trust store entry '${entry.keyId}' contains a private key`, { code: 'private_key_in_trust_store' })
      }
      if (!entry.pem.includes('PUBLIC KEY')) {
        throw new PluginSignatureError(`trust store entry '${entry.keyId}' is not a public key`, { code: 'key_not_a_public_key' })
      }
    }
    const document = {
      format: 'aetheris-trust-store/v1',
      keys: [...this.keys.values()].map(({ keyId, pem, label, addedAt }) => ({ keyId, pem, label, addedAt })),
    }
    writeFileSync(this.file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    return true
  }

  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return this
      throw error
    }
    const document = JSON.parse(raw)
    if (document?.format !== 'aetheris-trust-store/v1') {
      throw new PluginSignatureError(`'${this.file}' is not an aetheris trust store`, { code: 'unrecognised_trust_store' })
    }
    for (const entry of document.keys ?? []) {
      // The stored id is ignored: it is recomputed from the key. A file whose ids do not
      // match its keys cannot be used to make a key look like another one.
      this.add(entry.pem, { label: entry.label ?? '', at: entry.addedAt ?? null })
    }
    return this
  }
}
