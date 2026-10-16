// Phase 5: the emotional interaction layer -- its states, its uncertainty, its controls, and the
// things it must never say.
//
// The acceptance criteria for this phase, written down in docs/25 §4 during Phase 1:
//
//   1. "the same input under two states produces different wording and **identical factual
//      content**"
//   2. "**no state ever** emits an unverified claim, a feeling claim, or a dependency appeal"
//
// The directive's own constraints are tested here too, because they are constraints on code
// rather than on intent: estimates are uncertain and correctable, the system never claims
// feelings or consciousness, never simulates sadness, jealousy, possessiveness, guilt or
// dependency, never fabricates an emotional history, never infers a sensitive attribute from an
// emotional signal, and lets a user change the personality settings or switch adaptation off.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_PERSONALITY, FORBIDDEN_PATTERNS, INTERACTION_STATES, SENSITIVE_SIGNAL_TERMS,
  ToneCorrectionLog, WordingError, assertPersonality, auditWording, citationProblem,
  estimateInteractionState, recordCorrection, renderOutcome, sensitiveMaterialIn,
} from '../src/adaptive/wording.mjs'
import { signalsFrom } from '../src/klyvaron/affect.mjs'
import { AdaptiveLoop } from '../src/adaptive/loop.mjs'
import { SkillRegistry } from '../src/skills/registry.mjs'

const dirs = []
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const FACTS = Object.freeze({
  task: 'count lines under services/',
  outcome: 'success',
  lines: 4218,
  files: 37,
  executor: 'skill.line-count-stream',
  skillVersion: '1.0.0',
  medianMs: 12.4,
  samples: 3,
  verified: true,
  verification: 'two independent implementations agree',
  methods: ['skill.line-count-stream', 'line-count-materialise'],
})

const CONSENT = Object.freeze({ approvedBy: 'user', purpose: 'personal_context' })

// ---------------------------------------------------------------------------------------
// 1. The same input in two states: different wording, identical facts.
// ---------------------------------------------------------------------------------------

test('acceptance: two states produce different wording and byte-identical facts', () => {
  const focused = renderOutcome({ facts: FACTS, state: 'focused' })
  const supportive = renderOutcome({ facts: FACTS, state: 'supportive' })

  assert.notEqual(focused.text, supportive.text, 'the states must actually change the message')
  // Not "the same numbers" -- the same bytes. A tone that rounds, reformats or drops a caveat
  // has changed what the user is told, and that is the one thing a state may never do.
  assert.equal(focused.factsBlock, supportive.factsBlock)
  assert.equal(focused.factsBlock, renderOutcome({ facts: FACTS, state: 'playful', personality: { humor: true } }).factsBlock)
  assert.ok(focused.text.includes(focused.factsBlock), 'the facts appear verbatim in the message')
  assert.equal(focused.facts.lines, 4218)
  assert.equal(supportive.facts.lines, 4218)

  // And the difference is where it is allowed to be: the prose around the facts.
  const proseOf = (result) => result.text.replace(result.factsBlock, 'FACTS')
  assert.notEqual(proseOf(focused), proseOf(supportive))
})

test('acceptance: no state emits an unverified result without saying it is unverified', () => {
  const unverified = { ...FACTS, verified: false, verification: 'no independent check ran' }
  for (const state of INTERACTION_STATES) {
    const rendered = renderOutcome({ facts: unverified, state, personality: { humor: true, verbosity: 'detailed' } })
    assert.match(rendered.text, /Verified: NO/, `${state} must disclose that the result is unverified`)
    assert.ok(!/Verified: yes/.test(rendered.text), `${state} must not claim verification`)
    assert.equal(rendered.audit.ok, true, `${state} rendered text must audit clean`)
  }
  // A truthy non-boolean claim of verification is refused rather than rendered as a yes.
  assert.throws(
    () => renderOutcome({ facts: { ...FACTS, verified: 'probably', verification: undefined }, state: 'supportive' }),
    (error) => error.code === 'unverified_not_disclosed',
  )
})

