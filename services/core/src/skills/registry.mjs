// The skill registry: versioned procedural memory with usage telemetry.
//
// Directive §6B: "Build a skill system that stores successful procedures, not just
// factual summaries." §6C: "Track skill versions, tests, provenance and performance.
// Retain the ability to roll back a harmful change."
//
// A skill is NOT a conversation summary and NOT a memory. It is a named procedure with
// prerequisites, numbered steps, and a verification section -- the difference matters,
// because a summary cannot be executed and therefore cannot be tested.
//
// WHY USAGE TELEMETRY IS PART OF THE DATA MODEL
//
// Directive §6C: "Do not preserve a skill simply because it was created. Retire or
// revise skills that are inaccurate, unsafe, outdated or unhelpful." Deciding that
// needs evidence, so the registry records `useCount`, `viewCount`, `patchCount` and
// `lastActivityAt` for every skill, and the lifecycle (lifecycle.mjs) moves skills
// between states on thresholds over that data. Adoption note: this mirrors Hermes
// Agent's `.usage.json` and its active/stale/archived states.
//
// STATES
//
//   candidate  proposed from experience, NOT YET USABLE. Cannot be loaded.
//   validated  passed validation against recorded evidence. Usable.
//   stale      validated but unused beyond a threshold. Still usable, flagged.
//   archived   retired. Not loaded automatically; restorable, never deleted.
//
// `candidate` not being loadable is the directive's requirement that a lesson be
// verified before reuse: "learn from experience, verify the lesson, test its
// generality, then reuse it safely."

import { createHash } from 'node:crypto'
import { SkillDocumentError, loadSkillDocument, parseSections, parseFrontmatter } from './manifest.mjs'
import { Bm25Index } from '../knowledge/bm25.mjs'

export const SKILL_STATES = Object.freeze({
  CANDIDATE: 'candidate',
  VALIDATED: 'validated',
  STALE: 'stale',
  ARCHIVED: 'archived',
})

/** States a skill can be loaded from. A candidate is deliberately absent. */
export const LOADABLE_STATES = Object.freeze([SKILL_STATES.VALIDATED, SKILL_STATES.STALE])

export class SkillRegistryError extends Error {
  constructor(message, code = 'skill_registry_error') {
    super(message)
    this.name = 'SkillRegistryError'
    this.code = code
  }
}

const digestOf = (text) => createHash('sha256').update(String(text)).digest('hex')

export class SkillRegistry {
  #skills = new Map()

  constructor({ now = () => Date.now() } = {}) {
    this.now = now
  }

