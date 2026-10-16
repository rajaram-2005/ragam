// The loop: OBSERVE -> RECORD -> EVALUATE -> DIAGNOSE -> PROPOSE -> TEST -> APPROVE ->
// VERSION -> REUSE.
//
// Each arrow is a function here, and the two that matter most are the ones that can say no:
//
//   * **PROPOSE refuses to run on anything but a verified success.** A procedure extracted
//     from a run that failed, or from one nobody checked, is a procedure that encodes a
//     mistake. The refusal is the feature.
//   * **APPROVE is not the proposer's decision.** Promotion goes through the skills
//     registry's `validate()`, which requires evidence whose checks all passed. This module
//     supplies measurements; it cannot mark its own homework, and the registry rejects a
//     validation that arrives without passing checks.
//
// The stored skill is a *versioned* artifact -- the registry keeps an append-only version
// history, so REUSE can roll back to a previous version and the rollback is a recorded event
// rather than a deletion.
//
// Nothing here trains anything. Adaptation is memory, measurement, testing and selection:
// the weights of whatever model a future phase routes to are untouched by this file.

import { SKILL_STATES } from '../skills/registry.mjs'
import { proposeFromExperience } from '../skills/lifecycle.mjs'
import { EvaluationLog, VERDICTS, evaluateCandidate } from '../skills/evaluation.mjs'
import { describePermissions, effectivePermissions } from '../skills/permissions.mjs'
import { validateCapability } from './capability.mjs'
import {
  EpisodeLog, OUTCOMES, classifyOutcome, diagnose, evaluateAcceptance,
} from './episodes.mjs'
import { routeTask } from './router.mjs'
import { verifyLineCount } from './verify.mjs'

export const DEFAULT_SAMPLES = 3

export class LoopError extends Error {
  constructor(message, code = 'loop_error', detail = {}) {
    super(message)
    this.name = 'LoopError'
    this.code = code
    this.detail = detail
  }
}

/** Median of the runs, which is the number reported -- not the mean, which a single slow run skews. */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Time one invocation. Wall clock, `performance.now()`, on this machine, now.
 * The measurement is returned with the result so the episode can carry both.
 */
export function timeInvocation(fn, timer = () => performance.now()) {
  const started = timer()
  const value = fn()
  return { value, ms: Math.round((timer() - started) * 1000) / 1000 }
}

export class AdaptiveLoop {
  /**
   * @param {object} options
   * @param {object} options.registry  a SkillRegistry (skills/registry.mjs)
   * @param {EpisodeLog} [options.episodes]
   * @param {number} [options.samples] runs per candidate when measuring cost
   */
  constructor({ registry, episodes = null, evaluations = null, samples = DEFAULT_SAMPLES, ledger = null, now = () => Date.now(), timer = () => performance.now() }) {
    if (!registry) throw new LoopError('the loop needs a skill registry', 'no_registry')
    this.registry = registry
    this.episodes = episodes ?? new EpisodeLog(':memory:')
    // Where every candidate's verdict is recorded, including -- especially -- the rejections.
    // A caller can hand in a file-backed log; the default is per-process so a test needs no
    // filesystem, and it is never `null`, because "no evaluation log" would be a way to promote
    // a version that was never evaluated.
    this.evaluations = evaluations ?? new EvaluationLog(':memory:')
    this.samples = samples
    this.ledger = ledger
    this.now = now
    // Injectable so that the *method* of measuring -- how many runs each candidate gets, and in
    // what order -- is testable with a scripted clock instead of by hoping the machine is slow
    // enough for the difference to show up in wall-clock time.
    this.timer = timer
    /** Measured costs, keyed by candidate id and the input they were measured on. */
    this.measurements = new Map()
  }

