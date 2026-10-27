// Release pins: an artifact that claims the released version must be the
// released bytes.
//
// The loaders verify each weights file against the hash inside its own
// manifest. That is self-referential: replace both files consistently and
// the check passes. These tests pin the other half of the contract — the
// digests recorded in source at release time — and prove that a
// self-consistent forgery is refused while a locally retrained artifact
// (distinct version) is not the pin's business.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KLYVARON_RELEASE_PINS, releasePinViolation } from '../src/klyvaron/release-pins.mjs'
import { NativeMultimodalHost } from '../src/klyvaron/multimodal-host.mjs'
import { NativeKlyvaronHost } from '../src/online/native-klyvaron.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const INSTALLED = join(REPO_ROOT, '.aetheris-data', 'online', 'klyvaron', 'models')
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

test('every pin names a published model card for the same release', () => {
  assert.equal(Object.keys(KLYVARON_RELEASE_PINS).length, 8)
  for (const [id, pin] of Object.entries(KLYVARON_RELEASE_PINS)) {
    const cardPath = join(REPO_ROOT, 'docs', 'model-cards', `${id}-${pin.version}.json`)
    assert.ok(existsSync(cardPath), `${id} has a published model card at ${cardPath}`)
    const card = JSON.parse(readFileSync(cardPath, 'utf8')).card
    assert.equal(card.identifier, `${id}@${pin.version}`)
    assert.match(pin.weightsSha256, /^[0-9a-f]{64}$/)
    if (pin.processorSha256) assert.match(pin.processorSha256, /^[0-9a-f]{64}$/)
  }
})

test('the predicate binds only artifacts that claim the pinned release version', () => {
  const pin = KLYVARON_RELEASE_PINS['klyvaron-pro-lm']
  const exact = { id: 'klyvaron-pro-lm', version: pin.version, weightsFile: pin.weightsFile, weightsSha256: pin.weightsSha256 }
  assert.equal(releasePinViolation(exact), null)
  // No pin for an unreleased identity.
  assert.equal(releasePinViolation({ ...exact, id: 'klyvaron-mini-lm', weightsSha256: 'f'.repeat(64) }), null)
  // A local retrain carries a distinct version and is judged by the ordinary
  // gates, not the pin — even though its weights naturally differ.
  assert.equal(releasePinViolation({ ...exact, version: '0.1.0-local.ab12cd34', weightsSha256: 'f'.repeat(64) }), null)
  // Claiming the release with different bytes is the forgery the pin exists for.
  assert.match(releasePinViolation({ ...exact, weightsSha256: 'f'.repeat(64) }), /released pin/)
  assert.match(releasePinViolation({ ...exact, weightsFile: 'weights.npz' }), /must ship weights file/)
  const imagePin = KLYVARON_RELEASE_PINS['klyvaron-pro-image']
  assert.match(releasePinViolation({
    id: 'klyvaron-pro-image',
    version: imagePin.version,
    weightsFile: imagePin.weightsFile,
    weightsSha256: imagePin.weightsSha256,
    processorFile: imagePin.processorFile,
    processorSha256: 'f'.repeat(64),
  }), /processor SHA-256/)
})

test('installed release artifacts match their pins byte for byte', (t) => {
  if (!existsSync(INSTALLED)) return t.skip('first-party weights are not installed on this host')
  for (const [id, pin] of Object.entries(KLYVARON_RELEASE_PINS)) {
    const dir = join(INSTALLED, id)
    if (!existsSync(dir)) return t.skip(`${id} is not installed on this host`)
    assert.equal(releasePinViolation({
      id,
      version: pin.version,
      weightsFile: pin.weightsFile,
      weightsSha256: sha256File(join(dir, pin.weightsFile)),
      processorFile: pin.processorFile ?? null,
      processorSha256: pin.processorFile ? sha256File(join(dir, pin.processorFile)) : null,
    }), null, `${id} on disk is the pinned release`)
  }
})

test('a self-consistent multimodal forgery is refused by the pin; a relabelled local build is judged by the ordinary gates', (t) => {
  const source = join(INSTALLED, 'klyvaron-pro-image')
  if (!existsSync(source)) return t.skip('klyvaron-pro-image is not installed on this host')
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-pin-mm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'klyvaron-pro-image')
  cpSync(source, dir, { recursive: true })

  // Forge: change the weights, then update the manifest so the package
  // agrees with itself — exactly what the old self-referential check passed.
  const weightsPath = join(dir, 'weights.npz')
  const forged = readFileSync(weightsPath)
  forged[forged.length - 32] ^= 0xff
  writeFileSync(weightsPath, forged)
  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.weights.sha256 = sha256File(weightsPath)
  writeFileSync(manifestPath, JSON.stringify(manifest))

  let host = new NativeMultimodalHost({ modelsRoot: root })
  let record = host.records.get('klyvaron-pro-image')
  assert.equal(record.verified, false)
  assert.match(record.reason, /released pin/)

  // The same bytes under a local-retrain version are not impersonating the
  // release: the pin steps aside and the ordinary manifest/architecture
  // gates decide (they pass — only the version string changed).
  manifest.version = '0.1.0-local.test0001'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  host = new NativeMultimodalHost({ modelsRoot: root })
  record = host.records.get('klyvaron-pro-image')
  assert.equal(record.verified, true)
  assert.equal(record.version, '0.1.0-local.test0001')
})

test('a self-consistent LM forgery at the released version is refused by the pin', async (t) => {
  const source = join(INSTALLED, 'klyvaron-pro-lm')
  if (!existsSync(source)) return t.skip('klyvaron-pro-lm is not installed on this host')
  const python = process.env.AETHERIS_PYTHON || 'python3'
  const probe = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' })
  if (probe.status !== 0) return t.skip(`no NumPy-capable Python at '${python}' to rebuild the NPZ container`)

  const root = mkdtempSync(join(tmpdir(), 'klyvaron-pin-lm-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'models', 'klyvaron-pro-lm')
  cpSync(source, dir, { recursive: true })

  // Re-zip the identical tensors into a new container and update the sidecar
  // manifest to match: every self-referential check (file hash, byte count,
  // tokenizer digest, tensor shapes, live inference) passes on the result.
  const pin = KLYVARON_RELEASE_PINS['klyvaron-pro-lm']
  const weightsPath = join(dir, pin.weightsFile)
  const rewrite = spawnSync(python, ['-c', `
import numpy as np, sys
data = dict(np.load(sys.argv[1]))
np.savez(sys.argv[1], **data)
`, weightsPath], { encoding: 'utf8' })
  assert.equal(rewrite.status, 0, rewrite.stderr)
  assert.notEqual(sha256File(weightsPath), pin.weightsSha256, 'the re-zipped container really differs from the release')

  const manifestPath = join(dir, 'klyvaron-pro-lm.klyvaron.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.weights.sha256 = sha256File(weightsPath)
  manifest.weights.bytes = readFileSync(weightsPath).length
  writeFileSync(manifestPath, JSON.stringify(manifest))

  const host = new NativeKlyvaronHost({ root })
  t.after(() => host.close())
  const record = host.get('klyvaron-pro-lm')
  assert.equal(record.status, 'failed')
  assert.equal(record.selectorEnabled, false)
  assert.equal(record.error.code, 'release_pin_mismatch')
})
