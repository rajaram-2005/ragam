// Installing, verifying, removing and accounting for a local model.
//
// Phase 4's mobile storage rule is only real if each step that could exceed the budget
// actually refuses. These tests therefore build a managed root on a real filesystem and
// exercise the refusals: too large to install, corrupt on arrival, corrupted after
// installation, and the one that matters most -- a model removal that must never reach
// anything the user owns.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CATEGORIES, MobileStorageBudget } from '../src/storage/budget.mjs'
import { KlyvaronStore, ModelStoreError } from '../src/klyvaron/store.mjs'
import { MobileFootprint } from '../src/klyvaron/footprint.mjs'
import { ArtifactError } from '../src/klyvaron/format.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/klyvaron-lite-parity.json', import.meta.url), 'utf8'))

/** A source directory holding the fixture as an installable artifact. */
function sourceArtifact() {
  const directory = mkdtempSync(join(tmpdir(), 'klyvaron-source-'))
  writeFileSync(join(directory, 'parity.npz'), Buffer.from(fixture.npzBase64, 'base64'))
  writeFileSync(join(directory, 'klyvaron-parity-tiny.klyvaron.json'), JSON.stringify(fixture.manifest, null, 2))
  return directory
}

/**
 * A second artifact for the *same* id: another version, and genuinely different bytes.
 *
 * A same-artifact replace cannot expose what a version change does to the directory -- the
 * filenames are identical, so nothing can be left behind. Real artifacts carry their
 * version in the weights filename (`<id>-<version>.npz`), which is the case that matters.
 */
function otherVersionArtifact(version = '0.9.9') {
  const directory = mkdtempSync(join(tmpdir(), 'klyvaron-source-'))
  const manifest = structuredClone(fixture.manifest)
  manifest.version = version
  // Same length, one flipped byte: only the digest distinguishes the two weight files, so
  // the size accounting stays comparable between versions.
  const weights = Buffer.from(fixture.npzBase64, 'base64')
  weights[Math.floor(weights.length / 2)] ^= 0x01
  manifest.weights = {
    ...manifest.weights,
    file: `${manifest.id}-${version}.npz`,
    sha256: createHash('sha256').update(weights).digest('hex'),
  }
  writeFileSync(join(directory, manifest.weights.file), weights)
  writeFileSync(join(directory, `${manifest.id}.klyvaron.json`), JSON.stringify(manifest, null, 2))
  return directory
}

function directoryBytes(directory) {
  return readdirSync(directory).reduce((total, name) => total + statSync(join(directory, name)).size, 0)
}

function makeRoot({ limits = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-root-'))
  const budget = new MobileStorageBudget({ root, ...limits })
  for (const category of Object.values(CATEGORIES)) mkdirSync(budget.pathFor(category), { recursive: true })
  return { root, budget, store: new KlyvaronStore({ root, budget }) }
}

test('an artifact installs into the library, and the copy is verified, not assumed', () => {
  const { store, budget } = makeRoot()
  const installed = store.install(sourceArtifact())

  assert.equal(installed.id, fixture.manifest.id)
  assert.equal(installed.version, fixture.manifest.version)
  assert.ok(installed.directory.startsWith(budget.pathFor(CATEGORIES.MODEL_WEIGHTS)))
  assert.equal(installed.sha256, fixture.manifest.weights.sha256)

  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].instructionTuned, false, 'a base model must be listed as one')
  assert.equal(listed[0].weightsBytes, fixture.manifest.weights.bytes)

  const verified = store.verify()
  assert.deepEqual(verified.map((entry) => entry.ok), [true])

  // Re-installing the same id is refused by default: an explicit replace is a decision.
  assert.throws(() => store.install(sourceArtifact()), (error) => error.code === 'already_installed')
  const replaced = store.install(sourceArtifact(), { replace: true })
  assert.equal(replaced.sha256, fixture.manifest.weights.sha256)
  assert.equal(store.list().length, 1, 'replace must not leave a second copy behind')
})

