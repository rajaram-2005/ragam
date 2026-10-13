// Managed storage accounting: real bytes on a real filesystem.
//
// The measurement tests use actual files with actual sizes rather than stubs, because
// the failure mode being guarded against is accounting that drifts from the disk. A
// stubbed `statSync` would have proved only that the arithmetic works, which was never
// in doubt.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATEGORIES, LIMITS, MobileStorageBudget, PROTECTED, REGENERABLE, StorageBudgetError, formatBytes,
} from '../src/storage/budget.mjs'

const MB = 1000 ** 2
const GB = 1000 ** 3

/** A managed root with the category directories present, as the app would create them. */
function makeRoot({ files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aetheris-budget-'))
  for (const dir of ['app', 'models', 'packs', 'index', 'cache', 'data']) mkdirSync(join(root, dir))
  for (const [relative, { bytes, content }] of Object.entries(files)) {
    const full = join(root, relative)
    mkdirSync(join(full, '..'), { recursive: true })
    // A real sparse file, so stat().size reports exactly the size asked for without
    // writing gigabytes to a sandbox with 3.85 GB of disk.
    const fd = openSync(full, 'w')
    ftruncateSync(fd, bytes)
    closeSync(fd)
    if (content !== undefined) writeFileSync(full, content)
  }
  return root
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true })

test('an empty root measures zero across every category', () => {
  const root = makeRoot()
  try {
    const measured = new MobileStorageBudget({ root }).measure()
    assert.equal(measured.totalBytes, 0)
    assert.equal(measured.fileCount, 0)
    assert.deepEqual(new Set(Object.keys(measured.byCategory)), new Set(Object.values(CATEGORIES)))
  } finally { cleanup(root) }
})

test('the measured total is the sum of the real file sizes, not an estimate', () => {
  const root = makeRoot({ files: {
    'app/bundle.js': { bytes: 3 * MB },
    'models/weights.npz': { bytes: 1_448_014 },
    'index/bm25.bin': { bytes: 40 * MB },
    'cache/probe.json': { bytes: 12_500 },
    'data/notes.json': { bytes: 900 },
  } })
  try {
    const measured = new MobileStorageBudget({ root }).measure()
    assert.equal(measured.byCategory.appPackage, 3 * MB)
    assert.equal(measured.byCategory.modelWeights, 1_448_014)
    assert.equal(measured.byCategory.indexes, 40 * MB)
    assert.equal(measured.byCategory.caches, 12_500)
    assert.equal(measured.byCategory.userData, 900)
    assert.equal(measured.totalBytes, 3 * MB + 1_448_014 + 40 * MB + 12_500 + 900)
    assert.equal(measured.fileCount, 5)
  } finally { cleanup(root) }
})

test('nested directories are counted, and symlinks are neither followed nor counted', () => {
  const root = makeRoot({ files: {
    'index/nested/deep/x.bin': { bytes: 1000 },
    'index/nested/y.bin': { bytes: 2000 },
  } })
  try {
    const budget = new MobileStorageBudget({ root })
    assert.equal(budget.measure().byCategory.indexes, 3000)
    // A link pointing at the protected directory must not pull its bytes into a
    // reclaimable category, and must not add phantom bytes either.
    symlinkSync(join(root, 'data'), join(root, 'cache', 'link-to-data'))
    writeFileSync(join(root, 'data', 'secret.json'), 'x'.repeat(5000))
    const after = budget.measure()
    assert.equal(after.byCategory.caches, 0, 'the symlink contributes nothing')
    assert.equal(after.byCategory.userData, 5000, 'the real file still counts where it lives')
  } finally { cleanup(root) }
})

test('a footprint at or beyond 5 GB is a breach, and the check reports it rather than throwing', () => {
  const root = makeRoot({ files: { 'models/big.gguf': { bytes: 5 * GB } } })
  try {
    const { ok, breaches, measured } = new MobileStorageBudget({ root }).check()
    assert.equal(ok, false)
    assert.ok(breaches.some((b) => b.rule === 'managed_total'), JSON.stringify(breaches))
    assert.match(breaches.find((b) => b.rule === 'managed_total').message, /strictly below/)
    assert.ok(measured.totalBytes >= 5 * GB)
  } finally { cleanup(root) }
})

test('the boundary is strict: 1 byte under 5 GB passes, exactly 5 GB fails', () => {
  const under = makeRoot({ files: { 'models/m.gguf': { bytes: LIMITS.managedTotalBytes - 1 } } })
  const at = makeRoot({ files: { 'models/m.gguf': { bytes: LIMITS.managedTotalBytes } } })
  try {
    // "strictly below 5 GB" -- the -1 case still fails the reserve rule, which is a
    // different breach, so assert on which rule fired rather than on ok alone.
    const underCheck = new MobileStorageBudget({ root: under }).check()
    assert.ok(!underCheck.breaches.some((b) => b.rule === 'managed_total'), '1 byte under is not over the limit')
    assert.ok(underCheck.breaches.some((b) => b.rule === 'reserve'), 'but it does eat the reserve')

    const atCheck = new MobileStorageBudget({ root: at }).check()
    assert.ok(atCheck.breaches.some((b) => b.rule === 'managed_total'), 'exactly 5 GB is not strictly below')
  } finally { cleanup(under); cleanup(at) }
})

