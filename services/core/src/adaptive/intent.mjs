// Intent: turning what a person asked for into the capability tags a plan needs.
//
// `godcore/lifecycle.mjs` already has an `understand` phase. It classifies a prompt into
// coarse intents ('coding', 'image', 'reasoning') so the lifecycle knows which downstream
// path to try, and its own docstring says it is heuristic triage, not NLU. This module
// answers the next question down: *which capabilities must exist* for the request to be
// servable at all. That is the question the capability registry and the plan builder need,
// and it is a different question from "what kind of thing is this".
//
// Three properties are structural rather than stylistic:
//
//   1. Every capability requirement names the phrase that produced it. A requirement with no
//      evidence is a guess, and a guess that reaches the router is indistinguishable from a
//      fact by the time a plan is built on it.
//   2. An unresolved or ambiguous request produces a question, not a default. There is no
//      "general" capability to fall back to here, so falling back would mean routing to
//      something that does not exist and calling the result an answer.
//   3. Emotional signals are read and deliberately not used. An interaction state may say
//      *how* to answer; it must never change *what was asked*, and it must never become a
//      capability requirement.
//
// The known limitation, stated rather than discovered later: the rule table is written for
// the capabilities this installation actually has. A request outside it is refused as
// unresolved, which is correct here and would be wrong for a general assistant.

export const CONFIDENCE = Object.freeze({
  STATED: 'stated', // the request names the capability in words the rule matches exactly
  INFERRED: 'inferred', // the rule matched a paraphrase
})

export const SENSITIVE_TERMS = Object.freeze([
  'diagnosis', 'depressed', 'anxiety', 'therapy', 'medication', 'religion', 'politics',
  'pregnant', 'salary', 'immigration', 'disability', 'addiction',
])

export class IntentError extends Error {
  constructor(message, code = 'intent_error', detail = {}) {
    super(message)
    this.name = 'IntentError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Rules are data, not code, so the whole table can be read at once and a test can assert
 * that every rule cites its phrase. `capabilities` are dotted tags that must match what a
 * descriptor declares in `provides`, which `registry.unimplemented()` checks.
 */
export const INTENT_RULES = Object.freeze([
  Object.freeze({
    id: 'count-lines-exact',
    capabilities: Object.freeze(['tree.line-count']),
    confidence: CONFIDENCE.STATED,
    patterns: Object.freeze([/\bcount\b[^.]*\blines?\b/i, /\blines?\b[^.]*\bcount\b/i, /\bhow many lines\b/i]),
  }),
  Object.freeze({
    id: 'count-lines-paraphrase',
    capabilities: Object.freeze(['tree.line-count']),
    confidence: CONFIDENCE.INFERRED,
    patterns: Object.freeze([/\bsize\b[^.]*\b(in|of) lines\b/i, /\bloc\b/i, /\bline count\b/i]),
  }),
])

/** Constraints a request may state outright. Absent means absent -- never a default. */
function readConstraints(utterance) {
  const constraints = {}
  const latency = /\b(?:within|under|in)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/i.exec(utterance)
  if (latency) {
    const value = Number(latency[1])
    constraints.maxLatencyMs = /^m/i.test(latency[2]) ? value : value * 1000
    constraints.maxLatencyBecause = `the request says '${latency[0]}'`
  }
  const scope = /\b(?:under|inside|within|in)\s+([./\w-]+\/)/.exec(utterance)
  if (scope) {
    constraints.within = scope[1]
    constraints.withinBecause = `the request names the path '${scope[1]}'`
  }
  if (/\bmust be (?:identical|reproducible|deterministic)\b/i.test(utterance)) {
    constraints.requireDeterministic = true
    constraints.determinismBecause = 'the request asks for a reproducible result'
  }
  return constraints
}

/**
 * Read a request. Returns a frozen record; `resolved` is false when a question must be asked
 * before anything can be planned, and `clarification` carries the question.
 */
export function readIntent({ utterance, context = {} } = {}) {
  const text = String(utterance ?? '').trim()
  if (!text) {
    throw new IntentError('an intent needs something to read; the utterance is empty', 'empty_utterance')
  }

  const matched = []
  for (const rule of INTENT_RULES) {
    const pattern = rule.patterns.find((candidate) => candidate.test(text))
    if (pattern) {
      matched.push({
        rule: rule.id,
        capabilities: rule.capabilities,
        confidence: rule.confidence,
        phrase: pattern.exec(text)[0],
      })
    }
  }

  // Distinct capability families, not distinct rules: two rules for the same capability that
  // both match are agreement, not ambiguity.
  const families = new Map()
  for (const match of matched) {
    const key = match.capabilities.join('+')
    if (!families.has(key)) families.set(key, [])
    families.get(key).push(match)
  }

  const sensitiveObserved = SENSITIVE_TERMS.filter((term) => text.toLowerCase().includes(term))
  const constraints = readConstraints(text)
  const because = matched.map((match) => `${match.rule}: '${match.phrase}' (${match.confidence})`)

  const base = {
    request: text,
    context: Object.freeze({ ...context }),
    constraints: Object.freeze({ ...constraints }),
    because: Object.freeze(because),
    // Read, recorded as read, and used for nothing. If a sensitive term ever changes routing
    // the change shows up here as a diff in a field nothing consumes.
    sensitiveTermsObserved: Object.freeze(sensitiveObserved),
    // The emotional read belongs to wording and is attached by the caller; intent does not
    // produce one, so it cannot leak into capability selection.
    emotionalSignalsUsed: false,
  }

  if (families.size === 0) {
    return Object.freeze({
      ...base,
      resolved: false,
      capabilities: Object.freeze([]),
      confidence: null,
      reason: 'no rule in this installation matches the request',
      clarification:
        'Which of the capabilities this installation provides does this need? ' +
        'Nothing was assumed, because there is no general-purpose route to fall back to.',
      limitation:
        'The rule table covers the capabilities implemented here; a request outside it is refused rather than answered by a model that is not present.',
    })
  }

  if (families.size > 1) {
    const familiesRead = [...families.values()].map((group) => group[0])
    return Object.freeze({
      ...base,
      resolved: false,
      capabilities: Object.freeze(familiesRead.map((group) => group.capabilities[0])),
      confidence: null,
      reason: `the request matches ${families.size} different capability families`,
      clarification:
        `This matches ${familiesRead.map((group) => `${group.capabilities.join(' + ')} (from '${group.phrase}')`).join(' and ')}. ` +
        'Which one is wanted?',
      limitation: 'A request that matches two families is not silently assigned to the first.',
    })
  }

  const group = [...families.values()][0]
  const confidence = group.some((match) => match.confidence === CONFIDENCE.STATED)
    ? CONFIDENCE.STATED
    : CONFIDENCE.INFERRED
  return Object.freeze({
    ...base,
    resolved: true,
    capabilities: Object.freeze([...group[0].capabilities]),
    confidence,
    reason: null,
    clarification: null,
    limitation: null,
  })
}

/** The capability tags a request needs, for `registry.unimplemented()`. */
export function requiredCapabilities(intent) {
  return [...(intent?.capabilities ?? [])]
}
