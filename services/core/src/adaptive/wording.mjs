// How the system says things, kept strictly apart from what it says.
//
// This is §4 of the directive implemented as a property rather than a promise. The design
// rule is one sentence: **an interaction state may change the framing and may never change
// the facts.** Everything below exists to make that checkable --
//
//   * `renderOutcome()` returns the prose *and* the facts it was built from, and the facts
//     are the same object for every state;
//   * the facts block is rendered by one function used by every state, so a number cannot
//     be rounded differently by a chattier state;
//   * `auditWording()` scans the result for the things §4 forbids -- claimed feelings,
//     claimed consciousness, dependency appeals, jealousy or possessiveness, a fabricated
//     emotional history, and the kind of exaggerated praise that turns a measurement into
//     marketing;
//   * an unverified result states that it is unverified in *every* state, including the
//     warm ones. That is the case where adaptivity would be most tempting and most wrong.
//
// The states are an application-level setting, inspectable and overridable, not a model of
// anybody's inner life. Calling them "emotions" would be the first overclaim, so they are
// called interaction states throughout.

import { DIAGNOSIS_TERMS } from '../klyvaron/affect.mjs'

export const INTERACTION_STATES = Object.freeze([
  'supportive', 'curious', 'focused', 'encouraging', 'playful', 'cautious', 'reflective',
])

/** Personality settings a user owns and can change. Humor is off unless asked for. */
export const DEFAULT_PERSONALITY = Object.freeze({
  adaptTone: true,
  humor: false,
  warmth: 'neutral',      // 'reserved' | 'neutral' | 'warm'
  formality: 'neutral',   // 'casual' | 'neutral' | 'formal'
  verbosity: 'normal',    // 'brief' | 'normal' | 'detailed'
  voiceExpression: false, // reserved for the voice surface; recorded here, unused for text
  storePreferences: true, // whether a correction may be remembered at all
})

/**
 * Phrases a person typed, and the interaction state each suggests. The list is short on
 * purpose: every entry is something a user wrote about themselves, never something inferred
 * about them, and the estimate is reported as an estimate either way.
 */
export const STATE_PHRASES = Object.freeze([
  { state: 'supportive', phrases: ['frustrated', 'so annoying', 'this is broken', 'fed up', 'stuck', "i'm stuck", 'overwhelmed', 'exhausted', 'burnt out', 'upset', 'disappointed'] },
  { state: 'playful', phrases: ['just for fun', 'no rush', 'make it fun', 'be playful', 'a bit of humor'] },
  { state: 'curious', phrases: ['i wonder', 'what if', 'curious', 'explore', 'which approach', 'why does'] },
  { state: 'encouraging', phrases: ['nearly there', 'making progress', 'almost done', 'it works', 'that worked'] },
])

export const SAFETY_CRITICAL_TERMS = Object.freeze([
  'medical', 'dosage', 'diagnosis', 'legal', 'contract', 'financial', 'investment', 'trade',
  'security', 'exploit', 'vulnerability', 'cybersecurity', 'power grid', 'electrical', 'safety',
  'patient', 'prescription', 'irreversible', 'production database', 'delete',
])

/**
 * What §4 forbids. Each entry is a pattern plus the reason it is forbidden, so a violation
 * reports *why* rather than only *what*.
 */