test('the reserve is enforced as its own rule, with the directive number', () => {
  const root = makeRoot({ files: { 'models/m.gguf': { bytes: 4 * GB + 600 * MB } } })
  try {
    const { breaches } = new MobileStorageBudget({ root }).check()
    const reserve = breaches.find((b) => b.rule === 'reserve')
    assert.ok(reserve, JSON.stringify(breaches))
    assert.match(reserve.message, /only 400\.0 MB of headroom remains; the reserve is 500\.0 MB/)
  } finally { cleanup(root) }
})

test('an install that would breach the limit is refused with the reason and a user-facing option', () => {
  const root = makeRoot({ files: {
    'models/a.gguf': { bytes: 4 * GB },
    'cache/junk.bin': { bytes: 300 * MB },
  } })
  try {
    const decision = new MobileStorageBudget({ root }).canInstall(1 * GB, { label: 'Klyvaron Lite' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'managed_limit')
    assert.match(decision.message, /Klyvaron Lite needs 1\.00 GB/)
    assert.equal(decision.reclaimableBytes, 300 * MB)
    assert.match(decision.suggestion, /could be cleared to make room/, 'offered, not done')
  } finally { cleanup(root) }
})

test('an install that fits is allowed and reports the headroom', () => {
  const root = makeRoot({ files: { 'models/a.gguf': { bytes: 1 * GB } } })
  try {
    const decision = new MobileStorageBudget({ root }).canInstall(500 * MB, { label: 'a pack' })
    assert.equal(decision.allowed, true)
    assert.equal(decision.reason, 'fits')
    assert.equal(decision.projectedTotalBytes, 1_500 * MB)
  } finally { cleanup(root) }
})

test('optional packs are refused unless the user asked for them', () => {
  const root = makeRoot()
  try {
    const budget = new MobileStorageBudget({ root })
    const unrequested = budget.canInstall(10 * MB, { category: CATEGORIES.OPTIONAL_PACKS })
    assert.equal(unrequested.allowed, false)
    assert.equal(unrequested.reason, 'not_requested')
    assert.match(unrequested.message, /only when the user asks/)
    const requested = budget.canInstall(10 * MB, { category: CATEGORIES.OPTIONAL_PACKS, userRequested: true })
    assert.equal(requested.allowed, true)
  } finally { cleanup(root) }
})

test('device free space is respected when it is known', () => {
  const root = makeRoot()
  try {
    const decision = new MobileStorageBudget({ root, deviceFreeBytes: 100 * MB })
      .canInstall(400 * MB, { label: 'a model' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'device_free')
    assert.match(decision.message, /100\.0 MB free/)
  } finally { cleanup(root) }
})

test('the per-model target is enforced separately from the total', () => {
  const root = makeRoot()
  try {
    const decision = new MobileStorageBudget({ root }).canInstall(2 * GB, { label: 'a large model' })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'primary_model')
    assert.match(decision.message, /1\.50 GB per-model target/)
  } finally { cleanup(root) }
})

// --- the invariant that protects user data ---------------------------------------

test('a protected category cannot be installed into', () => {
  const root = makeRoot()
  try {
    const decision = new MobileStorageBudget({ root }).canInstall(1, { category: CATEGORIES.USER_DATA })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'protected_category')
    assert.match(decision.message, /never written to by an install path/)
  } finally { cleanup(root) }
})

test('clean() refuses user data with an error, not a silent no-op', () => {
  const root = makeRoot({ files: { 'data/notes.json': { bytes: 100 } } })
  try {
    const budget = new MobileStorageBudget({ root })
    assert.throws(
      () => budget.clean({ categories: [CATEGORIES.USER_DATA] }),
      (error) => error instanceof StorageBudgetError && error.code === 'protected_category'
        && /never deleted by a cleanup/.test(error.message),
    )
    assert.equal(existsSync(join(root, 'data', 'notes.json')), true, 'the file is still there')
  } finally { cleanup(root) }
})

