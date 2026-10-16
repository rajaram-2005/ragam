// Episodes: what was attempted, what happened, and what the evidence supports.
//
// An episode is the unit of experience. It carries the task, the route that was chosen and
// the reasons the others were not, what the executor measured, what independent verification
// found, whether the declared acceptance criteria were met, and -- when they were not -- a
// *hypothesis* about why, labelled as a hypothesis.
//
// Two properties are enforced here rather than documented:
//
//   * **The outcome cannot be asserted.** `classifyOutcome` computes it from the route, the
//     execution, the verification and the acceptance checks. There is no parameter through
//     which a caller can say "this succeeded"; a caller holding a wrong belief produces a
//     record that contradicts it.
//   * **The log is append-only and tamper-evident.** Every episode carries the digest of the
//     one before it, so a record edited after the fact is detectable by recomputing the
//     chain. The write path refuses to append to a log whose chain does not verify, because
//     appending to a broken chain hides the break rather than reporting it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export const OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
  INCONCLUSIVE: 'inconclusive',
})

/** Why a task did not succeed. One code per episode, with the evidence that produced it. */
export const FAILURE_KINDS = Object.freeze({
  NO_ROUTE: 'no_route',
  PERMISSION_DENIED: 'permission_denied',
  EXECUTOR_ERROR: 'executor_error',
  VERIFICATION_DISAGREEMENT: 'verification_disagreement',
  ACCEPTANCE_UNMET: 'acceptance_unmet',
})

export class EpisodeError extends Error {
  constructor(message, code = 'episode_error', detail = {}) {
    super(message)
    this.name = 'EpisodeError'
    this.code = code
    this.detail = detail
  }
}

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Evaluate declared acceptance criteria against a *verified* result.
 *
 * The checks are data rather than closures so that they travel with the episode and can be
 * re-run by a reader who has only the record. An operator the evaluator does not implement
 * is a refusal, not a pass: an acceptance criterion that silently stops being checked is
 * worse than one that was never written.
 */
export function evaluateAcceptance(result, acceptance) {
  const criteria = acceptance?.checks ?? []
  if (!criteria.length) {
    throw new EpisodeError(
      'a task must declare at least one acceptance check; a task with no criteria cannot fail, ' +
        'so its success means nothing',
      'no_acceptance_criteria',
    )
  }
  const OPERATORS = {
    '==': (a, b) => a === b,
    '>': (a, b) => a > b,
    '>=': (a, b) => a >= b,
    '<': (a, b) => a < b,
  }
  return criteria.map((criterion) => {
    const { name, metric, op, value } = criterion
    const operator = OPERATORS[op]
    if (!operator) {
      throw new EpisodeError(`acceptance check '${name}' uses unknown operator '${op}'`, 'unknown_operator', { op })
    }
    const observed = result?.[metric]
    if (observed === undefined) {
      throw new EpisodeError(
        `acceptance check '${name}' reads metric '${metric}', which the result does not carry`,
        'unknown_metric',
        { metric },
      )
    }
    const passed = operator(observed, value)
    return Object.freeze({
      name, metric, op, value, observed, passed,
      detail: `${metric} ${op} ${value}: observed ${observed}`,
    })
  })
}

/**
 * Compute the outcome. Nothing here trusts a caller's claim that the work was done.
 *
 * The order is the order of certainty: a refused route never ran anything, a crashed
 * executor produced nothing usable, an unverified result cannot be called a success, and
 * only then does it matter whether the acceptance criteria were met.
 */
export function classifyOutcome({ route, execution, verification, acceptance }) {
  if (!route || route.refused) {
    return Object.freeze({
      outcome: OUTCOMES.FAILED,
      failureKind: FAILURE_KINDS.NO_ROUTE,
      because: route?.refused?.message ?? 'the task was not routed',
    })
  }
  // `execution` is the record of an attempt: `{ ok: true, result, ms }` or
  // `{ ok: false, error }`. `null` means no attempt was made at all, which only happens with
  // a refused route and is handled above. The distinction matters: an absent attempt and a
  // successful one are both falsy-ish things that must not be confused, because confusing
  // them turns every success into an "executor produced no result" failure.
  if (!execution || execution.ok !== true) {
    const code = execution?.errorCode ?? 'unknown'
    return Object.freeze({
      outcome: OUTCOMES.FAILED,
      failureKind: code === 'permission_denied' ? FAILURE_KINDS.PERMISSION_DENIED : FAILURE_KINDS.EXECUTOR_ERROR,
      because: execution?.error ?? 'the executor produced no result',
    })
  }
  if (!verification || verification.agree !== true) {
    return Object.freeze({
      outcome: OUTCOMES.INCONCLUSIVE,
      failureKind: FAILURE_KINDS.VERIFICATION_DISAGREEMENT,
      because:
        verification?.reason ??
        'the result was not verified; an unverified result is not a success and not a proven failure',
      verification,
    })
  }
  const failed = acceptance.filter((check) => !check.passed)
  if (failed.length) {
    return Object.freeze({
      outcome: OUTCOMES.FAILED,
      failureKind: FAILURE_KINDS.ACCEPTANCE_UNMET,
      because: `${failed.length} acceptance check(s) did not pass: ${failed.map((c) => c.detail).join('; ')}`,
      unmet: failed,
    })
  }
  return Object.freeze({
    outcome: OUTCOMES.SUCCESS,
    failureKind: null,
    because: `verified by ${verification.methods.length} independent implementation(s) and ${acceptance.length} acceptance check(s)`,
  })
}

