// The installed-model library: where a Klyvaron artifact lives on a device, and the
// rules under which it may arrive and leave.
//
// Phase 4 pairs "real local inference" with "storage accounting". Those are one feature,
// not two: the failure mode of a phone-side model library is a device that runs out of
// space because the library grew past a budget nobody enforced. So installation is a
// transaction with four gates, each of which can refuse:
//
//   1. The source directory must be a *complete, verified* artifact — `loadArtifact`
//      checks the manifest, the weight-list/architecture agreement, the file digest and
//      every parameter shape before a single byte is copied.
//   2. The bytes must fit the managed budget, with the reserve intact. `canInstall`
//      answers that, and it never frees space by deleting something the user owns.
//   3. After copying, the installed files are re-verified against the digests recorded
//      before the copy. A truncated copy is the ordinary failure, and it is silent.
//   4. Installation is recorded with the digest of what actually landed on disk.
//
// Removal is deliberately narrow: this store can delete model weights it installed, and
// nothing else. There is no path from here to a user's documents, their index or their
// memory — the storage categories that hold those are protected in `storage/budget.mjs`,
// and the store never receives those paths at all.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { CATEGORIES, MobileStorageBudget, StorageBudgetError } from '../storage/budget.mjs'
import { ArtifactError, loadArtifact, findManifest } from './format.mjs'
import { KlyvaronRuntime } from './runtime.mjs'

export class ModelStoreError extends Error {
  constructor(message, { code = 'model_store_error', detail = {} } = {}) {
    super(message)
    this.name = 'ModelStoreError'
    this.code = code
    this.detail = detail
  }
}

function directoryBytes(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) total += directoryBytes(full)
    else if (entry.isFile()) total += statSync(full).size
  }
  return total
}

export class KlyvaronStore {
  /**
   * @param {object} options
   * @param {string} options.root      the managed root (categories live under it)
   * @param {MobileStorageBudget} [options.budget]
   * @param {number} [options.deviceFreeBytes]
   */
  constructor({ root, budget = null, deviceFreeBytes = null }) {
    if (!root) throw new ModelStoreError('a managed root is required', { code: 'root_required' })
    this.root = resolve(root)
    this.budget = budget ?? new MobileStorageBudget({ root: this.root, deviceFreeBytes })
    this.libraryPath = this.budget.pathFor(CATEGORIES.MODEL_WEIGHTS)
    mkdirSync(this.libraryPath, { recursive: true })
  }