test('clean() reaches only regenerable categories, and clearing them leaves user data alone', () => {
  const root = makeRoot({ files: {
    'cache/probe.json': { bytes: 1000 },
    'cache/nested/deep.bin': { bytes: 2500 },
    'index/bm25.bin': { bytes: 50 * MB },
    'models/w.npz': { bytes: 2000 },
    'data/notes.json': { bytes: 400 },
  } })
  try {
    const budget = new MobileStorageBudget({ root })
    const before = budget.measure()

    // The indexes are NOT regenerable by policy: rebuilding them costs a full re-index
    // of the user's own documents, so they are not "safe to delete" in the directive's
    // sense and are excluded.
    assert.throws(() => budget.clean({ categories: [CATEGORIES.INDEXES] }),
      (error) => error instanceof StorageBudgetError && error.code === 'not_regenerable')

    const dry = budget.clean({ dryRun: true })
    assert.equal(dry.freedBytes, 3500)
    assert.equal(existsSync(join(root, 'cache', 'probe.json')), true, 'a dry run removes nothing')

    const result = budget.clean()
    assert.equal(result.freedBytes, 3500)
    assert.deepEqual(result.categories, [CATEGORIES.CACHES])
    const after = budget.measure()
    assert.equal(after.byCategory.caches, 0)
    assert.equal(after.byCategory.userData, 400, 'user data is untouched')
    assert.equal(after.byCategory.indexes, before.byCategory.indexes, 'indexes are untouched')
    assert.equal(existsSync(join(root, 'data', 'notes.json')), true)
    assert.equal(existsSync(join(root, 'cache')), true, 'the category directory remains well-formed')
  } finally { cleanup(root) }
})

test('clean() rejects an unknown category rather than ignoring it', () => {
  const root = makeRoot()
  try {
    assert.throws(() => new MobileStorageBudget({ root }).clean({ categories: ['tmp'] }),
      (error) => error instanceof StorageBudgetError && error.code === 'unknown_category')
  } finally { cleanup(root) }
})

test('the protected and regenerable sets are exactly as documented, and do not overlap', () => {
  assert.deepEqual(PROTECTED, [CATEGORIES.USER_DATA])
  assert.deepEqual(REGENERABLE, [CATEGORIES.CACHES])
  assert.equal(PROTECTED.some((c) => REGENERABLE.includes(c)), false,
    'a category cannot be both protected and cleanable')
})

// --- integrity -------------------------------------------------------------------

test('a truncated artifact is caught before it is loaded', () => {
  const root = makeRoot()
  try {
    const file = join(root, 'models', 'w.npz')
    writeFileSync(file, 'weights-v1')
    const budget = new MobileStorageBudget({ root })

    const recorded = budget.recordInstall(file, { label: 'test weights' })
    assert.equal(recorded.bytes, 10)
    assert.equal(recorded.sha256.length, 64)
    assert.equal(recorded.decision.allowed, true)

    assert.deepEqual(budget.verifyArtifact(file, recorded), {
      ok: true, problems: [], bytes: 10, sha256: recorded.sha256,
    })

    writeFileSync(file, 'weights-v2-tampered')
    const tampered = budget.verifyArtifact(file, recorded)
    assert.equal(tampered.ok, false)
    assert.ok(tampered.problems.some((p) => /size is 19 bytes, expected 10/.test(p)), tampered.problems.join('; '))
    assert.ok(tampered.problems.some((p) => /sha256 is .* expected/.test(p)))
  } finally { cleanup(root) }
})

test('a missing artifact reports missing rather than throwing', () => {
  const root = makeRoot()
  try {
    const result = new MobileStorageBudget({ root }).verifyArtifact(join(root, 'models', 'gone.npz'), { bytes: 1 })
    assert.equal(result.ok, false)
    assert.match(result.problems[0], /is not present/)
  } finally { cleanup(root) }
})

test('an install outside the managed root is refused, so the accounting stays complete', () => {
  const root = makeRoot()
  const outside = mkdtempSync(join(tmpdir(), 'aetheris-outside-'))
  try {
    writeFileSync(join(outside, 'w.bin'), 'x')
    assert.throws(
      () => new MobileStorageBudget({ root }).recordInstall(join(outside, 'w.bin')),
      (error) => error instanceof StorageBudgetError && error.code === 'outside_managed_root',
    )
  } finally { cleanup(root); cleanup(outside) }
})

test('a non-numeric install size is rejected rather than treated as zero', () => {
  const root = makeRoot()
  try {
    const budget = new MobileStorageBudget({ root })
    for (const bad of [NaN, -1, '5MB', undefined]) {
      assert.throws(() => budget.canInstall(bad), (error) => error instanceof StorageBudgetError && error.code === 'invalid_size', `accepted ${bad}`)
    }
  } finally { cleanup(root) }
})

test('a root is required: accounting with no root cannot silently measure nothing', () => {
  assert.throws(() => new MobileStorageBudget({}), (error) => error instanceof StorageBudgetError && error.code === 'root_required')
})

test('bytes are formatted in decimal units, matching the limits they are compared to', () => {
  // MiB-vs-MB confusion in a storage limit is a silent 5% error on a 5 GB budget.
  assert.equal(formatBytes(500 * 1000 ** 2), '500.0 MB')
  assert.equal(formatBytes(5 * 1000 ** 3), '5.00 GB')
  assert.equal(formatBytes(1000), '1.0 kB')
  assert.equal(formatBytes(999), '999 bytes')
  assert.equal(formatBytes(NaN), 'unknown')
})