/**
 * A likely cause and a candidate correction for a failure -- labelled as hypotheses.
 *
 * The directive asks for the *likely* root cause, and the difference between "the root cause
 * was X" and "the most likely cause is X, on this evidence" is the difference between a
 * finding and a guess dressed as one. Every diagnosis here carries `hypothesis: true` and the
 * basis it was formed from.
 */
export function diagnose({ outcome, failureKind, because, execution, verification, task }) {
  if (outcome === OUTCOMES.SUCCESS) return null
  const hypothesis = (likelyCause, candidateCorrection, basis) =>
    Object.freeze({ hypothesis: true, likelyCause, candidateCorrection, basis })

  switch (failureKind) {
    case FAILURE_KINDS.NO_ROUTE:
      return hypothesis(
        `no available route provides ${task?.capabilities?.join(', ') ?? 'the required capability'} within the request's constraints`,
        'provide a capability for it, or relax a named constraint -- and if a constraint is relaxed, record which one and why',
        because,
      )
    case FAILURE_KINDS.PERMISSION_DENIED:
      return hypothesis(
        execution?.error ?? 'the executor was refused the path it was asked to touch',
        'widen the declared scope deliberately, or run against a permitted path; do not widen it as a side effect of a failure',
        execution?.error ?? because,
      )
    case FAILURE_KINDS.EXECUTOR_ERROR:
      return hypothesis(
        `the executor raised: ${execution?.error ?? 'no detail recorded'}`,
        'reproduce with the recorded input, then record the correction only once the reproduction passes',
        execution?.error ?? because,
      )
    case FAILURE_KINDS.VERIFICATION_DISAGREEMENT:
      return hypothesis(
        'the implementations disagree, so at most one of them is right and the disagreement itself is the finding',
        'do not promote anything from this episode; find which implementation is wrong, and record the case that distinguishes them',
        because,
      )
    case FAILURE_KINDS.ACCEPTANCE_UNMET:
      return hypothesis(
        'the result was verified but did not meet a declared criterion',
        'treat the unmet criterion as the specification: a verified result that misses it is a wrong result, not a wrong test',
        because,
      )
    default:
      return hypothesis('unclassified', 'investigate the episode record', because)
  }
}

/**
 * An append-only episode log with a digest chain.
 *
 * JSONL, one episode per line, because a log that has to be parsed whole to be appended to
 * is a log that stops being written when it grows. The chain is over the *content* of each
 * episode, so moving a line, editing a number or deleting one is detectable.
 */
export class EpisodeLog {
  #file
  #lastDigest = null
  #count = 0
  // A ':memory:' log is the default, and it used to accept appends while `list()` returned an
  // empty array -- so `count` grew, `verify()` called an empty log intact, and `successes()`
  // answered 'none' about a session that had recorded successes. The log kept count and read
  // nothing back. An in-memory log now reads back exactly what it stored.
  #entries = []

  constructor(file = ':memory:') {
    this.#file = file
    if (file === ':memory:') return
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) writeFileSync(file, '', 'utf8')
    const existing = this.list()
    this.#count = existing.length
    this.#lastDigest = existing.length ? existing.at(-1).digest : null
  }

  get count() {
    return this.#count
  }

  get lastDigest() {
    return this.#lastDigest
  }

  /**
   * Append one episode. The caller supplies the content; the chain is computed here.
   *
   * A log whose chain is already broken is refused rather than appended to. Continuing from a
   * link that no longer matches its content would make the chain verify from the break
   * forward, which hides an edit behind a log that looks intact after it. Reading such a log
   * is still allowed -- and `verify()` says where the break is -- because a tampered log is a
   * finding to report, and refusing to load it would destroy the finding.
   */
  append(episode) {
    if (episode.outcome === undefined) {
      throw new EpisodeError('an episode needs an outcome; run classifyOutcome() first', 'missing_outcome')
    }
    const intact = this.verify()
    if (!intact.ok) {
      throw new EpisodeError(
        `refusing to append to this log: ${intact.reason}. An edited log is a finding to report, ` +
          'not a log to continue writing.',
        'log_tampered',
        { brokenAt: intact.brokenAt },
      )
    }
    const body = { ...episode, seq: this.#count, at: episode.at ?? new Date().toISOString(), prevDigest: this.#lastDigest }
    delete body.digest
    const record = Object.freeze({ ...body, digest: digestOf(body) })
    if (this.#file !== ':memory:') appendFileSync(this.#file, `${JSON.stringify(record)}\n`, 'utf8')
    else this.#entries.push(record)
    this.#lastDigest = record.digest
    this.#count += 1
    return record
  }

  list() {
    if (this.#file === ':memory:') return [...this.#entries]
    if (!existsSync(this.#file)) return []
    const text = readFileSync(this.#file, 'utf8')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }

  /**
   * Recompute the chain. Returns `{ ok, brokenAt, reason }` rather than throwing, because a
   * broken log is a finding to report, not an exception to catch.
   */
  verify() {
    const episodes = this.list()
    let prev = null
    for (let i = 0; i < episodes.length; i += 1) {
      const episode = episodes[i]
      const { digest, ...body } = episode
      if (body.prevDigest !== prev) {
        return { ok: false, brokenAt: i, reason: `episode ${i} links to ${body.prevDigest}, but the previous digest is ${prev}` }
      }
      if (digestOf(body) !== digest) {
        return { ok: false, brokenAt: i, reason: `episode ${i} has been modified since it was written` }
      }
      prev = digest
    }
    return { ok: true, brokenAt: null, count: episodes.length }
  }

  /** Episodes that produced a verified success, which is the only input a skill may come from. */
  successes() {
    return this.list().filter((e) => e.outcome === OUTCOMES.SUCCESS && e.verification?.agree === true)
  }
}