test('replacing one version with another leaves nothing of the first behind', () => {
  // Found by installing two versions of one id on a real device and reading the directory
  // afterwards: `cpSync` merges into an existing directory, so the previous version's
  // weights survived the replace with no manifest referring to them. `verify()` never looks
  // at an unreferenced file and the budget only ever measured the directory, so the only
  // visible symptom was a device using twice the storage it reported for one model.
  const { store } = makeRoot()
  const first = sourceArtifact()
  const second = otherVersionArtifact()

  const installedFirst = store.install(first)
  assert.equal(installedFirst.version, '0.1.0')
  assert.equal(installedFirst.bytes, directoryBytes(first))

  const installedSecond = store.install(second, { replace: true })
  assert.equal(installedSecond.version, '0.9.9')

  // The directory holds this version and nothing else...
  assert.deepEqual(
    readdirSync(installedSecond.directory).sort(),
    [`${fixture.manifest.id}.klyvaron.json`, `${fixture.manifest.id}-0.9.9.npz`].sort(),
  )
  // ...and the store's own report agrees with its own measurement. Before the fix these two
  // numbers differed by exactly one artifact, because install reported the source directory.
  const [listed] = store.list()
  assert.equal(listed.version, '0.9.9')
  assert.equal(installedSecond.bytes, directoryBytes(installedSecond.directory))
  assert.equal(listed.bytes, installedSecond.bytes)

  // Rolling back is the same operation in the other direction, and it also leaves no trace.
  const rolledBack = store.install(first, { replace: true })
  assert.equal(rolledBack.version, '0.1.0')
  assert.deepEqual(
    readdirSync(rolledBack.directory).sort(),
    [`${fixture.manifest.id}.klyvaron.json`, 'parity.npz'].sort(),
  )
  assert.deepEqual(store.verify().map((entry) => entry.ok), [true])
})

test('an artifact that does not fit the budget is refused rather than accommodated', () => {
  const { store } = makeRoot({ limits: { managedTotalBytes: fixture.manifest.weights.bytes + 10, reserveBytes: 1000 } })
  assert.throws(() => store.install(sourceArtifact()), (error) => {
    assert.ok(error instanceof ModelStoreError)
    assert.equal(error.code, 'storage_budget')
    assert.match(error.message, /cannot install/)
    return true
  })
  assert.deepEqual(store.list(), [], 'a refused install must not leave a partial library entry')
})

test('an artifact whose weights do not match its manifest never reaches the library', () => {
  const source = sourceArtifact()
  const bytes = readFileSync(join(source, 'parity.npz'))
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(join(source, 'parity.npz'), bytes)

  const { store } = makeRoot()
  assert.throws(() => store.install(source), (error) => {
    assert.ok(error instanceof ArtifactError)
    assert.equal(error.code, 'digest_mismatch')
    return true
  })
  assert.deepEqual(store.list(), [])
})

test('a model edited after installation is caught by verification and refused by load', () => {
  const { store } = makeRoot()
  const installed = store.install(sourceArtifact())
  const weights = join(installed.directory, fixture.manifest.weights.file)
  appendFileSync(weights, Buffer.from([0]))

  const [verification] = store.verify(installed.id)
  assert.equal(verification.ok, false)
  assert.ok(verification.problems.some((problem) => problem.includes('size') || problem.includes('sha256')))

  assert.throws(() => store.load(installed.id), (error) => {
    // Appending changes the size, which `loadArtifact` reports before it hashes; either
    // code is an integrity failure, and the point is that it is refused.
    assert.ok(['size_mismatch', 'digest_mismatch'].includes(error.code), `unexpected code ${error.code}`)
    return true
  })
})

