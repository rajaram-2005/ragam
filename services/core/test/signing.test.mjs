// Publisher signatures: what they establish and what they refuse.
//
// The point of this file is the negative cases. "A correctly signed manifest installs" is
// the feature working as documented; "a manifest edited after it was signed does not run"
// is the property that makes the signature worth anything. Every test below except the
// first is a refusal.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOLS, SCOPES } from '../src/plugins/manifest.mjs'
import { PluginRegistry } from '../src/plugins/registry.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'
import {
  PluginSignatureError, SIGNATURE_STATE, TrustStore, canonicalJson, generateKeyPair,
  keyIdOf, manifestDigest, signManifest, verifyManifest,
} from '../src/plugins/signing.mjs'

function manifest(overrides = {}) {
  return {
    id: 'acme.repo-inspector',
    name: 'Repository Inspector',
    version: '1.0.0',
    protocol: PROTOCOLS.LOCAL_TOOL,
    description: 'Reads repository metadata.',
    scopes: [SCOPES.FS_READ],
    capabilities: [
      {
        name: 'summarize',
        description: 'Summarise a repository path.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
        requiredScopes: [SCOPES.FS_READ],
        readOnly: true,
      },
    ],
    ...overrides,
  }
}

const publisher = generateKeyPair()
const stranger = generateKeyPair()
const trusted = () => new TrustStore({ keys: [{ pem: publisher.publicKeyPem, label: 'Acme' }] })
const registry = (options = {}) => new PluginRegistry({ trustStore: trusted(), ...options })

// --- the property the feature exists for --------------------------------------------

test('a manifest signed by a trusted key installs and reports the key that signed it', () => {
  const plugins = registry({ requireSignature: true })
  const signed = signManifest(manifest(), publisher.privateKeyPem)
  const installed = plugins.install(signed)

  assert.equal(installed.signature.state, SIGNATURE_STATE.VERIFIED)
  assert.equal(installed.signature.keyId, publisher.keyId)
  // The digest is of the signed bytes, and it is recorded so a later change is visible.
  assert.equal(installed.signature.digest, manifestDigest(signed))
})

test('the signature survives a round trip through a JSON formatter', () => {
  // Key order is normalised before signing, so reformatting, reordering or pretty-printing
  // a manifest does not break its signature. A scheme that depended on insertion order
  // would fail here and the publisher would have no way to know why.
  const signed = signManifest(manifest(), publisher.privateKeyPem)
  const reformatted = JSON.parse(JSON.stringify({
    capabilities: signed.capabilities,
    signature: { signature: signed.signature.signature, keyId: signed.signature.keyId, algorithm: signed.signature.algorithm },
    scopes: signed.scopes,
    description: signed.description,
    protocol: signed.protocol,
    version: signed.version,
    name: signed.name,
    id: signed.id,
  }))
  assert.equal(verifyManifest(reformatted, { trustStore: trusted() }).state, SIGNATURE_STATE.VERIFIED)
})

// --- refusals -----------------------------------------------------------------------

test('a manifest changed after it was signed is refused', () => {
  const signed = signManifest(manifest(), publisher.privateKeyPem)
  const tampered = { ...signed, scopes: [SCOPES.FS_READ, SCOPES.NETWORK_EXTERNAL] }
  const result = verifyManifest(tampered, { trustStore: trusted() })
  assert.equal(result.state, SIGNATURE_STATE.INVALID)
  assert.throws(() => registry({ requireSignature: true }).install(tampered), PluginSignatureError)
})

test('a signature moved from another plugin or version is refused', () => {
  // The payload is domain-separated and carries the identity, so a genuine signature is
  // not transferable to a different plugin or a different version of the same one.
  const signed = signManifest(manifest(), publisher.privateKeyPem)
  for (const changed of [{ id: 'acme.other-plugin' }, { version: '2.0.0' }]) {
    const moved = { ...signed, ...changed }
    assert.equal(verifyManifest(moved, { trustStore: trusted() }).state, SIGNATURE_STATE.INVALID,
      `a signature must not verify after changing ${Object.keys(changed)[0]}`)
  }
})