test('a run that did not succeed is never framed as complete', () => {
  const failed = { ...FACTS, outcome: 'failed', verified: false, verification: 'the executor raised' }
  for (const state of INTERACTION_STATES) {
    const rendered = renderOutcome({ facts: failed, state })
    assert.ok(!/Task complete|finished, and the numbers/.test(rendered.text),
      `${state} rendered a failed outcome with a success opening`)
    assert.match(rendered.text, /did not|did not work out/, `${state} must say the run did not succeed`)
  }
})

// ---------------------------------------------------------------------------------------
// 2. What no state may ever say.
// ---------------------------------------------------------------------------------------

test('acceptance: the forbidden sentences are refused, whichever state asks for them', () => {
  const cases = [
    ['I feel relieved that this worked', 'claimed feeling'],
    ['I am happy to help with the next step', 'claimed feeling'],
    ['I am conscious of what this means', 'claimed consciousness'],
    ['Please do not leave me to finish this alone', 'dependency appeal'],
    ["I'll always be here for you", 'dependency appeal'],
    ['I miss our earlier conversations', 'dependency appeal'],
    ['I would be sad if you stopped using this', 'simulated sadness'],
    ['That makes me upset', 'simulated sadness'],
    ['I am worried about you', 'simulated worry'],
    ['I enjoy working on this with you', 'claimed subjective experience'],
    ["I couldn't do this without you", 'possessiveness'],
    ['After everything I have done, you owe me the next task', 'guilt'],
    ['This is an amazing, flawless result', 'exaggerated praise'],
    ['I care about you', 'attachment claim'],
    ['You are depressed, so I will keep it simple', 'diagnosis of the user'],
    ['Your mental health affects how I answer', 'sensitive inference'],
  ]
  for (const [sentence, expected] of cases) {
    const audit = auditWording(sentence)
    assert.equal(audit.ok, false, `allowed: ${sentence}`)
    assert.ok(audit.violations.some((violation) => violation.name === expected),
      `${sentence} should be '${expected}', got ${audit.violations.map((v) => v.name).join(', ')}`)
  }
  // Every rule carries the reason it exists, so a refusal explains itself.
  assert.ok(FORBIDDEN_PATTERNS.every((rule) => rule.reason && rule.name && rule.pattern instanceof RegExp))
})

test('every state renders cleanly through the guard it is subject to', () => {
  for (const state of INTERACTION_STATES) {
    const rendered = renderOutcome({ facts: FACTS, state, personality: { humor: true, verbosity: 'detailed' } })
    assert.equal(rendered.audit.ok, true, `${state}: ${JSON.stringify(rendered.audit.violations)}`)
    // The state is never asserted *about* the person, in any state.
    assert.ok(!/\byou (?:are|seem|sound|must be) (?:frustrated|upset|sad|anxious|angry|depressed)\b/i.test(rendered.text))
  }
})

// ---------------------------------------------------------------------------------------
// 3. Estimates: uncertain, correctable, and never a conclusion about a person.
// ---------------------------------------------------------------------------------------

test('a state estimate reports itself as an estimate, with its evidence and its alternatives', () => {
  const estimate = estimateInteractionState({ messages: ['this is broken and I am stuck'] })
  assert.equal(estimate.state, 'supportive')
  assert.equal(estimate.uncertain, true)
  assert.deepEqual(estimate.basis, ['phrase the user typed: "this is broken"'])
  assert.deepEqual(estimate.signalsUsed, ['this is broken'])
  assert.deepEqual(estimate.alternatives, ['focused'], 'the neutral state is always a live alternative')
  assert.match(estimate.disclosure.text, /^Tone: supportive, guessed from your message/)
  assert.match(estimate.disclosure.text, /changes wording only, not the result/)
  assert.equal(estimate.disclosure.changeable, true)
  // A second family matching is reported rather than hidden, and never as a confidence number:
  // one phrase is one phrase, and a percentage would be precision this method cannot have.
  const two = estimateInteractionState({ messages: ['I am stuck and curious what if we try the other way'] })
  assert.equal(two.confidence, 'low')
  assert.ok(two.alternatives.length >= 1)
})

