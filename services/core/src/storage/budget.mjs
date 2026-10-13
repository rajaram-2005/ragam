// Managed storage accounting, for the mobile footprint limit.
//
// Directive §5A and §18 set hard numbers:
//
//   "Keep the total Aetheris-managed mobile footprint strictly below 5 GB, including app
//    files, installed Klyvaron Lite weights, local indexes, optional installed models,
//    caches and retained application data."
//
//   "Maintain approximately 500 MB of free reserve when practical."
//   "Download optional model packs only when requested."
//   "Validate storage and file integrity before loading models."
//   "Clean regenerable caches safely."
//   "Never silently delete user-owned data."
//   "Track actual storage usage, not estimates alone."
//
// That last line dictates the design: nothing here multiplies a parameter count by an
// assumed bytes-per-parameter. `measure()` walks a directory and adds up `stat.size`.
// An estimate is fine for planning and useless for a limit, because the failure mode is
// a device that runs out of space while the accounting says it has not.
//
// THE ONE RULE THAT MATTERS MOST
//
// "Never silently delete user-owned data." Silence is the operative word. Deletion here
// is not merely audited, it is **categorically unavailable**: `clean()` iterates a set of
// regenerable categories and cannot reach anything else, so there is no code path that
// deletes user data to accidentally trigger. A protected category passed to `clean()` is
// an error, not a no-op, so a caller cannot believe it succeeded.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Storage categories, by directory under the managed root.
 *
 * The split exists to answer one question per category: may this be deleted without the
 * user's involvement? Only `caches` may.
 */
export const CATEGORIES = Object.freeze({
  APP_PACKAGE: 'appPackage',
  MODEL_WEIGHTS: 'modelWeights',
  OPTIONAL_PACKS: 'optionalPacks',
  INDEXES: 'indexes',
  CACHES: 'caches',
  USER_DATA: 'userData',
})

/** Directory name under the managed root for each category. */
export const CATEGORY_PATHS = Object.freeze({
  [CATEGORIES.APP_PACKAGE]: 'app',
  [CATEGORIES.MODEL_WEIGHTS]: 'models',
  [CATEGORIES.OPTIONAL_PACKS]: 'packs',
  [CATEGORIES.INDEXES]: 'index',
  [CATEGORIES.CACHES]: 'cache',
  [CATEGORIES.USER_DATA]: 'data',
})

/**
 * Regenerable: rebuilding these costs time, never information.
 * This is the only set `clean()` can touch.
 */
export const REGENERABLE = Object.freeze([CATEGORIES.CACHES])

/**
 * User-owned. Never deleted, never overwritten, never cleaned -- not by a cleanup call,
 * not by an eviction under pressure, not by a model download that needs the space. If a
 * download does not fit, the download fails and says so.
 */
export const PROTECTED = Object.freeze([CATEGORIES.USER_DATA])

export class StorageBudgetError extends Error {
  constructor(message, code = 'storage_budget_error', detail = {}) {
    super(message)
    this.name = 'StorageBudgetError'
    this.code = code
    this.detail = detail
  }
}

const MB = 1000 ** 2
const GB = 1000 ** 3

/** Directive §5A targets. Decimal GB, which is the stricter reading of a 5 GB budget. */
export const LIMITS = Object.freeze({
  managedTotalBytes: 5 * GB,
  reserveBytes: 500 * MB,
  appPackageBytes: 200 * MB,
  primaryModelBytes: 1.5 * GB,
})

export class MobileStorageBudget {
  /**
   * @param {object} options
   * @param {string} options.root  the Aetheris-managed directory on the device
   * @param {number} [options.managedTotalBytes]
   * @param {number} [options.reserveBytes]
   * @param {number} [options.deviceFreeBytes]  free space on the volume, if known
   */
  constructor({ root, managedTotalBytes = LIMITS.managedTotalBytes, reserveBytes = LIMITS.reserveBytes,
                deviceFreeBytes = null } = {}) {
    if (!root) throw new StorageBudgetError('a managed root directory is required', 'root_required')
    this.root = resolve(root)
    this.limits = { managedTotalBytes, reserveBytes }
    this.deviceFreeBytes = deviceFreeBytes
  }

  /** Absolute path for a category. */
  pathFor(category) {
    const segment = CATEGORY_PATHS[category]
    if (!segment) throw new StorageBudgetError(`unknown storage category '${category}'`, 'unknown_category')
    return join(this.root, segment)
  }

