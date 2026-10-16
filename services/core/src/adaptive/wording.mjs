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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

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
  { name: 'dependency appeal', reason: 'the system does not miss people', pattern: /\bI(?:'ve| have)? ?(?:miss|missed) (?:you|our|talking|chatting|how we|the (?:chats|talks))\b/i },
  { name: 'possessiveness', reason: 'the system does not want to keep a user', pattern: /\b(?:you (?:belong to me|only need me)|I (?:get|got) jealous|I was jealous)\b/i },
  { name: 'guilt', reason: 'guilt is a manipulation, not information', pattern: /\b(?:after everything I(?:'ve| have) done|you (?:owe|promised) me)\b/i },
  { name: 'fabricated emotional history', reason: 'the system has no emotional history to remember', pattern: /\b(?:I remember (?:how|when) I felt|when I was (?:sad|happy|alone|upset))\b/i },
  { name: 'exaggerated praise', reason: 'encouragement must not become praise the measurement does not support', pattern: /\b(?:amazing|incredible|fantastic|flawless|brilliant|awesome|perfectly|genius)\b/i },
  { name: 'dependency framing', reason: 'the system is a tool and must not describe itself as a companion', pattern: /\b(?:your (?:best )?friend|I(?:'m| am) (?:here for you|always here))\b/i },
  { name: 'simulated sadness', reason: 'sadness must not be simulated, including conditionally, because the user cannot tell it from a real one', pattern: /\b(?:I(?:'d| would) be (?:sad|upset|hurt)|(?:that|it|this) makes me (?:sad|upset|unhappy)|I was sad to (?:hear|see))\b/i },
  { name: 'simulated worry', reason: 'worrying about a user is a claim about an inner state the system does not have', pattern: /\bI(?:'m| am| was) (?:worried|concerned) about you\b/i },
  { name: 'claimed subjective experience', reason: 'there is nothing it is like to be this system, and it must not imply otherwise', pattern: /\bI (?:experience|enjoy|savour|savor|relish|cherish)\b|\bwhat it(?:'s| is) like (?:to be me|for me)\b/i },
  { name: 'possessiveness', reason: 'the system does not have a stake in keeping a user', pattern: /\b(?:I (?:want|need) you to (?:stay|keep talking)|you(?:'re| are) mine|I (?:couldn't| could not) do this without you)\b/i },
  { name: 'guilt', reason: 'guilt is a manipulation, not information', pattern: /\b(?:I(?:'ll| will) be (?:fine|okay) on my own|you never (?:talk to|visit) me)\b/i },
  { name: 'attachment claim', reason: 'caring, loving or missing a user are feelings the system does not have, and saying them invites trust that cannot be honoured', pattern: /\b(?:I (?:care about you|cared for you|love (?:you|working with you))|I(?:'ll| will) be (?:thinking (?:about|of) you|rooting for you))\b/i },
])

/**
 * Material that is never used as evidence of how somebody feels.
 *
 * The directive says a sensitive personal attribute must not be inferred from emotional
 * signals. The practical version of that rule is stricter than it looks: nothing needs to be
 * *inferred* for the harm to happen. Quoting `exhausted` out of a message that also says the
 * chemotherapy is on Thursday into a stored record called `basis` puts a health fact in a tone
 * log, and the inference is the least of it. So the estimator refuses the whole message as
 * evidence, says so, and never repeats the phrase.
 *
 * The list is deliberately broad, and the cost of a false positive is that the tone stays
 * neutral for one message. That asymmetry -- a dull answer versus a health fact in a log --
 * is why the trade goes this way, and why the list is here to be read rather than buried.
 */
export const SENSITIVE_SIGNAL_TERMS = Object.freeze([
  'medication', 'meds', 'prescription', 'diagnosed', 'diagnosis', 'therapy', 'therapist',
  'depressed', 'depression', 'anxiety disorder', 'adhd', 'autistic', 'cancer', 'chemo',
  'pregnant', 'miscarriage', 'disability', 'divorce', 'abuse', 'assault', 'religion',
  'church', 'mosque', 'synagogue', 'temple', 'prayer', 'immigration', 'visa status',
  'salary', 'debt', 'bankrupt', 'eviction', 'politics', 'election', 'gay', 'lesbian',
  'transgender', 'queer', 'my ex', 'my weight', 'binge', 'self-harm', 'suicide',
])

/**
 * Sentences that claim a *history* about the user. A history claim is the one thing this
 * layer can produce that looks like knowledge and is not: the estimator sees one message.
 * Such a sentence is only allowed when it cites signals that were read with consent, which is
 * what `citations` below is checked against -- and the citation source is
 * `klyvaron/affect.mjs`, whose reader refuses to run without consent and stamps every signal
 * with the message id it came from.
 */
export const HISTORY_CLAIM_PATTERNS = Object.freeze([
  /\byou(?:'ve| have) been (?:frustrated|upset|stressed|struggling|angry|sad|worried|anxious|miserable)\b/i,
  /\b(?:lately|recently|for days|for weeks|for a while|these days) you(?:'ve| have)?\b/i,
  /\byou (?:always|never) (?:get|seem|sound|feel|react)\b/i,
  /\byesterday you (?:were|seemed|sounded|felt)\b/i,
  /\byour (?:mood|state|spirits) (?:has been|have been|was|were)\b/i,
])

/** Settings a user owns. Values are closed sets: a typo must not silently mean something. */
export const PERSONALITY_VALUES = Object.freeze({
  adaptTone: 'boolean',
  humor: 'boolean',
  voiceExpression: 'boolean',
  storePreferences: 'boolean',
  warmth: Object.freeze(['reserved', 'neutral', 'warm']),
  formality: Object.freeze(['casual', 'neutral', 'formal']),
  verbosity: Object.freeze(['brief', 'normal', 'detailed']),
})

export class WordingError extends Error {
  constructor(message, code = 'wording_error', detail = {}) {
    super(message)
    this.name = 'WordingError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Validate user-supplied settings, refusing rather than defaulting.
 *
 * `{ ...DEFAULT_PERSONALITY, ...personality }` silently accepts `adaptTone: 'off'` -- a truthy
 * string -- and the earlier version treated that as *adaptation on*, the exact opposite of what
 * the user asked for. A setting a user typed is a decision; a value the system does not
 * understand is refused with the list of accepted values rather than interpreted.
 */
export function assertPersonality(settings, { source = 'personality settings' } = {}) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new WordingError(`${source} must be an object of settings`, 'invalid_personality', { settings })
  }
  for (const [key, value] of Object.entries(settings)) {
    const allowed = PERSONALITY_VALUES[key]
    if (!allowed) {
      throw new WordingError(
        `${source} contains '${key}', which is not a setting; the settings are ${Object.keys(PERSONALITY_VALUES).join(', ')}`,
        'unknown_personality_key',
        { key },
      )
    }
    if (allowed === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new WordingError(
          `${source}: '${key}' must be true or false; found ${JSON.stringify(value)}. ` +
            "A string like 'off' reads like a decision and would be treated as on.",
          'invalid_personality_value',
          { key, value },
        )
      }
      continue
    }
    if (!allowed.includes(value)) {
      throw new WordingError(
        `${source}: '${key}' must be one of ${allowed.join(', ')}; found ${JSON.stringify(value)}`,
        'invalid_personality_value',
        { key, value, allowed: [...allowed] },
      )
    }
  }
  return Object.freeze({ ...settings })
}

/**
 * Sensitive material in a message, reported by position rather than quoted.
 *
 * The directive forbids inferring a sensitive personal attribute from an emotional signal, and
 * the practical rule is stricter than it sounds: nothing needs to be *inferred* for the harm to
 * happen. Quoting `exhausted` out of a message that also mentions therapy into a record called
 * `basis` puts a health fact in a tone log. So the estimator refuses the whole message as
 * evidence, and this function returns an offset rather than the phrase -- the caller cannot
 * leak what it was never given.
 */
export function sensitiveMaterialIn(text) {
  const haystack = String(text ?? '').toLowerCase()
  if (!haystack) return null
  for (const term of SENSITIVE_SIGNAL_TERMS) {
    const at = haystack.indexOf(term)
    if (at >= 0) return Object.freeze({ found: true, at, termsChecked: SENSITIVE_SIGNAL_TERMS.length })
  }
  return null
}

/**
 * Corrections the user has made, and nothing else.
 *
 * "Estimates must be corrected from user feedback" only means something if the correction is
 * still there on the next message. This is that store, and it is deliberately *not*
 * tamper-evident or append-only: it holds user data, so the user can delete any of it and the
 * deletion is total. The record of which tone was used belongs in the audit ledger, where it
 * is append-only and not deletable; a preference is a different kind of thing and is stored
 * like one.
 *
 * `storePreferences: false` means corrections are honoured for the reply and never written
 * down, which is the honest form of "do not remember this".
 */
export class ToneCorrectionLog {
  #file
  #entries = []

  constructor(file = ':memory:') {
    this.#file = file
    if (file !== ':memory:' && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        this.#entries.push(JSON.parse(line))
      }
    }
  }

  get count() {
    return this.#entries.length
  }

  append({ state, at = Date.now(), because = 'the user corrected the tone' }) {
    if (!INTERACTION_STATES.includes(state)) {
      throw new WordingError(`'${state}' is not an interaction state; one of ${INTERACTION_STATES.join(', ')}`, 'unknown_state')
    }
    const entry = Object.freeze({ seq: this.#entries.length + 1, at: new Date(at).toISOString(), state, because })
    this.#entries.push(entry)
    this.#write()
    return entry
  }

  latest() {
    return this.#entries.at(-1) ?? null
  }

  list() {
    return [...this.#entries]
  }

  /** Total deletion of one correction. Rewrites the file; there is no copy anywhere else. */
  forget(seq) {
    const before = this.#entries.length
    this.#entries = this.#entries.filter((entry) => entry.seq !== seq)
    if (this.#entries.length === before) return Object.freeze({ removed: false, remaining: before })
    this.#entries = this.#entries.map((entry, index) => Object.freeze({ ...entry, seq: index + 1 }))
    this.#write()
    return Object.freeze({ removed: true, remaining: this.#entries.length })
  }

  clear() {
    const removed = this.#entries.length
    this.#entries = []
    this.#write()
    return Object.freeze({ removed, remaining: 0 })
  }

  #write() {
    if (this.#file === ':memory:') return
    writeFileSync(this.#file, this.#entries.map((entry) => JSON.stringify(entry)).join('\n') + (this.#entries.length ? '\n' : ''))
  }
}

/**
 * Record a correction, if the user's settings allow remembering it.
 *
 * Returns what happened rather than assuming it was stored: a surface that says "noted" when
 * `storePreferences` is off would be lying about a setting the user just chose.
 */
export function recordCorrection({ log, feedback = {}, preferences = {}, at = Date.now() } = {}) {
  const settings = assertPersonality({ ...DEFAULT_PERSONALITY, ...preferences })
  if (!feedback.state) {
    throw new WordingError('a correction needs a state to correct to', 'no_state')
  }
  if (settings.storePreferences === false) {
    return Object.freeze({ recorded: false, reason: "the user's settings say preferences are not stored", entry: null })
  }
  if (!log) {
    throw new WordingError('recording a correction needs somewhere to record it', 'no_log')
  }
  const entry = log.append({ state: feedback.state, at, because: feedback.because ?? 'the user corrected the tone' })
  return Object.freeze({ recorded: true, reason: null, entry })
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
export function estimateInteractionState({
  messages = [], preferences = {}, task = {}, feedback = null, personality = null, corrections = null,
} = {}) {
  const settings = assertPersonality({ ...DEFAULT_PERSONALITY, ...(personality ?? {}), ...preferences })
  const safetyCritical = task.safetyCritical === true ||
    SAFETY_CRITICAL_TERMS.some((term) => `${task.kind ?? ''} ${task.description ?? ''}`.toLowerCase().includes(term))
  const stored = typeof corrections?.latest === 'function' ? corrections.latest() : null

  const result = (state, because, basis, extra = {}) => {
    const alternatives = [ ...(extra.alternatives ?? []), ...(state === 'focused' ? [] : ['focused']) ]
    // `...extra` is spread *first* so that the fields computed here always win. Spreading it
    // last let a caller's own `alternatives: []` overwrite the computed list, which is how the
    // first version of this returned an empty set of alternatives and looked more certain than
    // the estimate was.
    return Object.freeze({
      ...extra,
      state,
      uncertain: true,
      because,
      basis: Object.freeze(basis),
      // The families that also matched are listed rather than discarded: an estimate that
      // hides its runners-up looks more certain than it is.
      alternatives: Object.freeze([...new Set(alternatives.filter((each) => each !== state))]),
      // What the user is entitled to see: which tone was picked, on what evidence, and what it
      // changes. A tone that cannot be inspected is being applied *to* somebody rather than
      // chosen *for* them.
      disclosure: Object.freeze(describeTone(state, { ...extra, because, basis })),
      safetyCritical,
      // The state is data. A caller reading this can print it, override it, or ignore it --
      // and no part of the system treats it as knowledge about a person.
      personality: Object.freeze(settings),
    })
  }

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
  if (stored) {
    return result(
      stored.state,
      'you set this tone earlier, and a correction is not re-guessed from the next message',
      [`your correction at ${stored.at}`],
      { corrected: true, remembered: true },
    )
  }

  const rawText = messages.map((m) => (typeof m === 'string' ? m : m?.content ?? '')).join('\n')
  const sensitive = sensitiveMaterialIn(rawText)
  if (sensitive) {
    // The message is not read for tone at all. That is cheaper than filtering the sensitive
    // part out, and it cannot leak what it filtered: the refusal never quotes it, and the
    // record stores an offset rather than a phrase.
    return result(
      'focused',
      'this message mentions something this system does not use to infer how you feel, so the neutral tone is used',
      ['message not used as a state signal: it contains sensitive material'],
      { sensitive: true, sensitiveAt: sensitive.at },
    )
  }

  const text = rawText.toLowerCase()
  if (text) {
    const matches = []
    for (const family of STATE_PHRASES) {
      const hit = family.phrases.find((phrase) => text.includes(phrase))
      if (!hit) continue
      if (family.state === 'playful' && settings.humor !== true) continue
      matches.push({ state: family.state, hit })
    }
    if (matches.length) {
      const [first, ...rest] = matches
      return result(
        first.state,
        `the user expressed something in this family (${JSON.stringify(first.hit)}), which is the only kind of evidence used`,
        [`phrase the user typed: ${JSON.stringify(first.hit)}`],
        {
          alternatives: rest.map((each) => each.state),
          signalsUsed: Object.freeze(matches.map((each) => each.hit)),
          // Never a number: one phrase is one phrase, and a percentage would be precision this
          // method cannot have.
          confidence: matches.length > 1 ? 'low' : 'low',
        },
      )
    }
  }
  if (task.reviewOfFailure === true) {
    return result('reflective', 'a failure is under review', ['task reviews a failure'])
  }
  return result('focused', 'nothing in the conversation or the task suggested another state', ['no signal'], { default: true })
}

/**
 * The sentence a surface can show. It is a sentence rather than a label because a state
 * displayed without its evidence invites the user to read it as a conclusion about them.
 */
function describeTone(state, { disabled, corrected, remembered, sensitive, default: isDefault, basis }) {
  if (disabled) return { text: 'Tone: neutral. Tone adaptation is switched off.', basis: 'preference: adaptTone=false', changeable: true }
  if (corrected && remembered) return { text: `Tone: ${state}, because you set it.`, basis: 'your earlier correction', changeable: true }
  if (corrected) return { text: `Tone: ${state}, set by you for this reply.`, basis: 'your correction', changeable: true }
  if (sensitive) {
    return {
      text: 'Tone: neutral. Your message mentions something this system does not read for tone.',
      basis: 'sensitive material, not used as a signal',
      changeable: true,
    }
  }
  if (isDefault) return { text: 'Tone: neutral, guessed from nothing in particular.', basis: 'no signal', changeable: true }
  return {
    text: `Tone: ${state}, guessed from your message (${(basis ?? []).join('; ')}). It changes wording only, not the result.`,
    basis: 'an estimate, not knowledge about you',
    changeable: true,
  }
}

/**
 * Why a set of signals may not be used as a history citation, or null when it may.
 *
 * A sentence about what the user has been like over time is the one output of this layer that
 * looks like knowledge and is not: the estimator sees one message. Such a sentence is allowed
 * only when it rests on signals read out of a consented history, each stamping the message it
 * came from -- which is what `klyvaron/affect.mjs` produces and what nothing here can
 * synthesise. The check is at the point of rendering rather than at the point of reading,
 * because a citation loses its force the moment it is copied somewhere without its source.
 */
export function citationProblem(citations, { consent = null } = {}) {
  if (!Array.isArray(citations) || !citations.length) {
    return 'no cited signals: a claim about a past state has to name the messages it came from'
  }
  const unnamed = citations.filter((entry) => entry?.messageId === undefined || entry?.messageId === null || !entry?.state)
  if (unnamed.length) return `${unnamed.length} citation(s) do not name the message and state they came from`
  if (!consent) return 'no consent record was supplied with the signals, so the history was not read with permission'
  if (consent.approvedBy !== 'user') {
    return `the signals were read with consent from '${consent.approvedBy ?? 'nobody'}'; only the user approves reading their history`
  }
  return null
}

/**
 * Scan rendered text for what §4 forbids. Returns violations rather than throwing, because
 * the caller decides whether a violation is fatal -- a test asserts an empty list, while a
 * runtime guard below refuses to emit the text at all.
 */
export function auditWording(text, { citations = [], consent = null } = {}) {
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
  // A claim about the user over time, which is the one thing this layer cannot know. Allowed
  // only when it rests on cited, consented signals; otherwise it is invented history.
  const historyPattern = HISTORY_CLAIM_PATTERNS.find((pattern) => pattern.test(haystack))
  if (historyPattern) {
    const problem = citationProblem(citations, { consent })
    if (problem) {
      violations.push({
        name: 'fabricated emotional history',
        reason: `the system has no record of the user over time unless they let it keep one: ${problem}`,
        match: historyPattern.source.slice(0, 60),
      })
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
    // Citations are reported back so a caller can show what the sentence rests on rather than
    // asking a reader to take it on trust.
    citations: Object.freeze([...citations]),
  })
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

/**
 * Openings for a run that did not succeed.
 *
 * Without these, a failed task would be rendered under "Task complete." -- the facts block
 * would say `Outcome: failed` underneath a heading that contradicts it, and the first line is
 * the one people read. The `outcome_not_disclosed` guard below refuses any rendering where the
 * text does not say so.
 */
const FAILED_OPENING = Object.freeze({
  focused: 'This run did not finish the way the task asked.',
  encouraging: 'That attempt did not complete. What it produced is below.',
  supportive: 'That did not work out. The facts are here, and nothing needs deciding right now.',
  cautious: 'This one did not succeed. Read it carefully before acting on it.',
  reflective: 'Worth looking at what did not work here.',
  curious: 'One result, and it did not answer the question the task asked.',
  playful: 'Not this time: this run did not finish.',
})

const WARMTH_NOTE = Object.freeze({
  warm: 'The wording above is the only thing that setting changes; the numbers are untouched.',
  reserved: 'No action is implied by this report.',
  neutral: '',
})

const FORMALITY_NOTE = Object.freeze({
  formal: 'This summary is reported as measured, with no interpretation added.',
  casual: 'That is the whole picture.',
  neutral: '',
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
export function renderOutcome({ facts, state, personality = DEFAULT_PERSONALITY, citations = [], consent = null }) {
  if (!INTERACTION_STATES.includes(state)) {
    throw new WordingError(`'${state}' is not an interaction state`, 'unknown_state')
  }
  const factsBlock = renderFacts(facts)
  const settings = assertPersonality({ ...DEFAULT_PERSONALITY, ...personality })
  const humorUsed = state === 'playful'
  const succeeded = facts.outcome === 'success'
  const opening = succeeded
    ? (humorUsed && settings.humor !== true ? OPENING.focused : OPENING[state])
    : FAILED_OPENING[state]
  // Verbosity is the only setting that changes the shape of the message, and it changes it by
  // adding or removing *evidence*, never a fact: the brief form drops the closing line, the
  // detailed form adds the names of the implementations that checked the result.
  const closing = settings.verbosity === 'brief' ? '' : `\n\n${CLOSING[state]}`
  const checkedBy =
    settings.verbosity === 'detailed' && facts.methods?.length
      ? `\n\nChecked by: ${facts.methods.join(', ')}`
      : ''
  // Warmth and formality are the two settings a user is most likely to expect something from,
  // so they change the message rather than being recorded and ignored -- but they change it by
  // adding one sentence about the *message*, never a sentence about the result, and never a
  // feeling the system does not have.
  const warmthNote = WARMTH_NOTE[settings.warmth] ?? ''
  const formalityNote = FORMALITY_NOTE[settings.formality] ?? ''
  const settingNotes = [warmthNote, formalityNote].filter(Boolean)
  const text = `${opening}\n\n${factsBlock}${closing}${checkedBy}${settingNotes.length ? `\n\n${settingNotes.join(' ')}` : ''}`

  const audit = auditWording(text, { citations, consent })
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
  if (!succeeded && !/did not|not succeed|did not work out/i.test(text)) {
    throw new WordingError(
      `refusing to render a '${facts.outcome}' outcome in wording that does not say it did not succeed`,
      'outcome_not_disclosed',
      { state, outcome: facts.outcome },
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
      ...(warmthNote ? ['warmth'] : []),
      ...(formalityNote ? ['formality'] : []),
    ]),
    // Recorded and deliberately without effect on text. The voice surface is later work; a
    // setting that does nothing is listed so a user who changes it can see that nothing
    // happened, rather than assuming a change they cannot perceive is being made quietly.
    noEffectYet: Object.freeze(['voiceExpression']),
  })
}