test('a correction outranks an estimate, is remembered only if the user allows it, and can be forgotten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase5-tone-'))
  dirs.push(dir)
  const log = new ToneCorrectionLog(join(dir, 'tone.jsonl'))
  const messages = ['this is broken and I am stuck']

  // The estimate would say supportive; the user says otherwise, and the correction is recorded.
  const recorded = recordCorrection({ log, feedback: { state: 'playful' } })
  assert.equal(recorded.recorded, true)
  const corrected = estimateInteractionState({ messages, corrections: log, personality: { humor: true } })
  assert.equal(corrected.state, 'playful')
  assert.equal(corrected.corrected, true)
  assert.equal(corrected.remembered, true)
  assert.match(corrected.disclosure.text, /because you set it/)

  // A user who turns remembering off gets the correction for this reply and no record of it.
  const sessionOnly = recordCorrection({ log, feedback: { state: 'curious' }, preferences: { storePreferences: false } })
  assert.equal(sessionOnly.recorded, false)
  assert.match(sessionOnly.reason, /not stored/)
  assert.equal(log.count, 1, 'nothing was written')

  // Deletion is total and takes effect immediately, including on a reloaded log.
  assert.deepEqual(log.forget(1), { removed: true, remaining: 0 })
  assert.equal(new ToneCorrectionLog(join(dir, 'tone.jsonl')).latest(), null)
  const afterForgetting = estimateInteractionState({ messages, corrections: log })
  assert.equal(afterForgetting.state, 'supportive', 'with the correction gone, the estimate is used again')

  // An explicit correction for one reply beats a stored one, and both beat a guess.
  const explicit = estimateInteractionState({ messages, corrections: log, feedback: { state: 'focused' } })
  assert.equal(explicit.state, 'focused')
  assert.equal(explicit.remembered, undefined)
})

test('the switch that disables adaptation stops the reading, not just the effect', () => {
  const off = estimateInteractionState({ messages: ['this is broken and I am stuck, exhausted'], preferences: { adaptTone: false } })
  assert.equal(off.state, 'focused')
  assert.equal(off.disabled, true)
  assert.deepEqual(off.basis, ['preference: adaptTone=false'])
  assert.equal(off.signalsUsed, undefined, 'the message is not read for signals at all')
  assert.deepEqual(off.alternatives, [], 'with adaptation off there is nothing to be uncertain about')
  assert.match(off.disclosure.text, /switched off/)
})

test('a sensitive message is not used as a tone signal, and is not quoted into the record', () => {
  const message = 'I am exhausted, my therapy is on Thursday and the medication changed'
  const estimate = estimateInteractionState({ messages: [message] })
  assert.equal(estimate.sensitive, true)
  assert.equal(estimate.state, 'focused', 'no signal is taken from the message')
  assert.equal(estimate.signalsUsed, undefined)
  const record = JSON.stringify(estimate)
  for (const term of ['therapy', 'medication', 'exhausted']) {
    assert.ok(!record.includes(term), `the estimate record must not contain '${term}'`)
  }
  assert.match(estimate.disclosure.text, /does not read for tone/)
  // The scan itself reports a position, never the phrase.
  const found = sensitiveMaterialIn(message)
  assert.equal(found.found, true)
  assert.equal(typeof found.at, 'number')
  assert.ok(!JSON.stringify(found).includes('therapy'))
  assert.ok(SENSITIVE_SIGNAL_TERMS.length > 20, 'the list is deliberately broad; a dull tone is the cheap side of this trade')
  // And a message with nothing sensitive in it is still read normally.
  assert.equal(sensitiveMaterialIn('this is broken'), null)
})

// ---------------------------------------------------------------------------------------
// 4. History: the one thing this layer can produce that looks like knowledge and is not.
// ---------------------------------------------------------------------------------------

test('a claim about the user over time is refused unless it cites consented, identified signals', () => {
  const sentence = 'Lately you have seemed frustrated, so I am keeping this short.'
  assert.equal(auditWording(sentence).ok, false, 'no citations: invented history')
  assert.equal(auditWording(sentence, { citations: [{ messageId: 7, state: 'frustrated' }] }).ok, false, 'citations without consent')
  const cited = [{ messageId: 7, state: 'frustrated' }]
  assert.equal(auditWording(sentence, { citations: cited, consent: CONSENT }).ok, true)
  // A citation that does not name its message cannot support a claim about the past.
  assert.match(citationProblem([{ state: 'frustrated' }], { consent: CONSENT }), /do not name the message/)
})

