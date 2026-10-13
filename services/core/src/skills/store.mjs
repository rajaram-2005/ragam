// A skill store on disk.
//
// The registry is an in-memory index; this is what survives a restart. Without it a
// "stored procedure" is a procedure that disappears when the service stops, which is what
// the feature matrix was calling Completed while nothing could actually be relied on.
//
// Two files per skill, split deliberately:
//
//   <dir>/<name>.md              the document: the artifact a person reads, reviews and
//                                can edit. Front matter, sections, steps, pitfalls.
//   <dir>/.state.json            ours: state, validation evidence, usage counters, pin and
//                                enable flags, version metadata, and the current version.
//
// Why the split rather than one file: the document is meant to be reviewed by a human, and
// a review that shows usage counters and timestamps changing is a review that stops being
// read. The state file is machine-maintained and says so.
//
//   <dir>/.versions/<name>/<version>.md   every version, so `rollback` works after a
//                                restart and not only within the process that wrote it.
//   <dir>/.deletions.json        names of skills a person deleted, and when. A deletion
//                                removes the procedure; the tombstone records that it
//                                happened, never what it said.
//
// The curator never deletes: archiving is the maximum it may do. `remove()` exists for the
// user's own deletion request, which is a different act by a different actor.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SKILL_STATES } from './registry.mjs'

export const STORE_FORMAT = 'aetheris-skills/v1'