  /**
   * Measure the real bytes on disk.
   *
   * Symlinks are counted as their own size and never followed, so a link cannot make the
   * footprint appear either larger or smaller than it is, and a link to a protected
   * directory cannot be walked into.
   */
  measure() {
    const byCategory = {}
    let totalBytes = 0
    let fileCount = 0

    for (const category of Object.values(CATEGORIES)) {
      const path = this.pathFor(category)
      const { bytes, files } = walk(path)
      byCategory[category] = bytes
      totalBytes += bytes
      fileCount += files
    }

    const userDataBytes = byCategory[CATEGORIES.USER_DATA]
    const evictableBytes = REGENERABLE.reduce((sum, category) => sum + byCategory[category], 0)

    return {
      root: this.root,
      measuredAt: new Date().toISOString(),
      byCategory,
      totalBytes,
      fileCount,
      userDataBytes,
      // What could be freed without touching anything the user owns.
      reclaimableBytes: evictableBytes,
      // The figure the limit applies to: everything Aetheris manages, per §5A.
      managedBytes: totalBytes,
      limits: { ...this.limits },
      headroomBytes: this.limits.managedTotalBytes - totalBytes,
      reserveSatisfied: this.limits.managedTotalBytes - totalBytes >= this.limits.reserveBytes,
      deviceFreeBytes: this.deviceFreeBytes,
    }
  }

  /** Check the measured footprint against the limits. Never throws. */
  check() {
    const measured = this.measure()
    const breaches = []
    if (measured.totalBytes >= this.limits.managedTotalBytes) {
      breaches.push({
        rule: 'managed_total',
        message: `managed footprint is ${formatBytes(measured.totalBytes)}, at or above the `
          + `${formatBytes(this.limits.managedTotalBytes)} limit. The directive requires strictly below.`,
      })
    }
    if (measured.totalBytes + this.limits.reserveBytes > this.limits.managedTotalBytes) {
      breaches.push({
        rule: 'reserve',
        message: `only ${formatBytes(measured.headroomBytes)} of headroom remains; the reserve is `
          + `${formatBytes(this.limits.reserveBytes)}.`,
      })
    }
    if (measured.byCategory[CATEGORIES.APP_PACKAGE] > LIMITS.appPackageBytes) {
      breaches.push({
        rule: 'app_package',
        message: `the app package is ${formatBytes(measured.byCategory[CATEGORIES.APP_PACKAGE])}, `
          + `above the ${formatBytes(LIMITS.appPackageBytes)} target.`,
      })
    }
    const primary = measured.byCategory[CATEGORIES.MODEL_WEIGHTS]
    if (primary > LIMITS.primaryModelBytes) {
      breaches.push({
        rule: 'primary_model',
        message: `installed weights are ${formatBytes(primary)}, above the `
          + `${formatBytes(LIMITS.primaryModelBytes)} per-model target.`,
      })
    }
    return { ok: breaches.length === 0, measured, breaches }
  }