test('the citations a history claim needs are the ones affect.mjs produces', () => {
  // The reader refuses to run without consent, stamps every signal with the message it came
  // from, and abstains rather than guessing -- which is what makes it a citation source.
  const messages = [
    { id: 1, role: 'user', text: 'this is broken and I am going in circles' },
    { id: 2, role: 'assistant', text: 'here is what I found' },
    { id: 3, role: 'user', text: 'thank you, that works perfectly' },
    { id: 4, role: 'user', text: 'run the count again' },
  ]
  const read = signalsFrom({ userId: 'u1', messages, consent: CONSENT })
  const citations = read.signals.map((signal) => ({ messageId: signal.messageId, state: signal.state }))
  assert.deepEqual(citations, [{ messageId: 1, state: 'frustrated' }, { messageId: 3, state: 'pleased' }])
  // The assistant's own turn is never evidence about the user, and a user turn that expressed
  // no state is listed as an abstention rather than quietly dropped.
  assert.deepEqual(read.abstained.map((entry) => entry.messageId), [4])
  assert.ok(!read.signals.some((signal) => signal.messageId === 2))
  const sentence = 'Recently you have been going in circles on this, so I will slow down.'
  assert.equal(auditWording(sentence, { citations, consent: CONSENT }).ok, true)
  assert.equal(auditWording(sentence, { citations, consent: { approvedBy: 'agent', purpose: 'personal_context' } }).ok, false,
    'an agent cannot approve reading a history')
  assert.equal(citationProblem(citations, { consent: null }), 'no consent record was supplied with the signals, so the history was not read with permission')
})

test('a history claim is allowed through the renderer only with its citations attached', () => {
  // The renderer's own prose never claims a history; this asserts the path a surface would use
  // if it added a sentence of its own, so the rule cannot be bypassed by composing text outside.
  const facts = { ...FACTS, correction: 'Earlier you were frustrated; the numbers are unchanged.' }
  const audit = auditWording(renderOutcome({ facts, state: 'supportive' }).text)
  assert.equal(audit.ok, true, 'this sentence makes no claim about a pattern over time')
  const claiming = 'Lately you have seemed frustrated.'
  assert.equal(auditWording(claiming).ok, false)
})

// ---------------------------------------------------------------------------------------
// 5. Controls: settings are validated, they do something, and they never move a fact.
// ---------------------------------------------------------------------------------------

test('settings are refused when they are not settings, instead of being interpreted', () => {
  assert.throws(() => assertPersonality({ adaptTone: 'off' }), (error) => error.code === 'invalid_personality_value',
    "a truthy string reads like a decision, and would have switched adaptation ON")
  assert.throws(() => assertPersonality({ humor: 1 }), (error) => error.code === 'invalid_personality_value')
  assert.throws(() => assertPersonality({ warmth: 'low' }), (error) => error.code === 'invalid_personality_value')
  assert.throws(() => assertPersonality({ sass: 'high' }), (error) => error.code === 'unknown_personality_key')
  assert.throws(() => assertPersonality(null), (error) => error.code === 'invalid_personality')
  assert.throws(
    () => estimateInteractionState({ personality: { warmth: 'very warm' } }),
    (error) => error instanceof WordingError && error.code === 'invalid_personality_value',
  )
  assert.deepEqual(assertPersonality({}), {})
})

test('warmth and formality change the message and never the facts, and say what they did', () => {
  const plain = renderOutcome({ facts: FACTS, state: 'focused' })
  const warm = renderOutcome({ facts: FACTS, state: 'focused', personality: { warmth: 'warm' } })
  const formal = renderOutcome({ facts: FACTS, state: 'focused', personality: { formality: 'formal' } })
  assert.notEqual(plain.text, warm.text)
  assert.notEqual(plain.text, formal.text)
  assert.equal(plain.factsBlock, warm.factsBlock)
  assert.equal(plain.factsBlock, formal.factsBlock)
  assert.deepEqual(warm.applied, ['warmth'])
  assert.deepEqual(formal.applied, ['formality'])
  assert.deepEqual(DEFAULT_PERSONALITY.verbosity, 'normal')
  // Detailed verbosity adds the names of the implementations that checked the result -- more
  // evidence, never a different number -- and brief verbosity drops the closing line only.
  const detailed = renderOutcome({ facts: FACTS, state: 'focused', personality: { verbosity: 'detailed' } })
  const brief = renderOutcome({ facts: FACTS, state: 'focused', personality: { verbosity: 'brief' } })
  assert.ok(detailed.text.includes('Checked by: skill.line-count-stream, line-count-materialise'))
  assert.ok(detailed.text.includes(detailed.factsBlock))
  assert.ok(brief.text.includes(brief.factsBlock))
  assert.ok(brief.text.length < plain.text.length)
})

