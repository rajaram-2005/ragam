// MEASURE: the part of a procedure's evidence that a structural review cannot supply.
//
// A structural review says the document parses, has steps, declares no access and is not
// reachable by the chat path with permissions. It says nothing about whether the procedure
// changes an answer. This module measures that, narrowly and honestly:
//
//   * the same cases are put to the model twice, once with the baseline version and once with
//     the candidate, so the comparison has a control;
//   * each case carries a deterministic check (must appear, must not appear), so the score does
//     not depend on a second model judging the first;
//   * a case the baseline passed and the candidate failed is a regression and stops the verdict,
//     whatever the aggregate says;
//   * "we measured nothing distinguishing" is a verdict of its own. A suite where both versions
//     pass every case is not evidence of improvement, and this module refuses to call it one.
//
// The record keeps case ids, checks and measurements. It does not keep the prompt text: the
// prompt can contain whatever the person typed, and a measurement log is not a place to copy it.

import { createHash, randomUUID } from 'node:crypto'

export const MAX_CASES = 5
export const MAX_PROMPT_CHARS = 2_000
export const MAX_CHECK_PHRASE = 200
export const MEASURE_VERDICTS = Object.freeze({
  IMPROVEMENT: 'measured_improvement',
  REGRESSION: 'regression',
  NO_DIFFERENCE: 'no_difference_measured',
})

const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

export class MeasureError extends Error {
  constructor(message, code = 'invalid_measurement') {
    super(message)
    this.name = 'MeasureError'
    this.code = code
  }
}

/** Validate and normalise the caller's cases before any provider call is made. */
export function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > MAX_CASES) {
    throw new MeasureError(`A measurement needs 1 to ${MAX_CASES} cases.`)
  }
  return cases.map((entry, index) => {
    if (!entry || typeof entry.prompt !== 'string' || !entry.prompt.trim()) {
      throw new MeasureError(`Case ${index + 1} needs a prompt.`)
    }
    if (entry.prompt.length > MAX_PROMPT_CHARS) throw new MeasureError(`Case ${index + 1} is longer than ${MAX_PROMPT_CHARS} characters.`)
    const mustInclude = entry.mustInclude ?? []
    const mustExclude = entry.mustExclude ?? []
    for (const [label, list] of [['mustInclude', mustInclude], ['mustExclude', mustExclude]]) {
      if (!Array.isArray(list) || list.length > 5 || list.some((phrase) => typeof phrase !== 'string' || !phrase.trim() || phrase.length > MAX_CHECK_PHRASE)) {
        throw new MeasureError(`Case ${index + 1}: ${label} is up to five phrases of at most ${MAX_CHECK_PHRASE} characters.`)
      }
    }
    if (!mustInclude.length && !mustExclude.length) {
      // Without a check, 'pass' would mean 'the model said something', which is not a test.
      throw new MeasureError(`Case ${index + 1} needs at least one mustInclude or mustExclude phrase.`)
    }
    return Object.freeze({
      id: entry.id ?? `case-${index + 1}`,
      prompt: entry.prompt.trim(),
      mustInclude: mustInclude.map((phrase) => phrase.trim()),
      mustExclude: mustExclude.map((phrase) => phrase.trim()),
    })
  })
}

/** Deterministic scoring. Case-insensitive, because casing is not what the check is about. */
export function scoreText(text, { mustInclude = [], mustExclude = [] } = {}) {
  const haystack = String(text ?? '').toLowerCase()
  const missing = mustInclude.filter((phrase) => !haystack.includes(phrase.toLowerCase()))
  const forbidden = mustExclude.filter((phrase) => haystack.includes(phrase.toLowerCase()))
  return Object.freeze({ passed: missing.length === 0 && forbidden.length === 0, missing, forbidden })
}

/** One version's results, with the latency and token totals that make cost visible. */
export function summariseRuns(version, results) {
  const total = results.length
  const passed = results.filter((result) => result.passed).length
  const latencies = results.map((result) => result.latencyMs).filter(Number.isFinite)
  const tokens = results.map((result) => result.tokens).filter(Number.isFinite)
  return Object.freeze({
    version,
    total,
    passed,
    passRate: total ? passed / total : 0,
    meanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    totalTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null,
  })
}

/**
 * Compare two runs.
 *
 * The order of the rules matters. A regression is checked first because an aggregate improvement
 * can hide one: four cases fixed and one broken is still a procedure that now fails a task it
 * used to complete. Equal pass rates produce `no_difference_measured`, never an improvement.
 */
export function compareRuns(baseline, candidate, { caseResults = [] } = {}) {
  const regressed = caseResults.filter((entry) => entry.baseline?.passed && !entry.candidate?.passed)
  if (regressed.length) {
    return Object.freeze({
      verdict: MEASURE_VERDICTS.REGRESSION,
      reason: `${regressed.length} case(s) the baseline passed now fail: ${regressed.map((entry) => entry.id).join(', ')}.`,
      regressions: Object.freeze(regressed.map((entry) => entry.id)),
    })
  }
  if (candidate.passRate > baseline.passRate) {
    return Object.freeze({
      verdict: MEASURE_VERDICTS.IMPROVEMENT,
      reason: `The candidate passed ${candidate.passed}/${candidate.total} cases; the baseline passed ${baseline.passed}/${baseline.total}. No case that passed before now fails.`,
      regressions: Object.freeze([]),
    })
  }
  return Object.freeze({
    verdict: MEASURE_VERDICTS.NO_DIFFERENCE,
    reason: candidate.passRate === baseline.passRate
      ? 'Both versions scored the same on this sample. That is not an improvement, and one sample is one sample.'
      : 'The candidate scored lower without failing a case the baseline passed; the sample does not support a change.',
    regressions: Object.freeze([]),
  })
}

/** A measurement record. No prompt text, no provider credential, no generated answer. */
export function buildRecord({ name, baselineVersion, candidateVersion, cases, caseResults, at = Date.now(), by = 'owner' }) {
  const baseline = summariseRuns(baselineVersion, caseResults.map((entry) => entry.baseline))
  const candidate = summariseRuns(candidateVersion, caseResults.map((entry) => entry.candidate))
  const comparison = compareRuns(baseline, candidate, { caseResults })
  return Object.freeze({
    schema: 1,
    id: randomUUID(),
    at: new Date(at).toISOString(),
    name,
    baselineVersion,
    candidateVersion,
    baseline,
    candidate,
    delta: Object.freeze({
      passRate: Number((candidate.passRate - baseline.passRate).toFixed(4)),
      meanLatencyMs: baseline.meanLatencyMs === null || candidate.meanLatencyMs === null ? null : candidate.meanLatencyMs - baseline.meanLatencyMs,
      totalTokens: baseline.totalTokens === null || candidate.totalTokens === null ? null : candidate.totalTokens - baseline.totalTokens,
    }),
    ...comparison,
    cases: Object.freeze(caseResults.map((entry) => Object.freeze({
      id: entry.id,
      promptDigest: digest(entry.prompt),
      mustInclude: Object.freeze([...entry.mustInclude]),
      mustExclude: Object.freeze([...entry.mustExclude]),
      baseline: Object.freeze({ passed: entry.baseline.passed, latencyMs: entry.baseline.latencyMs, tokens: entry.baseline.tokens }),
      candidate: Object.freeze({ passed: entry.candidate.passed, latencyMs: entry.candidate.latencyMs, tokens: entry.candidate.tokens }),
    }))),
    measured: true,
    disclosure: 'A measured comparison of the two versions on the cases supplied, scored by the checks supplied. It is not training, and it cannot show that a version is better on cases nobody wrote.',
    by,
  })
}