  #record(category, action, outcome, detail) {
    // The audit ledger is optional so the loop can run in a test without a database, and it
    // is used when present because a routing decision someone has to justify later belongs in
    // the same ledger as every other consequential decision.
    this.ledger?.record?.({ category, action, outcome, actor: 'adaptive-loop', subject: detail?.subject ?? null, detail })
  }

  /**
   * OBSERVE + RECORD: measure what each candidate costs on this exact input.
   *
   * Measurement is separated from execution because the router needs the numbers *before*
   * choosing, and because a number produced by a warm-up run is a number the chosen route's
   * later timings can be compared against honestly.
   */
  measure({ candidates, task, runs = this.samples }) {
    const input = `${task.root}:${(task.extensions ?? []).join(',')}`
    const measured = []

    // Rounds, not candidates, are the outer loop: every candidate is measured once per round and
    // the round repeats `runs` times. Measuring one candidate to completion before starting the
    // next gives whoever is first the coldest page cache and hands the disadvantage to position
    // in an array -- a routing decision decided by argument order. (Checked before changing it:
    // on a 3.6 MB tree the gap between the two line counters is 1.3-1.5x either way, so ordering
    // was not what decided that comparison. It is still the right way to measure.)
    const slots = candidates.map((descriptor) => ({ descriptor, times: [], last: null }))
    for (let round = 0; round < runs; round += 1) {
      for (const slot of slots) {
        const { value, ms } = timeInvocation(() => slot.descriptor.invoke({ ...task, detail: false }), this.timer)
        slot.times.push(ms)
        slot.last = value
      }
    }

    for (const { descriptor, times, last } of slots) {
      const medianMs = median(times)
      // The cost lives on the descriptor, so a candidate that has been measured anywhere is
      // routable on its measurement rather than on its author's estimate.
      const withCost = validateCapability({
        ...descriptor,
        cost: {
          measured: { medianMs, samples: times.length, input, at: new Date(this.now()).toISOString() },
          arithmetic: { files: last.files, bytes: last.bytes },
        },
      })
      this.measurements.set(`${descriptor.id}@${input}`, withCost)
      measured.push({ id: descriptor.id, medianMs, samples: times.length, lines: last.lines, files: last.files, bytes: last.bytes, times })
    }
    // The order the candidates were measured in is recorded, because it is part of the method.
    return { input, runs, measured, order: candidates.map((c) => c.id) }
  }

  /** Cost-bearing copies of the candidates, or the candidates themselves when unmeasured. */
  #withCosts(candidates, task) {
    const input = `${task.root}:${(task.extensions ?? []).join(',')}`
    return candidates.map((descriptor) => this.measurements.get(`${descriptor.id}@${input}`) ?? descriptor)
  }

  /**
   * One full pass: route, execute, verify, evaluate acceptance, classify, record.
   *
   * Verification runs against a *counterpart* -- another candidate providing the same
   * capability -- and the episode records which one was used, because "verified" without
   * naming the verifier is a word rather than a finding.
   */
  runTask(task, { candidates, constraints = {}, acceptance, verifyWith = null, ledgerCategory = 'adaptive.task' }) {
    if (!acceptance) {
      throw new LoopError('a task needs acceptance criteria; success without them is unfalsifiable', 'no_acceptance')
    }
    const route = routeTask(task, this.#withCosts(candidates, task), constraints)
    this.#record(ledgerCategory, 'route', route.refused ? 'denied' : 'allowed', {
      subject: task.id ?? null,
      chosen: route.chosen?.id ?? null,
      refused: route.refused?.code ?? null,
      considered: route.considered.map((c) => `${c.id}:${c.code}`),
    })
    if (route.refused) {
      const classified = classifyOutcome({ route, execution: null, verification: null, acceptance: [] })
      return this.episodes.append({
        kind: 'task', task: describeTask(task), route, execution: null, verification: null,
        acceptance: [], outcome: classified.outcome, failureKind: classified.failureKind,
        because: classified.because, diagnosis: diagnose({ ...classified, task }),
        at: new Date(this.now()).toISOString(),
      })
    }

    const chosen = candidates.find((c) => c.id === route.chosen.id)
    let execution
    try {
      const { value, ms } = timeInvocation(() => chosen.invoke({ ...task, detail: true }))
      execution = { ok: true, result: value, ms }
    } catch (error) {
      execution = { ok: false, error: error.message, errorCode: error.code ?? 'executor_error', ms: null }
    }

    // Verification needs an *independent implementation*, which is a different thing from a
    // routable candidate: a tree can have exactly one route and still be checkable, and it can
    // have two routes that are the same code wearing different names -- a tool and the skill
    // built around it -- which check nothing. Independence is compared on the implementation
    // tag, and a verifier that shares it is not used.
    const pool = verifyWith ?? candidates
    const counterpart = pool.find(
      (c) => c.implementation !== chosen.implementation && c.provides.includes(task.capabilities[0]),
    )
    let verification = null
    if (execution.ok) {
      if (!counterpart) {
        const sameImplementation = pool.some((c) => c.implementation === chosen.implementation)
        verification = Object.freeze({
          checked: false, agree: false,
          reason: sameImplementation
            ? 'every available verifier runs the same implementation as the route under test, so it could only agree with itself'
            : 'no second implementation is available to check this against, so the result is unverified',
          methods: [], external: Object.freeze({ available: false, tool: null, checked: 0, sampled: [], disagreements: [] }),
        })
      } else {
        verification = verifyLineCount({ executor: chosen, expected: execution.result, counterpart, task })
      }
    }

    const acceptanceResults = execution.ok
      ? evaluateAcceptance(execution.result, acceptance)
      : []
    const classified = classifyOutcome({ route, execution, verification, acceptance: acceptanceResults })
    const episode = this.episodes.append({
      kind: 'task',
      task: describeTask(task),
      route,
      execution: execution.ok
        ? { ok: true, ms: execution.ms, result: stripDetail(execution.result) }
        : { ok: false, error: execution.error, errorCode: execution.errorCode },
      verification,
      acceptance: acceptanceResults,
      outcome: classified.outcome,
      failureKind: classified.failureKind,
      because: classified.because,
      diagnosis: diagnose({ ...classified, execution, verification, task }),
      at: new Date(this.now()).toISOString(),
    })
    this.#record(ledgerCategory, 'execute', episode.outcome === OUTCOMES.SUCCESS ? 'success' : 'failure', {
      subject: task.id ?? null, route: chosen.id, outcome: episode.outcome,
      verified: verification?.agree === true, ms: execution.ms,
    })
    return episode
  }

  /**
   * PROPOSE: turn a verified success into a candidate skill.
   *
   * Refuses on anything else. The registry's own `proposeFromExperience` requires a failure
   * category and a *verified* correction, which is the shape for repairing something that
   * broke; this path is for capturing something that worked, and it demands the same
   * standard of evidence in the form the episode already carries.
   */
  proposeSkill({ episode, name, version = '0.1.0', tags = [], limitations = [], comparison = null }) {
    if (episode.outcome !== OUTCOMES.SUCCESS) {
      throw new LoopError(
        `refusing to propose a skill from an episode whose outcome is '${episode.outcome}' ` +
          `(${episode.because}). A procedure extracted from a run nobody verified encodes whatever went wrong.`,
        'not_a_verified_success',
        { outcome: episode.outcome, failureKind: episode.failureKind },
      )
    }
    if (episode.verification?.agree !== true) {
      throw new LoopError('refusing to propose a skill from an episode whose verification did not agree', 'unverified')
    }
    // The proposal quotes the measurement it was built from. `comparison` is the `measured`
    // array from measure(), and when it is supplied the record says what the numbers actually
    // were -- including when they say the opposite of what the proposal would like. A stored
    // procedure that is *not* cheaper at the measured input is still worth storing (it may win
    // on another shape, and the router re-measures anyway), but it must not be proposed with a
    // claim of improvement the same loop just contradicted. That sentence is the whole
    // difference between an adaptive system and a system that congratulates itself.
    // A skill is measured under both names: `line-count-stream` while it is still an
    // implementation, `skill.line-count-stream` once it is routable as a skill.
    const isSelf = (entry) => entry.id === name || entry.id === `skill.${name}`
    // Every other measured implementation is a competitor -- including the one that actually
    // ran this episode, which is the route the stored procedure is most likely to displace.
    const competitors = (comparison ?? []).filter((entry) => !isSelf(entry))
    const cheapest = competitors.length ? competitors.reduce((a, b) => (b.medianMs < a.medianMs ? b : a)) : null
    const self = (comparison ?? []).find(isSelf) ?? null
    const comparisonLine = self && cheapest
      ? self.medianMs < cheapest.medianMs
        ? `measured ${self.medianMs.toFixed(3)} ms against ${cheapest.id} at ${cheapest.medianMs.toFixed(3)} ms on the same input: the stored procedure is the cheaper route here`
        : `measured ${self.medianMs.toFixed(3)} ms against ${cheapest.id} at ${cheapest.medianMs.toFixed(3)} ms on the same input: the stored procedure is NOT the cheaper route here, and the router will not prefer it on this shape`
      : null
    const proposal = proposeFromExperience(this.registry, {
      name,
      failureCategory: 'inefficient-route',
      attempted: `count lines with ${episode.route.chosen.id}`,
      observed:
        `measured ${episode.route.chosen.measuredMedianMs} ms median over ${episode.execution.ms} ms ` +
        `on ${episode.task.root} (${episode.execution.result.files} files)`,
      correction: comparisonLine ?? `reuse the measured cheaper route on trees of the same shape`,
      verifiedSolution:
        `episode ${episode.seq} verified by ${episode.verification.methods.length} implementations, ` +
        `agreement on ${episode.execution.result.lines} lines`,
      description: `Count lines in a tree with the measured cheapest route`,
      version,
      tags,
      author: 'Klyvaron adaptive loop',
      whenToUse: 'When a task asks for line counts over a tree and a measured route is stored.',
      prerequisites: ['Read permission on the tree.'],
      steps: [
        `List the tree's files by extension, sorted, excluding build and dependency directories.`,
        `Scan each file in chunks and count newline bytes; never materialise a whole file.`,
        `Verify by recomputing with a second implementation and comparing sampled files against wc -l.`,
        `Record the measured cost and the verification evidence on the episode.`,
      ],
      pitfalls: [
        ...(comparisonLine ? [comparisonLine] : []),
        ...(limitations.length
          ? limitations
          : ['Counts newline bytes, so a file with no trailing newline reports one fewer line.']),
      ],
      verification: 'Recompute with an independent implementation; the two must agree before the result is recorded as success.',
      now: this.now(),
    })
    this.#record('adaptive.skill', 'propose', 'info', { subject: name, version, compared: competitors.length })
    return Object.freeze({ ...proposal, comparison: comparisonLine })
  }

  /**
   * TEST: run the checks that decide whether a proposal may be promoted.
   *
   * The checks are supplied by the caller and run here; their results are returned verbatim
   * so the same array reaches `validate()`. Nothing in this method can mark a check passed.
   */
  testSkill({ name, checks }) {
    if (!Array.isArray(checks) || !checks.length) {
      throw new LoopError(`testing '${name}' needs at least one check`, 'no_checks')
    }
    const results = checks.map((check) => {
      try {
        const outcome = check.run()
        return Object.freeze({ name: check.name, passed: outcome.passed === true, detail: outcome.detail ?? '' })
      } catch (error) {
        return Object.freeze({ name: check.name, passed: false, detail: `raised: ${error.message}` })
      }
    })
    return Object.freeze({
      name,
      passed: results.every((r) => r.passed),
      checks: Object.freeze(results),
    })
  }

  /**
   * EVALUATE + DIAGNOSE: run a candidate's checks against the incumbent version's regression
   * set, and record the verdict either way.
   *
   * The interesting outcome is the rejection. A version that fails is *retained*: it stays in
   * the registry as a candidate, its document is still retrievable, and the log carries the
   * failing check, what it reported and a diagnosis that says which kind of failure it was.
   * Deleting a rejected candidate would erase the only record that the improvement was tried.
   */
  evaluate({ name, version, checks, baseline = null, by = 'adaptive loop evaluation', note = null }) {
    const entry = this.registry.describe(name)
    const target = version ?? entry.version
    const record = evaluateCandidate({
      name,
      version: target,
      checks,
      log: this.evaluations,
      baseline,
      at: this.now(),
      by,
      note,
    })
    this.#record('adaptive.skill', 'evaluate', record.verdict === VERDICTS.ACCEPTED ? 'success' : 'denied', {
      subject: name,
      version: target,
      verdict: record.verdict,
      diagnosis: record.diagnosis,
      failed: record.failed.map((each) => each.name),
      notRun: record.notRun,
    })
    return record
  }

  /**
   * APPROVE + VERSION: promote a candidate through the registry, which enforces that every
   * check passed. This method cannot promote anything on its own authority.
   *
   * It also cannot promote a version that was not *evaluated*: there must be an accepted record
   * in the evaluation log for this exact version, and it must have run the same checks being
   * presented now. Otherwise "promote with a passing check list" is a way to approve a version
   * whose tests never ran -- and the check list is the only thing standing between a stored
   * procedure and the next task that reuses it.
   */
  promote({ name, checks, verifiedBy = 'adaptive loop test run' }) {
    if (!checks?.length) {
      throw new LoopError(`cannot promote '${name}' without checks`, 'no_checks')
    }
    const version = this.registry.describe(name).version
    const accepted = this.evaluations.latest(name, { version, verdict: VERDICTS.ACCEPTED })
    if (!accepted) {
      const last = this.evaluations.latest(name, { version })
      this.#record('adaptive.skill', 'promote', 'denied', { subject: name, version, reason: 'not_evaluated' })
      throw new LoopError(
        last
          ? `refusing to promote '${name}' ${version}: its recorded evaluation was ${last.verdict} ` +
            `(${last.diagnosis}) -- ${last.note ?? 'run the checks again, or fix the version'}`
          : `refusing to promote '${name}' ${version}: no evaluation is recorded for this version. ` +
            'Approval follows evaluation; there is no path that skips it.',
        'not_evaluated',
        { version, last: last ?? null },
      )
    }
    const presented = checks.map((check) => check.name).sort()
    const recorded = [...accepted.passed].sort()
    if (JSON.stringify(presented) !== JSON.stringify(recorded)) {
      this.#record('adaptive.skill', 'promote', 'denied', { subject: name, version, reason: 'evaluation_mismatch' })
      throw new LoopError(
        `refusing to promote '${name}' ${version}: the accepted evaluation ran [${recorded.join(', ')}] ` +
          `and these are [${presented.join(', ')}]. A pass on one set of checks is not a pass on another.`,
        'evaluation_mismatch',
        { recorded, presented },
      )
    }
    const failed = checks.filter((c) => c.passed !== true)
    if (failed.length) {
      this.#record('adaptive.skill', 'promote', 'denied', { subject: name, failed: failed.map((f) => f.name) })
      throw new LoopError(
        `refusing to promote '${name}': ${failed.length} of ${checks.length} checks failed (${failed.map((f) => f.name).join(', ')})`,
        'validation_failed',
        { failed },
      )
    }
    const described = this.registry.validate(name, {
      verifiedBy,
      checks,
      at: new Date(this.now()).toISOString(),
      evaluation: { seq: accepted.seq, digest: accepted.digest, verdict: accepted.verdict },
    })
    this.#record('adaptive.skill', 'promote', 'success', { subject: name, version: described.version, checks: checks.length })
    return described
  }

  /**
   * REUSE: a routable candidate for a validated skill.
   *
   * The skill's own permissions are re-checked at invocation even though the tool underneath
   * checks its own: a skill is stored content that a later version can edit, and the check
   * that matters is the one enforced by the thing actually running.
   */
  skillExecutor({ name, version = null, provides, grant, limitations = [], invoke, implementation = null }) {
    const entry = this.registry.describe(name)
    if (entry.state !== SKILL_STATES.VALIDATED && entry.state !== SKILL_STATES.STALE) {
      throw new LoopError(
        `'${name}' is ${entry.state}; only a validated or stale skill is loadable, and a candidate is not`,
        'not_loadable',
        { state: entry.state },
      )
    }
    // The permission comes from the stored document and from nowhere else. The caller supplies
    // the *grant* -- what this runtime is willing to allow -- and the document supplies what
    // the procedure asked for; the executor exists to see that the second fits inside the
    // first. A caller cannot widen a skill by passing a bigger scope, which is the whole point:
    // the wrapper is often the agent, and the agent is the thing being governed.
    const stored = this.registry.permissionsFor(name, version)
    let permissions
    try {
      permissions = effectivePermissions(stored.permissions, grant, { name, createdBy: stored.createdBy })
    } catch (error) {
      this.#record('adaptive.skill', 'execute', 'denied', {
        subject: name, version: stored.version, code: error.code, detail: error.detail ?? null,
      })
      throw error
    }
    this.#record('adaptive.skill', 'execute', 'info', {
      subject: name, version: stored.version, scope: describePermissions(permissions),
    })
    return validateCapability({
      id: `skill.${name}`,
      kind: 'skill',
      version: version ?? entry.version,
      provides,
      // The declared scope, frozen into the descriptor that the executor's own permission
      // checks read. `assertMayRead` refuses a path outside it at the moment of access, so
      // enforcement happens where the file is opened rather than where the route was chosen.
      permissions,
      privacy: 'local-only',
      determinism: 'deterministic',
      limitations: [
        ...limitations,
        // Stated on the descriptor rather than only in the document, because a router choosing
        // between routes is looking at the descriptor.
        `Runs with the stored declaration: ${describePermissions(permissions)}.`,
      ],
      // The stored procedure names the code it wraps, so a route using the skill is not
      // mistaken for an independent check of the tool underneath it.
      implementation: implementation ?? `skill.${name}`,
      description: entry.description ?? `stored procedure '${name}'`,
      invoke,
    })
  }

  /**
   * Roll back to an earlier version by *appending* one, never by rewriting.
   *
   * The earlier document is fetched from the registry's history, relabelled with a new
   * version number, and installed as a candidate -- which means it must pass the same checks
   * before it is loadable again. That is deliberate: a procedure that was superseded for a
   * reason should be re-tested when it comes back, or the reason is lost.
   */
  rollback({ name, version }) {
    const document = this.registry.document(name, version) // throws unknown_version
    const current = this.registry.describe(name)
    const next = bumpPatch(current.version)
    const relabelled = document.replace(/^version:\s*.*$/m, `version: ${next}`)
    this.registry.install(relabelled, { state: SKILL_STATES.CANDIDATE })
    this.#record('adaptive.skill', 'rollback', 'info', { subject: name, restored: version, asVersion: next })
    return Object.freeze({ name, restored: version, newVersion: next, state: SKILL_STATES.CANDIDATE })
  }
}

/** 1.0.0 -> 1.0.1. Rollback numbers a new version; it never reuses an old one. */
function bumpPatch(version) {
  const [major = '0', minor = '0', patch = '0'] = String(version).split('.')
  if (![major, minor, patch].every((part) => /^\d+$/.test(part))) {
    throw new LoopError(`cannot bump '${version}': not a three-part version`, 'invalid_version')
  }
  return `${major}.${minor}.${Number(patch) + 1}`
}

function describeTask(task) {
  return {
    id: task.id ?? null,
    capabilities: task.capabilities,
    root: task.root,
    extensions: task.extensions ?? [],
    safetyCritical: task.safetyCritical === true,
    description: task.description ?? '',
  }
}

/** The per-file array is the size of the tree; the episode keeps the totals and the count. */
function stripDetail(result) {
  return {
    root: result.root, files: result.files, lines: result.lines, bytes: result.bytes,
    perFileCount: result.perFile?.length ?? 0,
  }
}