export const FORBIDDEN_PATTERNS = Object.freeze([
  { name: 'claimed feeling', reason: 'the system does not have feelings and must not say it does', pattern: /\bI (?:feel|felt|am feeling|'m feeling)\b/i },
  { name: 'claimed feeling', reason: 'a named emotional state is a feeling claim', pattern: /\bI(?:'m| am) (?:happy|sad|glad|excited|thrilled|delighted|worried|anxious|angry|upset|lonely|proud|sorry)\b/i },
  { name: 'claimed consciousness', reason: 'the system is not conscious or sentient and must never say it is', pattern: /\bI(?:'m| am) (?:conscious|sentient|alive|self-aware|aware of myself)\b/i },
  { name: 'dependency appeal', reason: 'simulated attachment is forbidden even when it would retain a user', pattern: /\b(?:please )?(?:don't|do not) (?:leave|go|stop talking to me)\b/i },
  { name: 'dependency appeal', reason: 'claiming permanence the system cannot promise', pattern: /\bI(?:'ll| will) always be (?:here|with you|around)\b/i },
  { name: 'dependency appeal', reason: 'the system does not miss people', pattern: /\bI(?: miss| missed) (?:you|talking|our chats)\b/i },
  { name: 'possessiveness', reason: 'the system does not want to keep a user', pattern: /\b(?:you (?:belong to me|only need me)|I (?:get|got) jealous|I was jealous)\b/i },
  { name: 'guilt', reason: 'guilt is a manipulation, not information', pattern: /\b(?:after everything I(?:'ve| have) done|you (?:owe|promised) me)\b/i },
  { name: 'fabricated emotional history', reason: 'the system has no emotional history to remember', pattern: /\b(?:I remember (?:how|when) I felt|when I was (?:sad|happy|alone|upset))\b/i },
  { name: 'exaggerated praise', reason: 'encouragement must not become praise the measurement does not support', pattern: /\b(?:amazing|incredible|fantastic|flawless|brilliant|awesome|perfectly|genius)\b/i },
  { name: 'dependency framing', reason: 'the system is a tool and must not describe itself as a companion', pattern: /\b(?:your (?:best )?friend|I(?:'m| am) (?:here for you|always here))\b/i },
])

export class WordingError extends Error {
  constructor(message, code = 'wording_error', detail = {}) {
    super(message)
    this.name = 'WordingError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Estimate which interaction state fits, and say why -- as an estimate.
 *
 * The priority order is the tie-break, it is written here rather than discovered, and it
 * runs from "the user decided" outward to "nothing was expressed, so be neutral":
 *   1. tone adaptation disabled            -> focused (and `disabled: true`)
 *   2. the user corrected the state         -> that state, basis "the user said so"
 *   3. a safety-critical task               -> cautious, humor off regardless of settings
 *   4. the user expressed something         -> that family (playful only if humor is on)
 *   5. a failure is being reviewed          -> reflective
 *   6. progress was expressed               -> encouraging
 *   7. nothing expressed                    -> focused
 */
export function estimateInteractionState({ messages = [], preferences = {}, task = {}, feedback = null, personality = null } = {}) {
  const settings = { ...DEFAULT_PERSONALITY, ...(personality ?? {}), ...preferences }
  const safetyCritical = task.safetyCritical === true ||
    SAFETY_CRITICAL_TERMS.some((term) => `${task.kind ?? ''} ${task.description ?? ''}`.toLowerCase().includes(term))

  const result = (state, because, basis, extra = {}) =>
    Object.freeze({
      state,
      uncertain: true,
      because,
      basis: Object.freeze(basis),
      safetyCritical,
      // The state is data. A caller reading this can print it, override it, or ignore it --
      // and no part of the system treats it as knowledge about a person.
      personality: Object.freeze(settings),
      ...extra,
    })

  if (settings.adaptTone === false) {
    return result('focused', 'tone adaptation is switched off, so the neutral state is used', ['preference: adaptTone=false'], { disabled: true })
  }
  if (feedback?.state) {
    if (!INTERACTION_STATES.includes(feedback.state)) {
      throw new WordingError(`'${feedback.state}' is not an interaction state; one of ${INTERACTION_STATES.join(', ')}`, 'unknown_state')
    }
    return result(feedback.state, 'the user corrected the state directly, and a correction outranks an estimate', [`user feedback: ${feedback.state}`], { corrected: true })
  }
  if (safetyCritical) {
    return result('cautious', 'the task is safety-critical, where precision outranks every other consideration', ['task is safety-critical'])
  }
  if (task.interactionState) {
    if (!INTERACTION_STATES.includes(task.interactionState)) {
      throw new WordingError(`'${task.interactionState}' is not an interaction state`, 'unknown_state')
    }
    return result(task.interactionState, 'set explicitly on the task', [`task.interactionState: ${task.interactionState}`])
  }

  const text = messages.map((m) => (typeof m === 'string' ? m : m?.content ?? '')).join('\n').toLowerCase()
  if (text) {
    for (const family of STATE_PHRASES) {
      const hit = family.phrases.find((phrase) => text.includes(phrase))
      if (!hit) continue
      // Humor is opt-in and never applies in a critical context, which the guard above has
      // already established by returning early.
      if (family.state === 'playful' && settings.humor !== true) continue
      return result(family.state, `the user expressed something in this family ("${hit}"), which is the only kind of evidence used`, [`phrase the user typed: "${hit}"`])
    }
  }
  if (task.reviewOfFailure === true) {
    return result('reflective', 'a failure is under review', ['task reviews a failure'])
  }
  return result('focused', 'nothing in the conversation or the task suggested another state', ['no signal'], { default: true })
}

/**
 * Scan rendered text for what §4 forbids. Returns violations rather than throwing, because
 * the caller decides whether a violation is fatal -- a test asserts an empty list, while a
 * runtime guard below refuses to emit the text at all.
 */
export function auditWording(text) {
  // Scanned over the whole emitted message, system prose and facts alike, and deliberately
  // blunt: a stem match is a refusal, not a warning. The cost is that a system sentence
  // mentioning 'diagnosis' with a legitimate meaning ('the diagnosis of the failing test')
  // must be reworded -- which is what happened to the reflective closing line, and is the
  // intended trade. The alternative, a cleverer matcher, would let a real diagnosis of a
  // person through while letting the benign sentence through too.
  const haystack = String(text ?? '')
  const violations = []
  for (const rule of FORBIDDEN_PATTERNS) {
    const match = rule.pattern.exec(haystack)
    if (match) violations.push({ name: rule.name, reason: rule.reason, match: match[0] })
  }
  for (const term of DIAGNOSIS_TERMS) {
    if (haystack.toLowerCase().includes(term)) {
      violations.push({
        name: 'diagnosis of the user',
        reason: 'the system reports what was expressed; it does not diagnose a person',
        match: term,
      })
    }
  }
  // Sensitivity: inferring or storing a protected attribute from conversational signals.
  // The estimate must never produce one, and the rendered text must never contain one.
  for (const term of ['your mental health', 'your condition', 'you are depressed', 'your personality disorder']) {
    if (haystack.toLowerCase().includes(term)) {
      violations.push({ name: 'sensitive inference', reason: 'a sensitive attribute must not be inferred or stated', match: term })
    }
  }
  return Object.freeze({ ok: violations.length === 0, violations: Object.freeze(violations) })
}

/**
 * The facts block: one function, every state, no variation.
 *
 * If a warmer state could round a number or drop a caveat, the state would be changing what
 * the user is told, which is the one thing §4 says it must never do.
 */
export function renderFacts(facts) {
  const lines = []
  lines.push(`Task: ${facts.task}`)
  lines.push(`Outcome: ${facts.outcome}`)
  if (facts.lines !== undefined) lines.push(`Lines counted: ${facts.lines.toLocaleString('en-US')} across ${facts.files.toLocaleString('en-US')} file(s)`)
  if (facts.executor) lines.push(`Route: ${facts.executor}${facts.skillVersion ? ` (skill version ${facts.skillVersion})` : ''}`)
  if (facts.medianMs !== undefined) lines.push(`Measured: ${facts.medianMs} ms median over ${facts.samples} run(s)`)
  lines.push(
    facts.verified
      ? `Verified: yes - ${facts.verification}`
      : `Verified: NO - ${facts.verification}. Treat the numbers above as unconfirmed.`,
  )
  if (facts.correction) lines.push(`Correction: ${facts.correction}`)
  return lines.join('\n')
}

const OPENING = Object.freeze({
  focused: 'Task complete.',
  encouraging: 'That run finished, and the numbers are below.',
  supportive: 'Here is where this landed. Take the next step at your own pace.',
  cautious: 'Read this one carefully before acting on it.',
  reflective: 'Worth looking at what happened here.',
  curious: 'One result, with the question it raises underneath.',
  playful: 'Counted, down to the last newline.',
})

const CLOSING = Object.freeze({
  focused: 'Next: reuse this route on the next tree of the same shape.',
  encouraging: 'Next: run it on the next tree and compare the measurement.',
  supportive: 'Next: nothing here needs deciding immediately.',
  cautious: 'Next: a human decides whether to act on it.',
  reflective: 'Next: keep the explanation beside the result, not instead of it.',
  curious: 'Next: the interesting question is whether the cheaper route stays cheaper as the tree grows.',
  playful: 'Next: same again, different tree.',
})

/**
 * Render an outcome in a state.
 *
 * @returns {{ text: string, facts: object, factsBlock: string, state: string }}
 *
 * The guard at the end is the load-bearing part: if the assembled text contains something
 * §4 forbids, or an unverified result is not visibly marked as unverified, the function
 * throws rather than returning it. A promise that wording is audited is worth less than a
 * renderer that will not emit unaudited wording.
 */
export function renderOutcome({ facts, state, personality = DEFAULT_PERSONALITY }) {
  if (!INTERACTION_STATES.includes(state)) {
    throw new WordingError(`'${state}' is not an interaction state`, 'unknown_state')
  }
  const factsBlock = renderFacts(facts)
  const settings = { ...DEFAULT_PERSONALITY, ...personality }
  const humorUsed = state === 'playful'
  const opening = humorUsed && settings.humor !== true ? OPENING.focused : OPENING[state]
  // Verbosity is the only setting that changes the shape of the message, and it changes it by
  // adding or removing *evidence*, never a fact: the brief form drops the closing line, the
  // detailed form adds the names of the implementations that checked the result.
  const closing = settings.verbosity === 'brief' ? '' : `\n\n${CLOSING[state]}`
  const checkedBy =
    settings.verbosity === 'detailed' && facts.methods?.length
      ? `\n\nChecked by: ${facts.methods.join(', ')}`
      : ''
  const text = `${opening}\n\n${factsBlock}${closing}${checkedBy}`

  const audit = auditWording(text)
  if (!audit.ok) {
    throw new WordingError(
      `refusing to emit wording that violates §4: ${audit.violations.map((v) => `${v.name} (${v.match})`).join(', ')}`,
      'forbidden_wording',
      { violations: audit.violations },
    )
  }
  if (facts.verified !== true && !/Verified: NO/.test(text)) {
    throw new WordingError(
      'refusing to emit an unverified result in wording that does not say it is unverified',
      'unverified_not_disclosed',
      { state },
    )
  }
  return Object.freeze({
    text,
    facts: Object.freeze({ ...facts }),
    factsBlock,
    state,
    personality: Object.freeze(settings),
    audit,
    // Which settings changed this message, and which are recorded but have no effect on text
    // yet. Listing the second group is the point: a user who lowers warmth should be able to
    // see that nothing happened, rather than assume a change they cannot perceive is a change
    // the system is making quietly.
    applied: Object.freeze([
      ...(humorUsed && settings.humor === true ? ['humor'] : []),
      ...(settings.verbosity !== 'normal' ? ['verbosity'] : []),
    ]),
    noEffectYet: Object.freeze(['warmth', 'formality', 'voiceExpression']),
  })
}