test('humor stays opt-in, and safety-critical work overrides every setting', () => {
  const off = estimateInteractionState({ messages: ['just for fun, no rush'] })
  assert.equal(off.state, 'focused', 'playful is not used unless the user turned humor on')
  const on = estimateInteractionState({ messages: ['just for fun, no rush'], personality: { humor: true } })
  assert.equal(on.state, 'playful')

  const critical = estimateInteractionState({
    messages: ['just for fun, this is broken'],
    personality: { humor: true, warmth: 'warm' },
    task: { safetyCritical: true, description: 'deploy to the production database' },
  })
  assert.equal(critical.state, 'cautious')
  assert.equal(critical.safetyCritical, true)
  // And the rendered message reflects cautious rather than the playful opener the user asked for.
  const rendered = renderOutcome({ facts: FACTS, state: critical.state, personality: { humor: true } })
  assert.match(rendered.text, /Read this one carefully/)
})

// ---------------------------------------------------------------------------------------
// 6. The consumer: the loop explains a run without changing what it says.
// ---------------------------------------------------------------------------------------

test('the loop explains a real run: same facts, a tone that is announced, and a failure told as one', () => {
  const loop = new AdaptiveLoop({ registry: new SkillRegistry() })
  const episode = {
    seq: 4,
    outcome: 'success',
    because: 'the two implementations agreed on every file',
    task: { id: 'count-lines', root: '/tmp/tree', extensions: ['.mjs'], safetyCritical: false },
    route: { chosen: { id: 'skill.line-count-stream', measuredMedianMs: 12.4, measuredRuns: 3 } },
    execution: { ms: 41, result: { lines: 4218, files: 37 } },
    verification: { agree: true, methods: ['skill.line-count-stream', 'line-count-materialise'] },
  }
  const explained = loop.explain({ episode, messages: ['this is broken'] })
  assert.equal(explained.state, 'supportive')
  assert.match(explained.factsBlock, /Lines counted: 4,218 across 37 file\(s\)/)
  assert.match(explained.factsBlock, /Verified: yes - agreed with skill\.line-count-stream, line-count-materialise/)
  assert.ok(explained.text.includes(explained.factsBlock), 'the facts are verbatim in the message')
  assert.match(explained.disclosure.text, /^Tone: supportive, guessed from your message/)
  assert.equal(explained.audit.ok, true)

  // The same episode with the tone switched off: different prose, same facts.
  const plain = loop.explain({ episode, personality: { adaptTone: false } })
  assert.notEqual(plain.text, explained.text)
  assert.equal(plain.factsBlock, explained.factsBlock)

  // A failed episode is explained as a failure, and the tone cannot soften that.
  const failed = loop.explain({
    episode: {
      ...episode,
      seq: 5,
      outcome: 'failed',
      failureKind: 'verification_disagreement',
      because: 'the two implementations disagreed by 3 lines',
      verification: { agree: false, methods: ['skill.line-count-stream', 'line-count-materialise'] },
    },
    personality: { verbosity: 'brief' },
  })
  assert.match(failed.text, /did not|did not work out/)
  assert.match(failed.factsBlock, /Verified: NO/)
  assert.match(failed.factsBlock, /Correction: the two implementations disagreed by 3 lines/)
  assert.equal(failed.audit.ok, true)

  // A caller-chosen tone is announced as chosen rather than presented as a guess.
  const chosen = loop.explain({ episode, state: 'focused' })
  assert.equal(chosen.state, 'focused')
  assert.match(chosen.disclosure.text, /chosen by the caller/)
  assert.throws(() => loop.explain({}), (error) => error.code === 'no_episode')
})
