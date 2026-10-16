// EVALUATE and DIAGNOSE: the gate between "a candidate improvement" and "a version people get".
//
// Directive §6C: "When a workflow fails, capture the failure category, what was attempted, the
// observed result, the correction and the eventual verified solution. If the task is likely to
// recur, create a candidate skill improvement. Validate it in a safe environment before making
// it available for future use. Track skill versions, tests, provenance and performance.
// Retain the ability to roll back a harmful change."
//
// The word that carries the weight in that paragraph is *validate*, and validation is only
// meaningful against something. A check suite written fresh for every candidate proves the
// candidate does what its author just tested; it says nothing about what the previous version
// did, which is the entire risk of an improvement. So this module is built on one rule:
//
//   **A check that passed for the incumbent version must still pass, and it must still be run.**
//
// Three ways that rule can be broken, and each has its own diagnosis rather than one
// undifferentiated "rejected":
//
//   * `regression`      -- a check that passed before now fails
//   * `regression_not_run` -- a check that passed before is *missing* from the candidate's suite
//   * `new_failure`     -- a check the candidate itself introduced fails
//
// The second one is the quiet one. A candidate that changes its own test suite cannot fail a
// test it deleted, so a suite that lost a baseline check is rejected as `regression_not_run`
// even though every check that did run passed. A broken test suite must not read as a pass.
//
// The log is append-only and digest-chained for the same reason the episode log is: a rejection
// that can be edited away is not a record, and the interesting records are exactly the
// rejections. A rejected version stays in the registry -- retained, retrievable, and visible as
// a candidate that was tried.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export const VERDICTS = Object.freeze({
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
})

export const DIAGNOSES = Object.freeze({
  FIRST_VERSION: 'first_evaluated_version',
  REGRESSION: 'regression',
  NOT_RUN: 'regression_not_run',
  NEW_FAILURE: 'new_failure',
  NO_CHECKS: 'no_checks',
})

export class EvaluationError extends Error {
  constructor(message, code = 'evaluation_error', detail = {}) {
    super(message)
    this.name = 'EvaluationError'
    this.code = code
    this.detail = detail
  }
}

const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * An append-only, digest-chained evaluation log.
 *
 * `:memory:` is the default so a test does not need a filesystem; the file form is what makes a
 * rejection survive the process that produced it.
 */
export class EvaluationLog {
  #file
  #entries = []
  #previous = null