test('a signature from an untrusted key is refused even when signatures are optional', () => {
  const signed = signManifest(manifest(), stranger.privateKeyPem)
  const result = verifyManifest(signed, { trustStore: trusted() })
  assert.equal(result.state, SIGNATURE_STATE.UNTRUSTED_KEY)

  // "Unsigned is acceptable here" is not "any signature is acceptable here": presenting a
  // signature claims a publisher, and an unverifiable claim is not the same as no claim.
  assert.throws(() => registry().install(signed), PluginSignatureError)
})

test('an unsigned manifest installs only while signatures are not required', () => {
  const installed = registry().install(manifest())
  assert.equal(installed.signature.state, SIGNATURE_STATE.UNSIGNED)
  assert.equal(installed.signature.keyId, null)

  const strict = registry({ requireSignature: true })
  assert.throws(() => strict.install(manifest()), PluginSignatureError)
  // And nothing is left behind by the refusal.
  assert.equal(strict.list().length, 0)
})

test('a malformed signature block is refused rather than treated as absent', () => {
  const cases = {
    'not an object': 'signed-by-acme',
    'an unknown algorithm': { algorithm: 'rsa-sha1', keyId: publisher.keyId, signature: 'AAAA' },
    'no key id': { algorithm: 'ed25519', keyId: '', signature: 'AAAA' },
    'no signature': { algorithm: 'ed25519', keyId: publisher.keyId, signature: '' },
  }
  for (const [label, signature] of Object.entries(cases)) {
    const result = verifyManifest({ ...manifest(), signature }, { trustStore: trusted() })
    assert.equal(result.state, SIGNATURE_STATE.MALFORMED, `${label} must be malformed`)
    assert.ok(result.reason, `${label} must explain itself`)
  }
})

test('a refusal is audited, so a rejected install is visible afterwards', () => {
  const ledger = new AuditLedger()
  const plugins = registry({ ledger, requireSignature: true })
  assert.throws(() => plugins.install(manifest()), PluginSignatureError)
  const entries = ledger.query({ category: 'plugin' }).filter((entry) => entry.action === 'install')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].outcome, 'denied')
  // detail is stored as JSON and parsed on read.
  assert.equal(entries[0].detail.reason, 'signature')
})

test('a manifest edited in memory after install does not run', () => {
  // The installed record is an object in this process. "It was signed when we installed
  // it" is a weaker statement than "the manifest this capability is running from is the
  // one that was signed", so the check happens again before every invocation.
  const plugins = registry({ requireSignature: true })
  const installed = plugins.install(signManifest(manifest(), publisher.privateKeyPem))
  plugins.bindHandlers(installed.id, () => ({ ok: true }))

  // The scope a capability requires is read from the normalised copy. Granting the plugin
  // a scope it was never signed for is the attack this catches.
  plugins.require(installed.id).manifest.scopes.push(SCOPES.NETWORK_EXTERNAL)

  return plugins.invoke(installed.id, 'summarize', { path: '/tmp' }).then(
    () => assert.fail('a capability must not run from a manifest that changed after signing'),
    (error) => {
      assert.equal(error.code, 'plugin_signature_rejected')
      assert.equal(error.pluginId, installed.id)
      // The signed bytes are untouched -- what changed is the manifest the capability would
      // have read its required scopes from. The refusal says which of the two was caught.
      assert.equal(error.check, 'behaviour')
      assert.equal(error.currentDigest, error.installedDigest)
    },
  )
})

test('replacing the signed bytes after install is caught as a signature failure', () => {
  const plugins = registry({ requireSignature: true })
  const installed = plugins.install(signManifest(manifest(), publisher.privateKeyPem))
  plugins.bindHandlers(installed.id, () => ({ ok: true }))

  // This is the same attack from the other side: rewrite the copy that carries the
  // signature. It no longer verifies, and the check says so rather than reporting a digest
  // mismatch, because the two are different incidents.
  plugins.require(installed.id).signedManifest.description = 'not what was signed'
  return plugins.invoke(installed.id, 'summarize', { path: '/tmp' }).then(
    () => assert.fail('edited bytes must not verify'),
    (error) => {
      assert.equal(error.code, 'plugin_signature_rejected')
      assert.equal(error.check, 'signature')
    },
  )
})

