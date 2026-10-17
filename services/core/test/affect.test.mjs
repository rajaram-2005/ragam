// Reading the user's expressed state: consent, their words, a citation, or an abstention.
//
// Each test here is one of the rules in the module header. The interesting ones are the
// refusals -- no consent, no citation, no signal, no diagnosis -- because those are the
// behaviours that make a report about somebody's feelings worth reading at all.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AFFECT_PHRASES, AFFECT_STATES, AffectError, DIAGNOSIS_TERMS, forget, signalsFrom, trajectory,
} from '../src/klyvaron/affect.mjs'

const CONSENT = { approvedBy: 'user', purpose: 'personal_context' }

const history = () => [
  { id: 'm1', role: 'user', text: 'This is broken again.', at: '2026-10-15T09:00:00Z', modelVersion: 'aetheris-lite-lm-0.1.1' },
  { id: 'm2', role: 'assistant', text: 'You sound frustrated, and I am stuck too.', at: '2026-10-15T09:01:00Z', modelVersion: 'aetheris-lite-lm-0.1.1' },
  { id: 'm3', role: 'user', text: 'hmm, ok.', at: '2026-10-15T09:02:00Z', modelVersion: 'klyvaron-pro-0.1.0' },
  { id: 'm4', role: 'user', text: 'Thank you, works perfectly now.', at: '2026-10-15T09:05:00Z', modelVersion: 'klyvaron-pro-0.1.0' },
]

test('nothing is read without the user\'s consent, and an agent cannot give it', () => {
  assert.throws(() => signalsFrom({ userId: 'u1', messages: history() }), /no consent record was supplied/)
  assert.throws(() => signalsFrom({ userId: 'u1', messages: history(), consent: { approvedBy: 'agent', purpose: 'personal_context' } }),
    /an agent cannot approve this/)
  assert.throws(() => signalsFrom({ userId: 'u1', messages: history(), consent: { approvedBy: 'user', purpose: 'training' } }),
    /purpose must be 'personal_context'/)
  assert.throws(() => signalsFrom({ userId: '', messages: history(), consent: CONSENT }), /userId is required/)
  assert.throws(() => signalsFrom({ userId: 'u1', messages: 'not an array', consent: CONSENT }), /messages must be an array/)
  assert.throws(() => signalsFrom({ userId: 'u1', messages: [{ role: 'user', text: 'stuck' }], consent: CONSENT }),
    /every message needs an id so a signal can cite it/)
})

test('only the user\'s own words count, and each signal cites the message and phrase', () => {
  const result = signalsFrom({ userId: 'u1', messages: history(), consent: CONSENT })
  assert.equal(result.userId, 'u1')
  // The assistant's message says "frustrated" and "stuck"; neither becomes evidence, because a
  // model that says "you sound frustrated" would otherwise create the state it reports.
  assert.deepEqual(result.signals.map((s) => s.messageId), ['m1', 'm4'])
  assert.deepEqual(result.signals.map((s) => s.state), ['frustrated', 'pleased'])
  assert.equal(result.signals[0].phrase, 'this is broken')
  assert.equal(result.signals[1].phrase, 'thank you')
  assert.equal(result.signals[0].modelVersion, 'aetheris-lite-lm-0.1.1')
  assert.match(result.statement, /message m1: "this is broken"/)
  assert.match(result.statement, /This is not a diagnosis\.$/)
})

test('a message that expresses nothing produces an abstention, not a weaker signal', () => {
  const result = signalsFrom({
    userId: 'u1',
    consent: CONSENT,
    messages: [
      { id: 'a', role: 'user', text: 'Fix the parser.', at: '2026-10-15T09:00:00Z' },
      { id: 'b', role: 'user', text: 'No. Yes. Maybe.', at: '2026-10-15T09:01:00Z' },
      // Terse and full of negative words, but no expression of a state: nothing is inferred
      // from how somebody writes.
      { id: 'c', role: 'user', text: 'ugh. whatever. broken!!!', at: '2026-10-15T09:02:00Z' },
    ],
  })
  assert.deepEqual(result.signals, [])
  assert.equal(result.abstained.length, 3)
  assert.match(result.statement, /No expressed state in 3 message\(s\): nothing is reported\./)
  assert.match(result.statement, /not a diagnosis/i)
})

test('a trajectory needs at least two signals, and cites the messages it spans', () => {
  const one = signalsFrom({ userId: 'u1', consent: CONSENT, messages: [history()[0]] })
  const single = trajectory({ signals: one.signals })
  assert.equal(single.direction, null)
  assert.equal(single.changed, false)
  assert.match(single.statement, /not claimed from fewer than two/)

  const both = trajectory({ signals: signalsFrom({ userId: 'u1', messages: history(), consent: CONSENT }).signals })
  assert.equal(both.direction, 'frustrated -> pleased')
  assert.equal(both.changed, true)
  assert.deepEqual(both.counts, { frustrated: 1, pleased: 1 })
  assert.match(both.statement, /From frustrated \(message m1\) to pleased \(message m4\)\./)
  assert.throws(() => trajectory({ signals: null }), /signals must be an array/)
})

test('a state that is not a plain word from the closed list cannot be reported', () => {
  for (const { state } of AFFECT_PHRASES) {
    assert.ok(AFFECT_STATES.includes(state), `${state} is not in AFFECT_STATES`)
  }
  const result = signalsFrom({ userId: 'u1', messages: history(), consent: CONSENT })
  for (const signal of result.signals) assert.ok(AFFECT_STATES.includes(signal.state))
  assert.equal(result.statement.toLowerCase().includes('diagnos'), true)
  assert.match(result.statement, /not a diagnosis/)
  // No clinical vocabulary is produced, and the module refuses to build a statement that
  // contains any of it.
  for (const term of DIAGNOSIS_TERMS) assert.ok(!result.statement.toLowerCase().includes(`${term} `) || term === 'diagnos')
})

test('deleting a message deletes its signals, because nothing was stored', () => {
  const messages = history()
  const before = signalsFrom({ userId: 'u1', messages, consent: CONSENT })
  assert.equal(before.signals.length, 2)
  const { messages: after, removed } = forget({ messages, messageId: 'm1' })
  assert.equal(removed.length, 1)
  assert.deepEqual(after.map((m) => m.id), ['m2', 'm3', 'm4'])
  const afterSignals = signalsFrom({ userId: 'u1', messages: after, consent: CONSENT })
  assert.deepEqual(afterSignals.signals.map((s) => s.messageId), ['m4'])
  assert.throws(() => forget({ messages, messageId: 'nope' }), AffectError)
})
