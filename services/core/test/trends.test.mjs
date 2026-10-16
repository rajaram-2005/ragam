// Trend awareness is knowing what is current and knowing when you no longer know. These tests
// pin the refusals: no source, no date, no observation; an expired observation is stale, not
// current; and an empty window produces an abstention rather than an assertion.
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_WINDOW_DAYS, TrendError, TrendLedger } from '../src/klyvaron/trends.mjs'

const FIXED_NOW = Date.parse('2026-10-15T12:00:00Z')
const clock = () => FIXED_NOW
const ledger = (options = {}) => new TrendLedger({ now: clock, ...options })

const observation = (overrides = {}) => ({
  topic: 'browser support for local models',
  claim: 'Two major browsers ship an on-device inference API.',
  sourceUrl: 'https://example.org/reports/on-device-ai',
  observedAt: '2026-10-10T09:00:00Z',
  ttlDays: 30,
  licence: 'CC-BY-4.0',
  ...overrides,
})

test('an observation needs a source, a date, a ttl and a licence', () => {
  const store = ledger()
  assert.throws(() => store.observe(observation({ sourceUrl: '' })), /needs a source URL/)
  assert.throws(() => store.observe(observation({ sourceUrl: 'not a url' })), /is not a URL/)
  assert.throws(() => store.observe(observation({ sourceUrl: 'ftp://example.org/x' })), /http\(s\)/)
  assert.throws(() => store.observe(observation({ observedAt: 'sometime last week' })), /is not a date/)
  assert.throws(() => store.observe(observation({ ttlDays: 0 })), /ttlDays must be a positive number/)
  assert.throws(() => store.observe(observation({ licence: '' })), /licence is required/)
  assert.throws(() => store.observe(observation({ topic: '' })), /topic is required/)
  assert.throws(() => store.observe(observation({ claim: '   ' })), /claim is required/)
  // An observation cannot have observed the future.
  assert.throws(() => store.observe(observation({ observedAt: '2027-01-01T00:00:00Z' })), /in the future/)
  assert.equal(store.entries().length, 0, 'a refused observation is not stored')
})

test('a stored observation keeps its source, date and licence, and defaults its window', () => {
  const entry = ledger().observe(observation({ ttlDays: undefined, sourceName: undefined }))
  assert.equal(entry.sourceUrl, 'https://example.org/reports/on-device-ai')
  assert.equal(entry.sourceName, 'example.org')
  assert.equal(entry.observedAt, '2026-10-10T09:00:00.000Z')
  assert.equal(entry.ttlDays, DEFAULT_WINDOW_DAYS)
  assert.equal(entry.licence, 'CC-BY-4.0')
})

test('current() answers with the age and the source, not with the claim alone', () => {
  const store = ledger()
  store.observe(observation())
  const answer = store.current({ topic: 'browser support for local models' })
  assert.equal(answer.abstained, false)
  assert.equal(answer.entries.length, 1)
  assert.equal(answer.entries[0].ageDays, 5.125)
  assert.match(answer.statement, /observed 2026-10-10T09:00:00\.000Z \(5\.125 day\(s\) ago\) by example\.org/)
  assert.match(answer.statement, /https:\/\/example\.org\/reports\/on-device-ai/)
})

test('an observation past its ttl is stale, and an empty window abstains instead of asserting', () => {
  const store = ledger()
  store.observe(observation({ observedAt: '2026-09-01T09:00:00Z', ttlDays: 14 }))
  const answer = store.current({ topic: 'browser support for local models' })
  assert.equal(answer.abstained, true)
  assert.deepEqual(answer.entries, [])
  assert.equal(answer.stale.length, 1)
  assert.match(answer.statement, /Nothing on "browser support for local models" is inside the 30-day window/)
  assert.match(answer.statement, /Refreshing the source is what answers this, not a guess/)

  // A topic with nothing at all says so, and names the time it checked.
  const empty = store.current({ topic: 'something nobody observed' })
  assert.equal(empty.abstained, true)
  assert.match(empty.statement, /nothing is asserted. Checked at 2026-10-15T12:00:00\.000Z/)
})

test('the caller\'s window is applied as well as the observation\'s own ttl', () => {
  const store = ledger()
  store.observe(observation()) // 5.125 days old, ttl 30
  assert.equal(store.current({ topic: 'browser support for local models', maxAgeDays: 3 }).abstained, true,
    'a ttl is a ceiling, not permission to ignore the question\'s window')
  assert.equal(store.current({ topic: 'browser support for local models', maxAgeDays: 6 }).abstained, false)
  assert.throws(() => store.current({ topic: 'x', maxAgeDays: -1 }), /maxAgeDays must be a positive number/)
})

test('expire() removes only what is past its ttl, and returns what it removed', () => {
  const store = ledger()
  store.observe(observation({ topic: 'old', observedAt: '2026-08-01T09:00:00Z', ttlDays: 7 }))
  store.observe(observation({ topic: 'fresh' }))
  const removed = store.expire()
  assert.equal(removed.length, 1)
  assert.equal(removed[0].topic, 'old')
  assert.deepEqual(store.topics(), ['fresh'])
})

test('a ledger survives a round trip, and a rebuild keeps its refusals', () => {
  const store = ledger()
  store.observe(observation())
  store.observe(observation({ topic: 'tooling', claim: 'A new runtime shipped.', sourceUrl: 'https://example.net/x', observedAt: '2026-10-14T09:00:00Z' }))
  const restored = TrendLedger.fromJSON(JSON.parse(JSON.stringify(store.toJSON())), { now: clock })
  assert.deepEqual(restored.entries(), store.entries())
  assert.equal(restored.current({ topic: 'tooling' }).abstained, false)
  // Storing a claim that would have been refused does not become possible by loading it.
  const bad = { version: 1, entries: [{ ...observation(), sourceUrl: '' }] }
  assert.throws(() => TrendLedger.fromJSON(bad, { now: clock }), TrendError)
})