  /** Installed models, read from disk rather than from a registry that can drift. */
  list() {
    if (!existsSync(this.libraryPath)) return []
    const installed = []
    for (const entry of readdirSync(this.libraryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = join(this.libraryPath, entry.name)
      try {
        const manifestPath = findManifest(directory)
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        installed.push({
          id: manifest.id,
          version: manifest.version,
          tier: manifest.tier,
          directory,
          bytes: directoryBytes(directory),
          weightsBytes: manifest.weights?.bytes ?? null,
          instructionTuned: manifest.instructionTuned === true,
        })
      } catch (error) {
        // A directory that is not a readable artifact is reported as broken rather than
        // hidden: a silent skip makes a failed install look like an empty library.
        installed.push({ id: entry.name, version: null, directory, broken: error.message })
      }
    }
    return installed.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }

  get(id) {
    return this.list().find((entry) => entry.id === id && !entry.broken) ?? null
  }

  /**
   * Install a verified artifact directory into the managed library.
   *
   * @param {string} source     a directory holding one `*.klyvaron.json` and its weights
   * @param {object} [options]
   * @param {boolean} [options.userRequested] a download happens only when asked for (§5A)
   * @param {boolean} [options.replace]       overwrite an existing install of the same id
   */
  install(source, { userRequested = true, replace = false } = {}) {
    const from = resolve(source)
    // Gate 1: verify before copying. `loadArtifact` is the same check the runtime does,
    // so an artifact cannot pass install and then fail to load.
    const verified = loadArtifact(from)

    const target = join(this.libraryPath, verified.manifest.id)
    const existing = existsSync(target)
    if (existing && !replace) {
      throw new ModelStoreError(
        `'${verified.manifest.id}' is already installed; pass replace to overwrite it deliberately`,
        { code: 'already_installed' },
      )
    }
    if (target && !target.startsWith(this.libraryPath + sep)) {
      // Defensive: an id containing '..' would otherwise escape the library.
      throw new ModelStoreError(`refusing to install outside the model library: ${verified.manifest.id}`, {
        code: 'unsafe_id',
      })
    }

    // What the device gains, not what the download weighs. A replace frees the space the
    // previous version of this id occupied, and the two are not the same number: charging
    // the whole artifact again refuses an update that in fact costs almost nothing. For a
    // fresh install the directory is new, so the two coincide -- which is why the
    // difference stayed invisible until two versions of one id were installed in sequence.
    const sourceBytes = directoryBytes(from)
    const existingBytes = existing ? directoryBytes(target) : 0
    const growthBytes = Math.max(0, sourceBytes - existingBytes)
    // Gate 2: the budget decides, and it decides with real numbers.
    const decision = this.budget.canInstall(growthBytes, {
      category: CATEGORIES.MODEL_WEIGHTS,
      userRequested,
      label: verified.manifest.id,
    })
    if (!decision.allowed) {
      throw new ModelStoreError(
        `cannot install '${verified.manifest.id}': ${decision.reason}`,
        { code: 'storage_budget', detail: decision },
      )
    }

    if (existing) {
      // `cpSync` merges into a directory that already exists, so replacing an artifact used
      // to leave the previous version's .npz sitting next to the new one: no manifest refers
      // to it, `verify()` never looks at it, and nothing ever reclaims it. Measured on a real
      // update -- replace 0.1.0-verify with 0.1.1-verify, then roll back -- the directory held
      // two 1.4 MB weight files for one artifact id. Only this artifact's own directory is
      // touched, and its contents are a copy of something that still exists in the source.
      rmSync(target, { recursive: true, force: true })
    }
    mkdirSync(target, { recursive: true })
    cpSync(from, target, { recursive: true })

    // Gate 3: re-verify what landed. A partially written copy must not be recorded as
    // installed, because the next launch would load it and generate from a truncated tail.
    const installed = loadArtifact(target)
    if (installed.sha256 !== verified.sha256) {
      rmSync(target, { recursive: true, force: true })
      throw new ModelStoreError(
        `the installed copy hashes to ${installed.sha256}, the source to ${verified.sha256}; the copy was removed`,
        { code: 'copy_mismatch' },
      )
    }

    // Gate 4: record it, with the digest of the bytes on disk.
    const record = this.budget.recordInstall(join(target, installed.manifest.weights.file), {
      category: CATEGORIES.MODEL_WEIGHTS,
      label: installed.manifest.id,
    })
    return {
      id: installed.manifest.id,
      version: installed.manifest.version,
      directory: target,
      // Measured after the copy, so the number describes the device rather than the source.
      bytes: directoryBytes(target),
      sha256: record.sha256,
      storage: this.budget.measure(),
    }
  }

  /**
   * Remove an installed model.
   *
   * Only a directory inside the model library, and only one that is a readable artifact.
   * Anything else is refused with an error rather than removed with a warning.
   */
  remove(id) {
    const entry = this.get(id)
    if (!entry) throw new ModelStoreError(`'${id}' is not installed`, { code: 'not_installed' })
    const directory = resolve(entry.directory)
    if (!directory.startsWith(this.libraryPath + sep)) {
      throw new ModelStoreError(`refusing to remove '${id}': it is outside the model library`, { code: 'outside_library' })
    }
    const freedBytes = directoryBytes(directory)
    rmSync(directory, { recursive: true, force: true })
    return { id, removed: true, freedBytes, storage: this.budget.measure() }
  }

  /** Re-verify every installed model's weights against its manifest. */
  verify(id = null) {
    const targets = id ? [this.get(id)].filter(Boolean) : this.list().filter((entry) => !entry.broken)
    return targets.map((entry) => {
      const manifestPath = findManifest(entry.directory)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const result = this.budget.verifyArtifact(join(entry.directory, manifest.weights.file), {
        bytes: manifest.weights.bytes,
        sha256: manifest.weights.sha256,
      })
      return { id: entry.id, version: entry.version, ok: result.ok, problems: result.problems }
    })
  }

  /**
   * Load an installed model into a runtime, timing the load.
   *
   * loadArtifact re-verifies the digest: a model that was edited on disk after install is
   * refused here rather than served.
   */
  load(id) {
    const entry = this.get(id)
    if (!entry) throw new ModelStoreError(`'${id}' is not installed`, { code: 'not_installed' })
    const started = Date.now()
    let runtime
    try {
      runtime = KlyvaronRuntime.load(entry.directory)
    } catch (error) {
      if (error instanceof ArtifactError) {
        throw new ModelStoreError(`'${id}' failed verification: ${error.message}`, { code: error.code })
      }
      throw error
    }
    return { runtime, loadMs: Date.now() - started, entry }
  }

  /** Regenerable caches only. Present here so a caller uses one storage API, not two. */
  cleanCaches({ dryRun = false } = {}) {
    try {
      return this.budget.clean({ dryRun })
    } catch (error) {
      if (error instanceof StorageBudgetError) throw new ModelStoreError(error.message, { code: error.code })
      throw error
    }
  }
}