  constructor(file = ':memory:') {
    this.#file = file
    if (file !== ':memory:') {
      mkdirSync(dirname(file), { recursive: true })
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          this.#entries.push(JSON.parse(line))
        }
        this.#previous = this.#entries.at(-1)?.digest ?? null
        const verdict = this.verify()
        if (!verdict.ok) {
          throw new EvaluationError(
            `the evaluation log at ${file} does not verify (${verdict.reason}); refusing to append ` +
              'to a broken chain, which would hide the break rather than report it',
            'broken_chain',
            verdict,
          )
        }
      }
    }
  }

  get count() {
    return this.#entries.length
  }

  append(record) {
    const entry = Object.freeze({
      ...record,
      seq: this.#entries.length + 1,
      previous: this.#previous,
      digest: null,
    })
    const sealed = Object.freeze({ ...entry, digest: digestOf({ ...entry, digest: undefined }) })
    this.#entries.push(sealed)
    this.#previous = sealed.digest
    if (this.#file !== ':memory:') appendFileSync(this.#file, `${JSON.stringify(sealed)}\n`)
    return sealed
  }

  /** Every record, or every record for one skill, newest last. */
  list({ name = null } = {}) {
    return this.#entries.filter((entry) => !name || entry.name === name)
  }

  /** The most recent record for a skill, optionally for one version or one verdict. */
  latest(name, { version = null, verdict = null } = {}) {
    const matching = this.list({ name })
      .filter((entry) => !version || entry.version === version)
      .filter((entry) => !verdict || entry.verdict === verdict)
    return matching.at(-1) ?? null
  }

  /** The accepted check names a *new* candidate must satisfy: the incumbent's regression set. */
  baseline(name, { before = null } = {}) {
    const accepted = this.list({ name })
      .filter((entry) => entry.verdict === VERDICTS.ACCEPTED)
      .filter((entry) => !before || entry.version !== before)
    return accepted.at(-1)?.passed ?? []
  }

  verify() {
    let previous = null
    for (const [index, entry] of this.#entries.entries()) {
      if (entry.previous !== previous) {
        return { ok: false, reason: `entry ${index + 1} points at ${entry.previous}, expected ${previous}` }
      }
      const { digest, ...rest } = entry
      if (digestOf({ ...rest, digest: undefined }) !== digest) {
        return { ok: false, reason: `entry ${index + 1} does not hash to its recorded digest` }
      }
      previous = digest
    }
    return { ok: true, reason: null, entries: this.#entries.length }
  }
}

/**
 * Run a candidate's checks and record the verdict.
 *
 * `checks` are `{name, run() -> {passed, detail}}`. A check that throws is a failure carrying
 * the exception's message, not an exception out of the evaluator: a suite that crashes on one
 * check must still produce a record of the others, and letting it throw would lose the ones
 * that already ran.
 *
 * `baseline` defaults to the accepted checks of the last version this log recorded. When a
 * caller passes it explicitly (a first version evaluated with no history, say) it still has to
 * be run and passed, so the regression rule cannot be switched off by omitting history.
 */
export function evaluateCandidate({
  name,
  version,
  checks,
  log,
  baseline = null,
  at = Date.now(),
  by = 'adaptive loop evaluation',
  note = null,
}) {
  if (!name || !version) {
    throw new EvaluationError('an evaluation needs a skill name and a version', 'missing_identity')
  }
  if (!log || typeof log.append !== 'function') {
    throw new EvaluationError('an evaluation needs a log to record it in', 'no_log')
  }
  if (!Array.isArray(checks) || !checks.length) {
    throw new EvaluationError(
      `evaluating '${name}' ${version} needs at least one check; a version with no tests is not a ` +
        'version that passed',
      'no_checks',
    )
  }
  const names = checks.map((check) => check?.name)
  if (names.some((each) => typeof each !== 'string' || !each.trim())) {
    throw new EvaluationError('every check needs a name, so the record can say which one failed', 'unnamed_check')
  }
  const duplicates = names.filter((each, index) => names.indexOf(each) !== index)
  if (duplicates.length) {
    throw new EvaluationError(
      `two checks share the name '${duplicates[0]}'; a record naming it twice cannot say which failed`,
      'duplicate_check_name',
    )
  }

  const regressionSet = baseline ?? log.baseline(name, { before: version })
  const isFirst = regressionSet.length === 0

  const results = checks.map((check) => {
    try {
      const outcome = check.run()
      return Object.freeze({
        name: check.name,
        passed: outcome?.passed === true,
        detail: String(outcome?.detail ?? ''),
      })
    } catch (error) {
      return Object.freeze({ name: check.name, passed: false, detail: `raised: ${error.message}` })
    }
  })

  const byName = new Map(results.map((result) => [result.name, result]))
  const failed = results.filter((result) => !result.passed)
  const notRun = regressionSet.filter((checkName) => !byName.has(checkName))
  const regressions = failed.filter((result) => regressionSet.includes(result.name))

  const verdict = !failed.length && !notRun.length ? VERDICTS.ACCEPTED : VERDICTS.REJECTED
  const diagnosis = resolveDiagnosis({ verdict, regressions, notRun, failed, isFirst })

  const record = log.append({
    at: new Date(at).toISOString(),
    name,
    version,
    verdict,
    diagnosis,
    passed: results.filter((result) => result.passed).map((result) => result.name),
    failed: failed.map((result) => Object.freeze({ name: result.name, detail: result.detail })),
    notRun: Object.freeze([...notRun]),
    regressionSet: Object.freeze([...regressionSet]),
    firstEvaluatedVersion: isFirst,
    by,
    note,
  })

  return Object.freeze({
    ...record,
    results: Object.freeze(results),
    summary: summarise(record),
  })
}

function resolveDiagnosis({ verdict, regressions, notRun, failed, isFirst }) {
  if (verdict === VERDICTS.ACCEPTED) return isFirst ? DIAGNOSES.FIRST_VERSION : null
  if (regressions.length) return DIAGNOSES.REGRESSION
  if (notRun.length) return DIAGNOSES.NOT_RUN
  if (failed.length) return DIAGNOSES.NEW_FAILURE
  return null
}

/**
 * One sentence stating what happened, for the record and for a human reading the status line.
 * It names the failing check and what it said, because "rejected" alone is not a rejection
 * anybody can act on.
 */
export function summarise(record) {
  if (record.verdict === VERDICTS.ACCEPTED) {
    const how = record.firstEvaluatedVersion
      ? `first evaluated version: ${record.passed.length} check(s) passed, and they are the regression set for the next one`
      : `${record.passed.length} check(s) passed, including all ${record.regressionSet.length} carried over`
    return `accepted ${record.name} ${record.version}: ${how}`
  }
  if (record.diagnosis === DIAGNOSES.NOT_RUN) {
    return (
      `rejected ${record.name} ${record.version}: ${record.notRun.length} check(s) that passed for the ` +
      `previous version were not run at all (${record.notRun.join(', ')}). A suite that lost a test ` +
      'cannot fail it.'
    )
  }
  const first = record.failed[0]
  const kind = record.diagnosis === DIAGNOSES.REGRESSION ? 'a regression' : 'a failure in a new check'
  return (
    `rejected ${record.name} ${record.version}: ${kind} -- '${first?.name}' reported ${first?.detail || 'no detail'}`
  )
}
