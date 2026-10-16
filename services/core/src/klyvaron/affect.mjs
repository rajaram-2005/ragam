// The user's expressed state across a session, and the history of the models that served it.
//
// The goal is not a mood detector. It is the opposite: a reader that knows only what the user
// actually said, can quote it, and otherwise says nothing.
//
// THE RULES ARE THE CODE
//
//   1  CONSENT FIRST. `signalsFrom()` refuses without an explicit user approval record. A
//      session cannot be analysed because it exists.
//   2  THE USER'S OWN WORDS ONLY. Only `role: 'user'` messages are read. The assistant's
//      output is never evidence about the user -- otherwise a model that says "you sound
//      frustrated" creates the very state it then reports.
//   3  CITE THE MESSAGE. Every signal carries the message id it came from and the phrase that
//      produced it. A signal with no citation is a guess, and there is no code path that makes
//      one: the state comes from a closed phrase list.
//   4  ABSTAIN. A message with no phrase in that list produces no signal and is listed in
//      `abstained`. Writing style, punctuation, response latency and message length are never
//      read, so a terse message is not read as anger.
//   5  NO DIAGNOSIS. Every state is one of a small set of ordinary words. Nothing here names
//      a condition, and the generated statement is checked against a banned list.
//   6  ONE USER, DELETABLE. Signals are computed from the messages given and are never stored.
//      Removing a message removes its signals by construction, because they exist only in the
//      return value of a call that included it.
//
// This is NOT the `affect.history` capability. That needs a model artifact and held-out
// evaluation (see tiers.mjs and docs/22). This module is the mechanism, tested here.

/** The closed set of states. Ordinary words; nothing clinical is representable. */
export const AFFECT_STATES = Object.freeze([
  'pleased', 'excited', 'frustrated', 'stuck', 'confused', 'worried', 'tired', 'upset',
])

/**
 * Phrases that count as an expression of a state, and the state each one expresses. Matching
 * is case-insensitive and requires the phrase to appear in the user's own message. The list is
 * deliberately short: every entry is one a person typed, not one a classifier inferred.
 *
 * When a message contains phrases from more than one family, the FIRST family in this list
 * wins. That order is the whole tie-break: it is deterministic, it is visible here, and it does
 * not depend on which phrase is longer or more emotional.
 */
export const AFFECT_PHRASES = Object.freeze([
  { state: 'frustrated', phrases: ['frustrated', 'so annoying', 'this is broken', 'fed up', 'sick of this'] },
  { state: 'stuck', phrases: ['i am stuck', "i'm stuck", 'going in circles', 'no idea what to do', 'went nowhere'] },
  { state: 'confused', phrases: ['confused', 'i do not understand', "i don't understand", 'makes no sense to me'] },
  { state: 'worried', phrases: ['worried', 'nervous', 'anxious', 'scared'] },
  { state: 'tired', phrases: ['exhausted', 'burnt out', 'burned out', 'too tired', 'overwhelmed'] },
  { state: 'upset', phrases: ['upset', 'hurt by that', 'that was unkind', 'disappointed'] },
  { state: 'pleased', phrases: ['this is great', 'love this', 'i am glad', "i'm glad", 'thank you', 'thanks a lot', 'works perfectly'] },
  { state: 'excited', phrases: ['excited about', 'looking forward to', 'cannot wait', "can't wait"] },
])

/** Words that would turn a report into a diagnosis. The generated statement is checked. */
export const DIAGNOSIS_TERMS = Object.freeze([
  'diagnos', 'disorder', 'depress', 'clinical', 'illness', 'mental health', 'symptom', 'therapy',
])

export class AffectError extends Error {
  constructor(message, code = 'affect_error') {
    super(message)
    this.name = 'AffectError'
    this.code = code
  }
}

const REQUIRED_CONSENT = Object.freeze({ approvedBy: 'user', purpose: 'personal_context' })

function consentProblem(consent) {
  if (!consent) return 'no consent record was supplied'
  if (consent.approvedBy !== REQUIRED_CONSENT.approvedBy) {
    return `consent must be approved by '${REQUIRED_CONSENT.approvedBy}', found ${JSON.stringify(consent.approvedBy ?? null)}; an agent cannot approve this`
  }
  if (consent.purpose !== REQUIRED_CONSENT.purpose) {
    return `consent purpose must be '${REQUIRED_CONSENT.purpose}', found ${JSON.stringify(consent.purpose ?? null)}`
  }
  return null
}

