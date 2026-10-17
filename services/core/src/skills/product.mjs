// The product surface for skills: durable documents, a review gate, versions and a chat use.
//
// The library (registry, store, lifecycle) already refuses to load a candidate, keeps every
// version and stores a permission declaration. This module does not reimplement those rules; it
// puts them behind routes and makes the one use the product actually has explicit:
//
//   a validated, text-only procedure may be selected for one chat message. Its text is sent as
//   reference material, never executed, and a procedure that declares file or network access is
//   refused because this product has no executor to grant it.
//
// Validation here is a **structural review**, not a measured improvement: the document parses,
// the procedure has steps, the scope was declared and is not unrestricted. The evidence says
// exactly that, and the UI repeats it. Calling this "training" would be false.

import { failure } from '../online/failure.mjs'
import { buildDescription, renderSkillDocument } from './lifecycle.mjs'
import { SkillRegistry, SKILL_STATES } from './registry.mjs'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SkillStore } from './store.mjs'
import { MeasureError, buildRecord, scoreText, validateCases } from './measure.mjs'

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/
const VERSION = /^\d+\.\d+\.\d+$/
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/

const BUILTINS = Object.freeze([
  {
    name: 'evidence-first-answer',
    description: 'Answer from the supplied evidence, name what is missing and never invent a source',
    whenToUse: 'When the answer depends on documents, memories or a retrieved passage and a wrong citation would be worse than an admitted gap.',
    tags: ['answers', 'evidence', 'honesty'],
    steps: [
      'Separate what the supplied evidence states from what you know independently; label the second part.',
      'Attach the source name or citation to every factual claim that came from the evidence.',
      'If the evidence does not answer the question, say which part is missing instead of filling it in.',
      'End with the weakest link in the answer: what a reader should verify before acting on it.',
    ],
    pitfalls: ['A confident answer with no source is worse than a short one with a named gap.'],
    verification: 'The answer names a source for each evidence-backed claim and states the gap when there is one.',
    version: '1.0.0',
  },
  {
    name: 'incident-triage',
    description: 'Separate observed facts from hypotheses and propose one reversible next step',
    whenToUse: 'When something is failing and the cause is not yet known; the goal is to learn, not to restart everything.',
    tags: ['incident', 'diagnosis', 'operations'],
    steps: [
      'List the observed facts with where each came from (log line, status code, command output).',
      'List hypotheses separately and mark each as untested; never present a hypothesis as a cause.',
      'Choose the cheapest diagnostic that would distinguish the leading hypotheses.',
      'State the proposed action, its blast radius and the rollback before anyone performs it.',
    ],
    pitfalls: ['A restart destroys the evidence that would have explained the failure.', 'A destructive fix without a rollback is not a diagnostic step.'],
    verification: 'Facts and hypotheses are separated, and the next step names its rollback.',
    version: '1.0.0',
  },
  {
    name: 'release-audit',
    description: 'Check a release against its own claims and list what remains unverified',
    whenToUse: 'Before calling a version released, shipped or complete.',
    tags: ['release', 'audit', 'verification'],
    steps: [
      'Compare the stated version in the package files, the changelog and the artefact; name any mismatch.',
      'Run the suites and compare the totals with the numbers the documents state.',
      'List every claim in the release note that a test does not exercise, especially vendor or live-service claims.',
      'Report what passed, what failed and what was not attempted; do not convert "not attempted" into "passed".',
    ],
    pitfalls: ['A document can agree with itself and disagree with the code.', 'A fixture is not a vendor call.'],
    verification: 'The audit lists measured passes, measured failures and unverified claims separately.',
    version: '1.0.0',
  },
])

const emptyPermissions = (value) => !value || ((value.fsRead ?? []).length === 0 && (value.fsWrite ?? []).length === 0 && value.network !== true)

/**
 * Structural checks, named so the evidence record says what was actually reviewed. None of them
 * claims the procedure improved a task; that would require a measured comparison this service
 * does not perform.
 */