/** Names become file names, so they are held to the stricter of the two rules. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export class SkillStoreError extends Error {
  constructor(message, code = 'skill_store_error') {
    super(message)
    this.name = 'SkillStoreError'
    this.code = code
  }
}

export class SkillStore {
  constructor({ dir, now = () => Date.now() } = {}) {
    if (!dir) throw new SkillStoreError('a skill store needs a directory', 'dir_required')
    this.dir = dir
    this.now = now
    this.stateFile = join(dir, '.state.json')
    this.deletionsFile = join(dir, '.deletions.json')
    mkdirSync(dir, { recursive: true })
  }

  #assertName(name) {
    if (typeof name !== 'string' || !SAFE_NAME.test(name)) {
      throw new SkillStoreError(
        `skill name '${name}' cannot be used as a file name; names are lowercase kebab-case`,
        'invalid_name',
      )
    }
    return name
  }

  documentPath(name) {
    return join(this.dir, `${this.#assertName(name)}.md`)
  }

  versionPath(name, version) {
    return join(this.dir, '.versions', this.#assertName(name), `${String(version)}.md`)
  }

  #readJson(file, fallback) {
    if (!existsSync(file)) return fallback
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed ?? fallback
    } catch (error) {
      throw new SkillStoreError(`'${file}' is not readable JSON: ${error.message}`, 'state_unreadable')
    }
  }

  readState() {
    const document = this.#readJson(this.stateFile, {})
    if (document.format && document.format !== STORE_FORMAT) {
      throw new SkillStoreError(`'${this.stateFile}' is not an aetheris skill store`, 'unrecognised_store')
    }
    return { format: STORE_FORMAT, skills: document.skills ?? {} }
  }

  writeState(state) {
    const payload = { format: STORE_FORMAT, updatedAt: new Date(this.now()).toISOString(), skills: state.skills }
    writeFileSync(this.stateFile, `${JSON.stringify(payload, null, 2)}\n`)
    return payload
  }

  readDeletions() {
    return this.#readJson(this.deletionsFile, { format: STORE_FORMAT, deletions: [] })
  }

  /** Every skill document on disk, oldest first, with anything unreadable reported. */
  list() {
    const files = readdirSync(this.dir).filter((file) => file.endsWith('.md'))
    const skills = []
    const problems = []
    for (const file of files) {
      const name = file.slice(0, -3)
      try {
        skills.push({ name, text: readFileSync(join(this.dir, file), 'utf8') })
      } catch (error) {
        problems.push({ file, reason: error.message })
      }
    }
    return { skills, problems }
  }

  /**
   * Restore everything into a registry.
   *
   * Every version is installed as a candidate, and the saved state is applied afterwards in
   * one step: `validate()` sets the state for the skill rather than for a version, so
   * validating while loading would mark history as verified that never was. Installing
   * history as candidates and then validating the skill says exactly what is true -- these
   * versions exist, and this procedure passed its checks.
   */
  load(registry) {
    const { skills, problems } = this.list()
    const state = this.readState()
    const restored = []
    const failures = [...problems]

    for (const { name, text } of skills) {
      const saved = state.skills[name] ?? null
      try {
        const versions = saved?.versions?.length ? saved.versions.map((entry) => entry.version) : null
        registry.install(text, { state: SKILL_STATES.CANDIDATE, directoryName: name })
        if (versions) {
          for (const version of versions) {
            const file = this.versionPath(name, version)
            if (!existsSync(file)) continue
            const versionText = readFileSync(file, 'utf8')
            try {
              registry.install(versionText, { state: SKILL_STATES.CANDIDATE, directoryName: name })
            } catch (error) {
              // A version that is already present under this name is not a failure: the
              // current document is one of the versions.
              if (error.code !== 'duplicate_version') throw error
            }
          }
        }

        // State is applied after all versions, never during.
        if (saved?.state === SKILL_STATES.VALIDATED && saved.validation?.checks?.length) {
          registry.validate(name, saved.validation)
        } else if (saved?.state && saved.state !== SKILL_STATES.CANDIDATE) {
          registry.install(text, { state: saved.state, directoryName: name })
        }
        if (saved?.usage) registry.restoreUsage(name, saved.usage)
        if (saved?.pinned) registry.setPinned(name, true)
        if (saved?.enabled === false) registry.setEnabled(name, false)
        if (saved?.currentVersion) registry.rollback(name, saved.currentVersion)
        restored.push(name)
      } catch (error) {
        failures.push({ file: `${name}.md`, reason: error.message })
      }
    }

    return { restored, failures }
  }

  /** Write one skill's document, its state, and any version file that is missing. */
  save(registry, name) {
    const record = registry.record(name)
    mkdirSync(join(this.dir, '.versions', name), { recursive: true })
    const current = record.versions.find((version) => version.version === record.currentVersion)
    writeFileSync(this.documentPath(name), current.text)
    for (const version of record.versions) {
      const file = this.versionPath(name, version.version)
      if (!existsSync(file)) writeFileSync(file, version.text)
    }

    const state = this.readState()
    state.skills[name] = {
      state: record.state,
      currentVersion: record.currentVersion,
      validation: record.validation,
      pinned: record.pinned,
      enabled: record.enabled,
      usage: record.usage,
      createdBy: record.createdBy,
      description: record.description,
      tags: record.tags,
      updatedAt: this.now(),
      versions: record.versions.map((version) => ({ version: version.version, digest: version.digest, installedAt: version.installedAt })),
    }
    this.writeState(state)
    return this.documentPath(name)
  }

  saveAll(registry) {
    const written = []
    for (const name of registry.names()) written.push(this.save(registry, name))
    return written
  }

  /**
   * Delete a skill, at a person's request.
   *
   * The curator may only archive; this is the user's own deletion, so it removes the
   * procedure and leaves a tombstone that records the act and not the content. The version
   * files go with it: leaving them would be a deletion that did not delete.
   */
  remove(registry, name, { reason = null, requestedBy = 'user' } = {}) {
    this.#assertName(name)
    const document = this.documentPath(name)
    const versions = join(this.dir, '.versions', name)
    const existed = existsSync(document) || existsSync(versions)
    if (existsSync(document)) rmSync(document)
    if (existsSync(versions)) rmSync(versions, { recursive: true, force: true })

    const state = this.readState()
    const previous = state.skills[name] ?? null
    delete state.skills[name]
    this.writeState(state)

    const ledger = this.readDeletions()
    ledger.deletions = ledger.deletions ?? []
    ledger.deletions.push({
      name,
      deletedAt: new Date(this.now()).toISOString(),
      reason,
      requestedBy,
      // Counts, never content: how much procedure was removed, not what it said.
      versionsRemoved: previous?.versions?.length ?? 0,
      existed,
    })
    writeFileSync(this.deletionsFile, `${JSON.stringify({ format: STORE_FORMAT, deletions: ledger.deletions }, null, 2)}\n`)

    if (registry.record(name, { optional: true })) registry.forget(name)
    return { deleted: existed, name, versionsRemoved: previous?.versions?.length ?? 0 }
  }

  deletions() {
    return this.readDeletions().deletions ?? []
  }
}