function matchedPhrase(text) {
  const lowered = text.toLowerCase()
  for (const { state, phrases } of AFFECT_PHRASES) {
    for (const phrase of phrases) {
      if (lowered.includes(phrase)) return { state, phrase }
    }
  }
  return null
}

/**
 * Read the user's expressed states out of a session history.
 *
 * @param {{ userId: string, messages: Array, consent: object|null }} input
 * @returns {{ userId, signals: Array, abstained: Array, statement: string }}
 */
export function signalsFrom({ userId, messages, consent = null } = {}) {
  const problem = consentProblem(consent)
  if (problem) throw new AffectError(`signalsFrom: ${problem}. A session is not consent to read it.`, 'consent_required')
  if (typeof userId !== 'string' || !userId.trim()) throw new AffectError('signalsFrom: userId is required', 'user_required')
  if (!Array.isArray(messages)) throw new AffectError('signalsFrom: messages must be an array', 'messages_required')

  const signals = []
  const abstained = []
  for (const message of messages) {
    if (message?.role !== 'user') continue // the assistant's words are never evidence about the user
    const id = message.id ?? null
    if (id === null) throw new AffectError('signalsFrom: every message needs an id so a signal can cite it', 'message_id_required')
    const match = matchedPhrase(String(message.text ?? ''))
    if (match === null) {
      abstained.push({ messageId: id, reason: 'nothing about how the user feels was expressed' })
      continue
    }
    signals.push({
      messageId: id,
      at: message.at ?? null,
      state: match.state,
      // The exact words, so the report can be checked against the message it came from.
      phrase: match.phrase,
      // Which model served this turn, so a change in behaviour is attributable to a version
      // rather than to the user.
      modelVersion: message.modelVersion ?? null,
    })
  }
  const body = signals.length === 0
    ? `No expressed state in ${abstained.length} message(s): nothing is reported.`
    : `${signals.length} expressed state(s) from ${signals.length + abstained.length} message(s): `
      + signals.map((s) => `${s.state} (message ${s.messageId}: "${s.phrase}")`).join('; ')
      + '. Derived from the user\'s own words only.'
  // The check runs on the body, before the standing disclaimer is appended, so the disclaimer
  // cannot be what makes the check pass.
  for (const term of DIAGNOSIS_TERMS) {
    if (body.toLowerCase().includes(term)) {
      throw new AffectError(`the generated statement contains ${JSON.stringify(term)}, a clinical word; a report is not a diagnosis`, 'diagnosis_refused')
    }
  }
  const statement = `${body} This is not a diagnosis.`
  return { userId, signals, abstained, statement }
}

/**
 * What changed, if anything did.
 *
 * Fewer than two signals is not a trajectory, and `direction` is null rather than a guess.
 */
export function trajectory({ signals } = {}) {
  if (!Array.isArray(signals)) throw new AffectError('trajectory: signals must be an array', 'signals_required')
  const counts = {}
  for (const signal of signals) counts[signal.state] = (counts[signal.state] ?? 0) + 1
  if (signals.length < 2) {
    return {
      counts,
      direction: null,
      changed: false,
      statement: `${signals.length} signal(s): a trajectory is not claimed from fewer than two.`,
    }
  }
  const ordered = [...signals]
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const changed = first.state !== last.state
  return {
    counts,
    direction: changed ? `${first.state} -> ${last.state}` : first.state,
    changed,
    statement: changed
      ? `From ${first.state} (message ${first.messageId}) to ${last.state} (message ${last.messageId}).`
      : `The state stayed ${first.state} across ${ordered.length} signals (first message ${first.messageId}, latest ${last.messageId}).`,
  }
}

/**
 * Delete a message and everything derived from it.
 *
 * Signals are recomputed from the messages that remain and never stored, so deletion is total:
 * there is no second copy to forget. Returns the new history and the message it removed.
 */
export function forget({ messages, messageId } = {}) {
  if (!Array.isArray(messages)) throw new AffectError('forget: messages must be an array', 'messages_required')
  const removed = messages.filter((message) => message?.id === messageId)
  if (removed.length === 0) throw new AffectError(`forget: no message has id ${JSON.stringify(messageId)}`, 'message_not_found')
  return { messages: messages.filter((message) => message?.id !== messageId), removed }
}