  /**
   * Install a skill document.
   *
   * Provenance is required, not optional: the lifecycle can only act on a skill whose
   * origin it knows, and an agent-created skill must be distinguishable from one a
   * human wrote. A missing `createdBy` is rejected by the document validator.
   */
  install(text, { state = SKILL_STATES.CANDIDATE, evidence = null, directoryName = null } = {}) {
    const report = loadSkillDocument(text, { directoryName })
    const name = report.frontmatter.name

    if (!Object.values(SKILL_STATES).includes(state)) {
      throw new SkillRegistryError(`unknown state '${state}'`, 'unknown_state')
    }
    if (state === SKILL_STATES.VALIDATED && !evidence) {
      throw new SkillRegistryError(
        `cannot install '${name}' as validated without evidence; a skill that was never ` +
        'verified is a candidate',
        'evidence_required',
      )
    }

    const version = String(report.frontmatter.version)
    const entry = {
      version,
      text,
      digest: digestOf(text),
      installedAt: this.now(),
      sections: [...report.sections.keys()],
      procedureSteps: report.procedureSteps,
    }

    const existing = this.#skills.get(name)
    if (existing) {
      // A new version of a known skill. History is append-only, which is what makes
      // rollback possible; the record is never rewritten in place.
      if (existing.versions.some((v) => v.version === version)) {
        throw new SkillRegistryError(`skill '${name}' already has a version ${version}`, 'duplicate_version')
      }
      existing.versions.push(entry)
      existing.currentVersion = version
      existing.updatedAt = this.now()
      existing.patchCount += 1
      if (state === SKILL_STATES.VALIDATED) {
        existing.state = SKILL_STATES.VALIDATED
        existing.validation = { ...evidence, at: this.now() }
      }
      return this.describe(name)
    }

    this.#skills.set(name, {
      name,
      createdBy: report.frontmatter.createdBy,
      license: report.frontmatter.license,
      author: report.frontmatter.author ?? null,
      platforms: report.frontmatter.platforms ?? [],
      tags: report.frontmatter.metadata?.aetheris?.tags ?? report.frontmatter.tags ?? [],
      description: report.frontmatter.description,
      versions: [entry],
      currentVersion: version,
      // Pinning exempts a skill from every automatic transition. A human who pins a
      // procedure is saying "this one is load-bearing"; the curator must not touch it.
      pinned: false,
      enabled: true,
      state,
      validation: evidence ? { ...evidence, at: this.now() } : null,
      usage: { useCount: 0, viewCount: 0, patchCount: 0, lastActivityAt: null },
      patchCount: 0,
      installedAt: this.now(),
      updatedAt: this.now(),
    })
    return this.describe(name)
  }

  /** A serialisable view. The stored document text is returned only by `document()`. */
  describe(name) {
    const skill = this.#require(name)
    return {
      name: skill.name,
      version: skill.currentVersion,
      description: skill.description,
      createdBy: skill.createdBy,
      author: skill.author,
      license: skill.license,
      platforms: skill.platforms,
      tags: skill.tags,
      state: skill.state,
      pinned: skill.pinned,
      enabled: skill.enabled,
      loadable: LOADABLE_STATES.includes(skill.state) && skill.enabled,
      usage: { ...skill.usage },
      validation: skill.validation,
      versionCount: skill.versions.length,
      procedureSteps: skill.versions.at(-1).procedureSteps,
      // The section titles of the current version. Also exposed here rather than only
      // inside `load()`, whose Map serialises to `{}` over HTTP and would have shipped a
      // client an empty object where a list was promised.
      sections: skill.versions.at(-1).sections ?? [],
      digest: skill.versions.at(-1).digest,
    }
  }

  list({ state = null, createdBy = null, loadableOnly = false, tag = null } = {}) {
    return [...this.#skills.values()]
      .filter((s) => !state || s.state === state)
      .filter((s) => !createdBy || s.createdBy === createdBy)
      .filter((s) => !loadableOnly || (LOADABLE_STATES.includes(s.state) && s.enabled))
      .filter((s) => !tag || s.tags.includes(tag))
      .map((s) => this.describe(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Load a skill for use in a task.
   *
   * Refuses a candidate. This is the enforcement point for "verify the lesson before
   * reusing it": an unverified lesson that is loadable is an unverified lesson that
   * will be used, and the whole point of the candidate state is that it cannot be.
   */
  load(name, { reason = 'task' } = {}) {
    const skill = this.#require(name)
    if (!skill.enabled) {
      throw new SkillRegistryError(`skill '${name}' is disabled`, 'skill_disabled')
    }
    if (!LOADABLE_STATES.includes(skill.state)) {
      throw new SkillRegistryError(
        skill.state === SKILL_STATES.CANDIDATE
          ? `skill '${name}' is a candidate and has not been validated; it cannot be loaded until it passes verification`
          : `skill '${name}' is ${skill.state} and is not loaded automatically`,
        'skill_not_loadable',
      )
    }
    skill.usage.viewCount += 1
    skill.usage.lastActivityAt = this.now()
    const current = skill.versions.find((v) => v.version === skill.currentVersion)
    return {
      name: skill.name,
      version: skill.currentVersion,
      description: skill.description,
      platforms: skill.platforms,
      text: current.text,
      sections: parseSections(current.text.slice(current.text.indexOf('---', 3) + 3)).sections,
      state: skill.state,
      loadedFor: reason,
    }
  }

  document(name, version = null) {
    const skill = this.#require(name)
    const found = version ? skill.versions.find((v) => v.version === version) : skill.versions.at(-1)
    if (!found) throw new SkillRegistryError(`skill '${name}' has no version ${version}`, 'unknown_version')
    return found.text
  }

  /** Record that a skill was used. Called by the executor, not by the skill itself. */
  recordUsage(name, { kind = 'use' } = {}) {
    const skill = this.#require(name)
    if (kind === 'use') skill.usage.useCount += 1
    else if (kind === 'view') skill.usage.viewCount += 1
    else if (kind === 'patch') skill.usage.patchCount += 1
    else throw new SkillRegistryError(`unknown usage kind '${kind}'`, 'unknown_usage_kind')
    skill.usage.lastActivityAt = this.now()
    return this.describe(name)
  }

  /** Promote a candidate to validated. Requires evidence; see lifecycle.mjs. */
  validate(name, evidence) {
    const skill = this.#require(name)
    if (!evidence || !evidence.checks || !evidence.checks.length) {
      throw new SkillRegistryError(
        `validating '${name}' requires evidence with at least one check result`,
        'evidence_required',
      )
    }
    const failures = evidence.checks.filter((c) => c.passed !== true)
    if (failures.length) {
      throw new SkillRegistryError(
        `cannot validate '${name}': ${failures.length} of ${evidence.checks.length} checks did not pass ` +
        `(${failures.map((c) => c.name).join(', ')})`,
        'validation_failed',
      )
    }
    skill.state = SKILL_STATES.VALIDATED
    skill.validation = { ...evidence, at: this.now() }
    skill.updatedAt = this.now()
    return this.describe(name)
  }

  /**
   * Apply the flags a person controls, in one step.
   *
   * Only these two are settable, and an unknown key is an error rather than a silent no-op:
   * a caller that tries to set `state` here has confused a person's decision with the
   * evidence-based promotion path, and saying so is better than quietly ignoring it.
   */
  update(name, changes = {}) {
    const allowed = ['pinned', 'enabled']
    const unknown = Object.keys(changes).filter((key) => !allowed.includes(key) && changes[key] !== undefined)
    if (unknown.length) {
      throw new SkillRegistryError(
        `only ${allowed.join(' and ')} can be set directly; '${unknown.join(', ')}' is not a setting ` +
        '(state changes go through validate/retire/restore, which carry evidence or a reason)',
        'not_a_setting',
      )
    }
    if (changes.pinned !== undefined) this.setPinned(name, changes.pinned)
    if (changes.enabled !== undefined) this.setEnabled(name, changes.enabled)
    return this.describe(name)
  }

  setPinned(name, pinned) {
    const skill = this.#require(name)
    skill.pinned = Boolean(pinned)
    return this.describe(name)
  }

  setEnabled(name, enabled) {
    const skill = this.#require(name)
    skill.enabled = Boolean(enabled)
    return this.describe(name)
  }

  /** Roll back to a previous version. History is never discarded. */
  rollback(name, version) {
    const skill = this.#require(name)
    if (!skill.versions.some((v) => v.version === version)) {
      throw new SkillRegistryError(`skill '${name}' has no version ${version} to roll back to`, 'unknown_version')
    }
    skill.currentVersion = version
    skill.updatedAt = this.now()
    // A rolled-back skill is usable again, but its state is reset to validated rather
    // than left stale/archived: something about it was wrong and it was corrected.
    if (skill.state === SKILL_STATES.ARCHIVED) skill.state = SKILL_STATES.VALIDATED
    return this.describe(name)
  }

  stats() {
    const all = [...this.#skills.values()]
    const byState = {}
    for (const state of Object.values(SKILL_STATES)) byState[state] = all.filter((s) => s.state === state).length
    return {
      total: all.length,
      byState,
      pinned: all.filter((s) => s.pinned).length,
      agentCreated: all.filter((s) => s.createdBy === 'agent').length,
      totalUses: all.reduce((sum, s) => sum + s.usage.useCount, 0),
    }
  }

  /** Internal accessor for the lifecycle module. Not part of the public surface. */
  record(name, { optional = false } = {}) {
    if (optional && !this.#skills.has(name)) return null
    return this.#require(name)
  }

  /**
   * Drop a skill from the in-memory index.
   *
   * Only the store calls this, and only after a person asked for a deletion and the
   * document is already gone from disk. The curator has no path here: its maximum is
   * archive, which is a state rather than a removal.
   */
  forget(name) {
    return this.#skills.delete(name)
  }

  /**
   * Restore usage counters from a store.
   *
   * The curator decides what is stale from use counts and last-activity times, so losing
   * them on every restart would make an unused skill indistinguishable from one that is
   * used daily -- and would archive the wrong one. Values are coerced to non-negative
   * integers rather than trusted.
   */
  restoreUsage(name, usage = {}) {
    const skill = this.#require(name)
    const count = (value) => Math.max(0, Math.trunc(Number(value) || 0))
    skill.usage = {
      useCount: count(usage.useCount),
      viewCount: count(usage.viewCount),
      patchCount: count(usage.patchCount),
      lastActivityAt: Number.isFinite(Number(usage.lastActivityAt)) ? Number(usage.lastActivityAt) : null,
    }
    return { ...skill.usage }
  }

  /**
   * The skills relevant to a query, for progressive disclosure.
   *
   * A skill costs context, so the listing is deliberately built from the short fields --
   * name, description, tags, when-to-use -- and not from the procedure. The Hermes audit
   * recorded why descriptions are capped at 60 characters: long ones bloat listings and
   * dilute attention when many are considered at once. This is where that cap pays off.
   *
   * Ranking is lexical, and the caller is told the ranking method rather than being left to
   * assume it was semantic. Only loadable skills are returned, because a candidate that
   * influenced a task would be a procedure that was never verified.
   */
  match(query, { limit = 5, includeUnvalidated = false } = {}) {
    const text = String(query ?? '').trim()
    if (!text) return { query: text, method: 'none', matches: [], reason: 'empty query' }
    const considered = this.list({ loadableOnly: !includeUnvalidated })
    if (!considered.length) {
      return { query: text, method: 'bm25', matches: [], considered: 0, reason: 'no loadable skills' }
    }
    const index = new Bm25Index()
    for (const skill of considered) {
      const record = this.#require(skill.name)
      const current = record.versions.find((version) => version.version === record.currentVersion)
      const whenToUse = /## When to Use\s*\n+([^\n]+)/.exec(current.text)?.[1] ?? ''
      index.add(skill.name, [skill.name, skill.description, (skill.tags ?? []).join(' '), whenToUse].join(' '))
    }
    const matches = index.search(text, { topK: limit }).map((hit) => {
      const skill = this.describe(hit.docId)
      return { ...skill, score: hit.score, matchedTerms: hit.matchedTerms }
    })
    return { query: text, method: 'bm25', considered: considered.length, matches }
  }

  /** The set of names, for the lifecycle to iterate without copying records. */
  names() {
    return [...this.#skills.keys()]
  }

  toJSON() {
    return { skills: this.list(), stats: this.stats() }
  }

  #require(name) {
    const skill = this.#skills.get(name)
    if (!skill) throw new SkillRegistryError(`no skill named '${name}'`, 'unknown_skill')
    return skill
  }
}

export { parseFrontmatter, SkillDocumentError }