test('an unsigned plugin is still checked against the bytes that were installed', () => {
  const plugins = registry()
  const installed = plugins.install(manifest())
  plugins.bindHandlers(installed.id, () => ({ ok: true }))
  // The behaviour is read from the normalised copy, and the digest is of what was
  // presented; the two are compared before a capability runs either way.
  plugins.require(installed.id).manifest.capabilities[0].description = 'something else entirely'
  return plugins.invoke(installed.id, 'summarize', { path: '/tmp' }).then(
    () => assert.fail('the behaviour check is not conditional on there being a signature'),
    (error) => assert.equal(error.code, 'plugin_signature_rejected'),
  )
})

// --- canonical form and the trust store ----------------------------------------------

test('the canonical form refuses values it cannot represent unambiguously', () => {
  // A silent drop is a signature over something other than what the signer saw.
  assert.throws(() => canonicalJson({ a: undefined }), /undefined has no JSON form/)
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/)
  assert.throws(() => canonicalJson({ a: () => {} }), /no JSON form/)
  assert.throws(() => canonicalJson({ a: 1n }), /no JSON form/)
  // And key order is not part of what is signed.
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }))
})

test('the trust store derives key ids and refuses to hold a private key', () => {
  assert.equal(keyIdOf(publisher.publicKeyPem), publisher.keyId)
  const store = new TrustStore()
  assert.throws(() => store.add(publisher.privateKeyPem), /PEM public key/)
  assert.throws(() => store.add('not a key'), /PEM public key/)

  const dir = mkdtempSync(join(tmpdir(), 'aetheris-trust-'))
  try {
    const file = join(dir, 'trusted-keys.json')
    const written = new TrustStore({ file })
    written.add(publisher.publicKeyPem, { label: 'Acme' })
    written.add(stranger.publicKeyPem, { label: 'Someone else' })

    // Adding the same key twice is idempotent, and the id is never taken from the caller.
    assert.deepEqual(written.add(publisher.publicKeyPem).added, false)

    const reloaded = new TrustStore({ file })
    assert.equal(reloaded.size, 2)
    assert.equal(reloaded.get(publisher.keyId).label, 'Acme')

    // A file whose stored ids do not match its keys cannot make a key look like another:
    // the id is recomputed on load, and the mismatched entry lands under its real id.
    const document = JSON.parse(readFileSync(file, 'utf8'))
    document.keys[0].keyId = 'forged-key-id'
    writeFileSync(file, JSON.stringify(document))
    const corrected = new TrustStore({ file })
    assert.equal(corrected.get('forged-key-id'), null)
    assert.ok(corrected.get(publisher.keyId), 'the key is stored under the id derived from it')
    // Verification never consults the claimed id: a signature naming 'forged-key-id' is
    // untrusted, and the same signature naming the real id verifies.
    const signed = signManifest(manifest(), publisher.privateKeyPem)
    assert.equal(verifyManifest({ ...signed, signature: { ...signed.signature, keyId: 'forged-key-id' } }, { trustStore: corrected }).state,
      SIGNATURE_STATE.UNTRUSTED_KEY)
    assert.equal(verifyManifest(signed, { trustStore: corrected }).state, SIGNATURE_STATE.VERIFIED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discover reports the signature before anything is installed', () => {
  const plugins = registry({ requireSignature: true })
  const unsigned = plugins.discover(manifest())
  assert.equal(unsigned.signature.state, SIGNATURE_STATE.UNSIGNED)
  assert.equal(unsigned.signature.accepted, false)
  assert.equal(unsigned.signatureRequired, true)

  const signed = plugins.discover(signManifest(manifest(), publisher.privateKeyPem))
  assert.equal(signed.signature.state, SIGNATURE_STATE.VERIFIED)
  assert.equal(signed.signature.accepted, true)
  assert.equal(plugins.list().length, 0, 'discovery installs nothing')
})