function structuralChecks(described) {
  const permissions = described.permissions ?? {}
  return {
    source: 'structural-review',
    note: 'The document and its declared scope were checked. This is not a measured improvement on a task.',
    checks: [
      { name: 'document parses and names a kebab-case skill', passed: true },
      { name: 'procedure has at least two steps', passed: described.procedureSteps >= 2 },
      { name: 'scope is declared', passed: permissions !== null && typeof permissions === 'object' },
      { name: 'network access is not requested', passed: permissions.network !== true },
    ],
  }
}

export class SkillService {
  constructor({ dir, now = () => Date.now() } = {}) {
    if (!dir) throw new TypeError('SkillService requires a directory')
    this.store = new SkillStore({ dir, now })
    this.registry = new SkillRegistry({ now })
    this.loadReport = this.store.load(this.registry)
    this.measurementsFile = join(this.store.dir, 'measurements.jsonl')
    this.seeded = []
    this.#seed()
  }

  #seed() {
    // A built-in is installed once. A deletion tombstone wins: the user removed it, and a restart
    // is not an occasion to put it back.
    const deleted = new Set((this.store.deletions() ?? []).map((entry) => entry.name))
    for (const builtin of BUILTINS) {
      if (deleted.has(builtin.name) || this.registry.names().includes(builtin.name)) continue
      const document = renderSkillDocument({
        ...builtin,
        description: buildDescription(builtin.description),
        createdBy: 'bundled',
        author: 'Aetheris',
        permissions: { fsRead: [], fsWrite: [], network: false },
      })
      this.registry.install(document, { state: SKILL_STATES.CANDIDATE, directoryName: builtin.name })
      this.registry.validate(builtin.name, structuralChecks(this.registry.describe(builtin.name)))
      this.store.save(this.registry, builtin.name)
      this.seeded.push(builtin.name)
    }
  }

  /** Everything a reader needs to decide whether to use a procedure. Never a secret. */
  list() {
    return {
      skills: this.registry.list(),
      stats: this.registry.stats(),
      failures: this.loadReport.failures,
      note: 'A validated skill passed a structural review and can be selected for one message. Its text is reference material; it is not executed and it is not training.',
    }
  }

  require(name) {
    if (typeof name !== 'string' || !NAME.test(name) || !this.registry.names().includes(name)) {
      throw failure('skill_not_found', 'No such skill on this installation.', 404)
    }
    return name
  }

  describe(name) {
    this.require(name)
    const described = this.registry.describe(name)
    // `document(name)` without a version returns the newest version, not the current one. After a
    // rollback those differ, and showing the newest text under the rolled-back version number would
    // misrepresent what a selection would send.
    return { ...described, document: this.registry.document(name, described.version), versions: this.versions(name), measurements: this.measurements(name, { limit: 3 }) }
  }

  /** Install a reviewed procedure from structured fields; the server renders the document. */
  install(input = {}, { actor } = {}) {
    if (!actor) throw failure('unauthenticated', 'Sign in to install a skill.', 401)
    const name = input.name
    if (typeof name !== 'string' || !NAME.test(name)) throw failure('invalid_skill', 'A skill name is lowercase kebab-case, up to 63 characters.', 400)
    if (typeof input.description !== 'string' || !input.description.trim() || input.description.length > 200) throw failure('invalid_skill', 'Describe the procedure in one sentence (up to 200 characters).', 400)
    if (typeof input.whenToUse !== 'string' || !input.whenToUse.trim() || input.whenToUse.length > 2000) throw failure('invalid_skill', 'State when to use the procedure (up to 2,000 characters).', 400)
    if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 20) throw failure('invalid_skill', 'A procedure needs 2 to 20 steps.', 400)
    if (input.steps.some((step) => typeof step !== 'string' || !step.trim() || step.length > 500)) throw failure('invalid_skill', 'Every step must be a nonempty line of at most 500 characters.', 400)
    const pitfalls = input.pitfalls ?? []
    if (!Array.isArray(pitfalls) || pitfalls.length > 10 || pitfalls.some((p) => typeof p !== 'string' || p.length > 300)) throw failure('invalid_skill', 'Pitfalls are up to 10 lines of at most 300 characters.', 400)
    if (typeof input.verification !== 'string' || !input.verification.trim() || input.verification.length > 1000) throw failure('invalid_skill', 'State how a reader verifies the procedure was followed (up to 1,000 characters).', 400)
    const tags = input.tags ?? []
    if (!Array.isArray(tags) || tags.length > 8 || tags.some((tag) => typeof tag !== 'string' || !TAG.test(tag))) throw failure('invalid_skill', 'Tags are up to eight lowercase words.', 400)
    const version = input.version ?? '1.0.0'
    if (typeof version !== 'string' || !VERSION.test(version)) throw failure('invalid_skill', 'Version must look like 1.0.0.', 400)

    const document = renderSkillDocument({
      name,
      description: buildDescription(input.description),
      version,
      createdBy: 'human',
      author: actor,
      tags,
      whenToUse: input.whenToUse.trim(),
      steps: input.steps.map((step) => step.trim()),
      pitfalls: pitfalls.map((line) => line.trim()),
      verification: input.verification.trim(),
      // The chat path cannot execute file or network access, so a product-installed procedure
      // declares none. A document from elsewhere may declare more; it is stored, but chat refuses
      // to select it until an executor exists to grant the scope.
      permissions: { fsRead: [], fsWrite: [], network: false },
    })
    const existed = this.registry.names().includes(name)
    this.registry.install(document, { state: SKILL_STATES.CANDIDATE, directoryName: name })
    if (existed) {
      // A new version of a validated skill is a candidate again. The library keeps the old state
      // when a version is appended; that would let an unreviewed change inherit a review it never
      // had, which is the one thing the candidate state exists to prevent.
      const record = this.registry.record(name)
      record.state = SKILL_STATES.CANDIDATE
      record.validation = null
      record.updatedAt = Date.now()
    }
    this.store.save(this.registry, name)
    return this.describe(name)
  }

  validate(name) {
    this.require(name)
    const before = this.registry.describe(name)
    const evidence = structuralChecks(before)
    const failed = evidence.checks.filter((check) => !check.passed)
    if (failed.length) {
      throw failure('skill_validation_failed', `Cannot validate: ${failed.map((check) => check.name).join(', ')}.`, 409)
    }
    this.registry.validate(name, evidence)
    this.store.save(this.registry, name)
    return this.describe(name)
  }

  setSetting(name, { enabled, pinned } = {}) {
    this.require(name)
    if (enabled !== undefined && typeof enabled !== 'boolean') throw failure('invalid_skill', 'enabled must be true or false.', 400)
    if (pinned !== undefined && typeof pinned !== 'boolean') throw failure('invalid_skill', 'pinned must be true or false.', 400)
    this.registry.update(name, { ...(enabled !== undefined ? { enabled } : {}), ...(pinned !== undefined ? { pinned } : {}) })
    this.store.save(this.registry, name)
    return this.describe(name)
  }

  rollback(name, version) {
    this.require(name)
    const described = this.registry.rollback(name, version)
    this.store.save(this.registry, name)
    return { ...described, document: this.registry.document(name, described.version), versions: this.versions(name), measurements: this.measurements(name, { limit: 3 }) }
  }

  remove(name, reason = null) {
    this.require(name)
    this.store.remove(this.registry, name, { reason, requestedBy: 'user' })
    return { removed: true, name }
  }

  /** Every stored version, newest last. A reader needs the list before choosing a baseline. */
  versions(name) {
    this.require(name)
    return this.registry.record(name).versions.map(({ version, installedAt, digest }) => ({ version, installedAt, digest }))
  }

  /**
   * Past measurements, newest first. The log is append-only; an unreadable line is skipped rather
   * than allowed to take the whole list down, because a partial record is still evidence.
   */
  measurements(name, { limit = 20 } = {}) {
    this.require(name)
    if (!existsSync(this.measurementsFile)) return []
    const records = []
    for (const line of readFileSync(this.measurementsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record.name === name) records.push(record)
      } catch { /* a torn line is not a measurement */ }
    }
    return records.reverse().slice(0, limit)
  }

  /**
   * Measure two versions on the same cases through a caller-supplied runner.
   *
   * The service does not know which provider answered, and it does not need to: it owns the
   * comparison, the deterministic scoring and the record. The caller owns the provider call, its
   * consent and its cost. Prompts are not written to the record; a digest identifies the case.
   */
  async measure(name, { baselineVersion, candidateVersion, cases, run, by = 'owner' } = {}) {
    this.require(name)
    if (typeof run !== 'function') throw failure('invalid_measurement', 'A measurement needs a provider call.', 400)
    const known = new Set(this.versions(name).map((entry) => entry.version))
    if (!known.has(baselineVersion)) throw failure('skill_not_found', `No version ${baselineVersion} of '${name}'.`, 404)
    if (!known.has(candidateVersion)) throw failure('skill_not_found', `No version ${candidateVersion} of '${name}'.`, 404)
    if (baselineVersion === candidateVersion) throw failure('invalid_measurement', 'Choose two different versions to compare.', 400)
    let normalised
    try { normalised = validateCases(cases) } catch (error) {
      if (error instanceof MeasureError) throw failure('invalid_measurement', error.message, 400)
      throw error
    }
    const textFor = (version) => this.registry.document(name, version)
    const caseResults = []
    for (const entry of normalised) {
      const measured = {}
      for (const version of [baselineVersion, candidateVersion]) {
        const started = Date.now()
        const answered = await run({ system: textFor(version), prompt: entry.prompt })
        const latencyMs = Number.isFinite(answered?.latencyMs) ? answered.latencyMs : Date.now() - started
        const text = answered?.text
        if (typeof text !== 'string' || !text) throw failure('invalid_completion', 'The provider returned no text for a measurement case.', 502)
        const usage = answered?.usage ?? null
        const tokens = usage?.totalTokens ?? usage?.total_tokens ?? null
        measured[version] = {
          version,
          text,
          latencyMs,
          tokens: Number.isFinite(tokens) ? tokens : null,
          ...scoreText(text, entry),
        }
      }
      // compareRuns identifies a regression by case id; the two runs are stored side by side so
      // the record can show which check failed rather than only the aggregate.
      caseResults.push({
        id: entry.id,
        prompt: entry.prompt,
        mustInclude: entry.mustInclude,
        mustExclude: entry.mustExclude,
        baseline: measured[baselineVersion],
        candidate: measured[candidateVersion],
      })
    }
    const record = buildRecord({ name, baselineVersion, candidateVersion, cases: normalised, caseResults, by })
    appendFileSync(this.measurementsFile, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return record
  }

  /**
   * The one chat use: a validated, enabled, text-only procedure. Returns its text as reference
   * material for the model. Nothing declared in the document is executed, and usage is not
   * counted until the provider call actually succeeds.
   */
  prepareForChat(name) {
    if (typeof name !== 'string' || !NAME.test(name)) throw failure('invalid_skill', 'Choose a skill by name.', 400)
    if (!this.registry.names().includes(name)) throw failure('skill_not_found', 'No such skill on this installation.', 404)
    const described = this.registry.describe(name)
    if (!described.enabled) throw failure('skill_disabled', 'That procedure is disabled.', 409)
    if (described.state !== SKILL_STATES.VALIDATED) throw failure('skill_not_validated', 'That procedure has not passed its review; it cannot be used yet.', 409)
    if (!emptyPermissions(described.permissions)) {
      throw failure('skill_requires_executor', 'This procedure declares file or network access. Chat cannot grant it, so it cannot be selected here.', 409)
    }
    return { name: described.name, version: described.version, text: this.registry.document(name, described.version), permissions: described.permissions }
  }

  /** Called after the provider answered, not when the user selected the skill. */
  recordUse(name) {
    this.registry.recordUsage(name, { kind: 'use' })
    this.store.save(this.registry, name)
  }
}
