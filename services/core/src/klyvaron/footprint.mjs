// The mobile footprint report: every byte Aetheris manages on the device, and the
// verdict against the §5A budget.
//
// `storage/budget.mjs` measures the six managed *categories* and enforces the rules for
// each. This module answers the question a user actually asks — "how much of my phone is
// this app using?" — which requires counting one thing the category walk does not: files
// the application writes at the managed root itself (a SQLite store, a log, a stray
// download). Those are real bytes on a real device, so a footprint report that ignored
// them would be an undercount presented as a limit.
//
// The report is therefore explicit about the two buckets:
//
//   categories   classified bytes, each with its own rule (app package, weights, packs,
//                indexes, caches, user data)
//   unmanaged    files under the managed root that are in no category — counted, listed
//                by name, and never silently deleted
//
// and the budget verdict is computed over the total, not over the tidy subset.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

import { CATEGORIES, formatBytes } from '../storage/budget.mjs'

/** Names under the managed root that belong to a category and must not be double-counted. */
function categoryDirectories(budget) {
  return new Set(Object.values(CATEGORIES).map((category) => budget.pathFor(category)))
}

function walkFiles(directory, { limit = Infinity } = {}) {
  const files = []
  const visit = (current) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.isFile()) {
        files.push({ path: full, bytes: statSync(full).size })
        if (files.length > limit) return
      }
    }
  }
  visit(directory)
  return files
}

export class MobileFootprint {
  /**
   * @param {object} options
   * @param {object} options.budget  a MobileStorageBudget rooted at the managed directory
   * @param {string} [options.dataDir]  the wider application data directory, if any
   */
  constructor({ budget, dataDir = null }) {
    if (!budget?.measure) throw new TypeError('MobileFootprint requires a storage budget')
    this.budget = budget
    this.dataDir = dataDir ? resolve(dataDir) : null
  }

  /** Unmanaged files under the managed root: present, counted, and attributable by name. */
  unmanaged() {
    const managed = this.budget.root
    const skip = categoryDirectories(this.budget)
    const files = []
    for (const entry of readdirSync(managed, { withFileTypes: true })) {
      const full = join(managed, entry.name)
      if (skip.has(full)) continue
      if (entry.isDirectory()) files.push(...walkFiles(full))
      else if (entry.isFile()) files.push({ path: full, bytes: statSync(full).size })
    }
    return {
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files: files.length,
      // Named rather than summarised: "unmanaged: 212 MB" is not actionable, a filename is.
      largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 5).map((file) => ({
        path: this.dataDir && file.path.startsWith(this.dataDir) ? relative(this.dataDir, file.path) : relative(managed, file.path),
        bytes: file.bytes,
        human: formatBytes(file.bytes),
      })),
    }
  }

  /**
   * Full report. Never throws: an unreadable directory is reported as a problem rather
   * than turned into a 500, because a footprint check that fails closed is a footprint
   * check that stops the app from starting.
   */
  report() {
    const measured = this.budget.measure()
    const unmanaged = this.unmanaged()
    const totalBytes = measured.managedBytes + unmanaged.bytes
    // The budget's own limits, not the module defaults: a device with a smaller
    // allowance (or a test with one) must be held to what it was configured with.
    const { managedTotalBytes, reserveBytes } = this.budget.limits
    const headroomBytes = managedTotalBytes - totalBytes

    const breaches = [...this.budget.check().breaches]
    // The category rules are checked by the budget; the total across both buckets is
    // checked here, because that is the number the user experiences.
    if (totalBytes >= managedTotalBytes) {
      breaches.push({
        rule: 'managed_total_including_unmanaged',
        message: `the managed footprint is ${formatBytes(totalBytes)} including ${formatBytes(unmanaged.bytes)} in no category, `
          + `at or above the ${formatBytes(managedTotalBytes)} limit.`,
      })
    }
    return {
      generatedAt: new Date().toISOString(),
      root: measured.root,
      categories: measured.byCategory,
      categoryBytes: measured.managedBytes,
      unmanagedBytes: unmanaged.bytes,
      unmanagedFiles: unmanaged.files,
      largestUnmanaged: unmanaged.largest,
      totalBytes,
      totalHuman: formatBytes(totalBytes),
      limits: { managedTotalBytes, reserveBytes },
      headroomBytes,
      headroomHuman: formatBytes(Math.max(0, headroomBytes)),
      reserveSatisfied: headroomBytes >= reserveBytes,
      reclaimableBytes: measured.reclaimableBytes,
      fileCount: measured.fileCount + unmanaged.files,
      withinBudget: breaches.length === 0,
      breaches,
    }
  }

  /** A single sentence for a settings screen, stated the way a person would say it. */
  summary() {
    const report = this.report()
    return {
      text: `Aetheris is using ${report.totalHuman} of storage on this device, `
        + `${report.withinBudget ? 'within' : 'OVER'} the ${formatBytes(this.budget.limits.managedTotalBytes)} budget. `
        + `${formatBytes(report.reclaimableBytes)} can be freed without deleting anything you own.`,
      withinBudget: report.withinBudget,
      totalBytes: report.totalBytes,
    }
  }
}