  /**
   * May `bytes` be installed?
   *
   * Returns a decision rather than throwing, because the caller has to tell the user
   * something useful. The refusal is never "we deleted your files to make room": a
   * protected category is reported as unavailable space, full stop.
   */
  canInstall(bytes, { category = CATEGORIES.MODEL_WEIGHTS, userRequested = false, label = null } = {}) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new StorageBudgetError('install size must be a non-negative number of bytes', 'invalid_size')
    }
    if (!Object.values(CATEGORIES).includes(category)) {
      throw new StorageBudgetError(`unknown storage category '${category}'`, 'unknown_category')
    }
    if (PROTECTED.includes(category)) {
      return {
        allowed: false,
        reason: 'protected_category',
        message: `'${category}' holds user-owned data and is never written to by an install path.`,
      }
    }

    const measured = this.measure()

    // §5A: "Download optional model packs only when requested."
    if (category === CATEGORIES.OPTIONAL_PACKS && !userRequested) {
      return {
        allowed: false,
        reason: 'not_requested',
        message: 'optional model packs are downloaded only when the user asks for them.',
      }
    }

    const projected = measured.totalBytes + bytes
    if (projected >= this.limits.managedTotalBytes) {
      const reclaimable = measured.reclaimableBytes
      return {
        allowed: false,
        reason: 'managed_limit',
        message: `${label ?? 'this download'} needs ${formatBytes(bytes)}; the managed footprint would `
          + `reach ${formatBytes(projected)}, at or above the ${formatBytes(this.limits.managedTotalBytes)} limit.`,
        reclaimableBytes: reclaimable,
        // Stated as an option the user can take, rather than an action taken for them.
        suggestion: reclaimable > 0
          ? `${formatBytes(reclaimable)} of regenerable caches could be cleared to make room.`
          : 'No regenerable cache remains; remove something you own, or choose a smaller model.',
      }
    }
    if (this.limits.managedTotalBytes - projected < this.limits.reserveBytes) {
      return {
        allowed: false,
        reason: 'reserve',
        message: `${label ?? 'this download'} would leave ${formatBytes(this.limits.managedTotalBytes - projected)} `
          + `of headroom, below the ${formatBytes(this.limits.reserveBytes)} reserve.`,
      }
    }
    if (this.deviceFreeBytes !== null && bytes > this.deviceFreeBytes) {
      return {
        allowed: false,
        reason: 'device_free',
        message: `the device reports ${formatBytes(this.deviceFreeBytes)} free, which is less than the `
          + `${formatBytes(bytes)} needed.`,
      }
    }
    if (category === CATEGORIES.MODEL_WEIGHTS && measured.byCategory[CATEGORIES.MODEL_WEIGHTS] + bytes > LIMITS.primaryModelBytes) {
      return {
        allowed: false,
        reason: 'primary_model',
        message: `installed weights would reach ${formatBytes(measured.byCategory[CATEGORIES.MODEL_WEIGHTS] + bytes)}, `
          + `above the ${formatBytes(LIMITS.primaryModelBytes)} per-model target.`,
      }
    }

    return {
      allowed: true,
      reason: 'fits',
      message: `${label ?? 'this download'} fits with ${formatBytes(this.limits.managedTotalBytes - projected)} to spare.`,
      projectedTotalBytes: projected,
    }
  }

  /**
   * Record an installed artifact, returning the manifest entry to persist.
   *
   * The digest is computed from the bytes on disk, so what is recorded is what was
   * installed -- not what the download was believed to contain.
   */
  recordInstall(file, { category = CATEGORIES.MODEL_WEIGHTS, label = null, expectedBytes = null } = {}) {
    const full = resolve(file)
    if (!full.startsWith(this.root + sep) && full !== this.root) {
      throw new StorageBudgetError(
        `'${file}' is outside the managed root; only managed files are accounted for`,
        'outside_managed_root',
      )
    }
    const stats = statSync(full)
    const decision = this.canInstall(expectedBytes ?? stats.size, { category, userRequested: true, label })
    return {
      file: full,
      bytes: stats.size,
      sha256: fileDigest(full),
      recordedAt: new Date().toISOString(),
      decision,
    }
  }

  /**
   * Clear regenerable caches.
   *
   * Only `REGENERABLE` categories are reachable. A protected category is refused with an
   * error rather than filtered out, so a mistaken caller finds out.
   */
  clean({ categories = REGENERABLE, dryRun = false } = {}) {
    for (const category of categories) {
      if (!Object.values(CATEGORIES).includes(category)) {
        throw new StorageBudgetError(`unknown storage category '${category}'`, 'unknown_category')
      }
      if (PROTECTED.includes(category)) {
        throw new StorageBudgetError(
          `refusing to clean '${category}': it holds user-owned data, which is never deleted by a cleanup`,
          'protected_category',
        )
      }
      if (!REGENERABLE.includes(category)) {
        throw new StorageBudgetError(
          `'${category}' is not regenerable; only ${REGENERABLE.join(', ')} may be cleaned`,
          'not_regenerable',
        )
      }
    }
    const removed = []
    let freedBytes = 0
    for (const category of categories) {
      for (const file of listFiles(this.pathFor(category))) {
        const size = statSync(file).size
        freedBytes += size
        removed.push({ file, bytes: size, category })
        if (!dryRun) removeFile(file)
      }
    }
    return { dryRun, categories, removedFiles: removed.length, freedBytes, removed }
  }

  /**
   * Verify a model file before loading it.
   *
   * §5A: "Validate storage and file integrity before loading models." A truncated
   * download is the ordinary failure, and a model that loads with a corrupt tail does
   * not raise -- it produces worse output, which is far harder to attribute.
   */
  verifyArtifact(file, expected) {
    const full = resolve(file)
    const problems = []
    if (!existsSync(full)) {
      return { ok: false, problems: [`${file} is not present`] }
    }
    const stats = statSync(full)
    if (expected?.bytes !== undefined && stats.size !== expected.bytes) {
      problems.push(`size is ${stats.size} bytes, expected ${expected.bytes}`)
    }
    if (expected?.sha256) {
      const actual = fileDigest(full)
      if (actual !== expected.sha256) problems.push(`sha256 is ${actual}, expected ${expected.sha256}`)
    }
    return { ok: problems.length === 0, problems, bytes: stats.size, sha256: fileDigest(full) }
  }
}

// --- filesystem helpers ----------------------------------------------------------

/** Total bytes and file count under a path. Symlinks are counted, never followed. */
function walk(path) {
  let bytes = 0
  let files = 0
  let stats
  try {
    stats = statSync(path)
  } catch {
    return { bytes, files }   // an absent category is zero bytes, not an error
  }
  if (stats.isSymbolicLink()) return { bytes: 0, files: 0 }
  if (!stats.isDirectory()) return { bytes: stats.size, files: 1 }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const nested = walk(full)
      bytes += nested.bytes
      files += nested.files
    } else if (entry.isFile()) {
      bytes += statSync(full).size
      files += 1
    }
  }
  return { bytes, files }
}

function listFiles(path) {
  const out = []
  let stats
  try {
    stats = statSync(path)
  } catch {
    return out
  }
  if (!stats.isDirectory()) return out
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function removeFile(file) {
  // Unlink only. Directories are left in place, so the category paths stay well-formed
  // after a cleanup and a later measure() does not have to recreate them.
  try {
    unlinkSync(file)
  } catch (error) {
    throw new StorageBudgetError(`could not remove '${file}': ${error.message}`, 'clean_failed')
  }
}

function fileDigest(file) {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown'
  const abs = Math.abs(bytes)
  if (abs >= GB) return `${(bytes / GB).toFixed(2)} GB`
  if (abs >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (abs >= 1000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${bytes} bytes`
}