test('loading the installed artifact produces the model, and removal frees exactly it', () => {
  const { store, budget } = makeRoot()
  const installed = store.install(sourceArtifact())
  const loaded = store.load(fixture.manifest.id)
  assert.equal(loaded.runtime.parameterCount, fixture.manifest.provenance.parameterCount)
  assert.ok(loaded.loadMs >= 0)

  const before = budget.measure().byCategory[CATEGORIES.MODEL_WEIGHTS]
  const removed = store.remove(fixture.manifest.id)
  assert.ok(removed.freedBytes > 0)
  assert.ok(removed.freedBytes <= before)
  assert.equal(existsSync(installed.directory), false)
  assert.deepEqual(store.list(), [])

  assert.throws(() => store.remove('not-installed'), (error) => error.code === 'not_installed')
  assert.throws(() => store.load('not-installed'), (error) => error.code === 'not_installed')
})

test('cache cleaning cannot reach anything but caches', () => {
  const { root, store, budget } = makeRoot()
  writeFileSync(join(budget.pathFor(CATEGORIES.CACHES), 'scratch.bin'), 'cache')
  writeFileSync(join(budget.pathFor(CATEGORIES.USER_DATA), 'notes.txt'), 'user data')
  writeFileSync(join(budget.pathFor(CATEGORIES.MODEL_WEIGHTS), 'weights.npz'), 'weights')

  const dryRun = store.cleanCaches({ dryRun: true })
  assert.equal(dryRun.removedFiles, 1)
  const cleaned = store.cleanCaches()
  assert.ok(cleaned.freedBytes > 0)
  assert.equal(existsSync(join(budget.pathFor(CATEGORIES.CACHES), 'scratch.bin')), false)
  assert.equal(existsSync(join(budget.pathFor(CATEGORIES.USER_DATA), 'notes.txt')), true, 'user data survives a cleanup')
  assert.equal(existsSync(join(budget.pathFor(CATEGORIES.MODEL_WEIGHTS), 'weights.npz')), true, 'weights are not a cache')
  assert.equal(root.length > 0, true)
})

test('the footprint report counts what the category walk cannot see', () => {
  const { root, budget } = makeRoot()
  const store = new KlyvaronStore({ root, budget })
  store.install(sourceArtifact())
  writeFileSync(join(budget.pathFor(CATEGORIES.USER_DATA), 'notes.txt'), 'x'.repeat(2048))
  // A file at the managed root in no category -- a stray log, say. It is real bytes on
  // a real device, so a report that skipped it would understate the footprint.
  writeFileSync(join(root, 'stray.log'), 'y'.repeat(512))

  const footprint = new MobileFootprint({ budget })
  const report = footprint.report()
  assert.equal(report.unmanagedBytes, 512)
  assert.equal(report.unmanagedFiles, 1)
  assert.deepEqual(report.largestUnmanaged.map((entry) => entry.path), ['stray.log'])
  assert.ok(report.categoryBytes >= fixture.manifest.weights.bytes)
  assert.equal(report.totalBytes, report.categoryBytes + 512)
  assert.equal(report.withinBudget, true)
  assert.ok(report.headroomHuman.length > 0)

  const summary = footprint.summary()
  assert.equal(summary.withinBudget, true)
  assert.match(summary.text, /Aetheris is using/)
  assert.match(summary.text, /can be freed without deleting anything you own/)
})

test('a footprint over the budget says so instead of rounding itself down', () => {
  const { root, budget } = makeRoot({ limits: { managedTotalBytes: 50_000, reserveBytes: 10_000 } })
  const store = new KlyvaronStore({ root, budget })
  store.install(sourceArtifact())

  const footprint = new MobileFootprint({ budget })
  const report = footprint.report()
  // The fixture artifact alone is under the limit; add unmanaged bytes to cross it.
  writeFileSync(join(root, 'big.log'), Buffer.alloc(60_000))
  const over = new MobileFootprint({ budget }).report()
  assert.equal(over.withinBudget, false)
  assert.ok(over.breaches.length > 0)
  assert.ok(over.breaches.some((breach) => breach.rule === 'managed_total_including_unmanaged'))
  assert.equal(report.withinBudget, true, 'the same root was within budget before the stray file')
  assert.match(new MobileFootprint({ budget }).summary().text, /OVER/)
})
