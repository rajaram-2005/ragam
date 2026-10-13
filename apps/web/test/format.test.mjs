// Formatting helpers.
//
// Small functions, but they decide how the platform's state is *described* to the
// user. A status rendered green when the server said "degraded" is a false claim,
// so the mapping is pinned here rather than left to eyeballing the UI.

import test from 'node:test'
import assert from 'node:assert/strict'
import { toneFor, formatValue, clip, shortId } from '../src/format.js'

test('backend statuses map to the tone they actually deserve', () => {
  const expectations = {
    ok: ['ready', 'ok', 'enabled', 'succeeded', 'passed', 'released', 'accepted', 'online', 'verified', 'complete'],
    warn: ['degraded', 'partial', 'awaiting_approval', 'paused', 'unverified', 'simulated', 'needs_hardware', 'limited', 'retrying', 'planned_only'],
    bad: ['failed', 'error', 'blocked', 'cancelled', 'timed_out', 'rejected', 'offline', 'unreachable', 'disabled', 'denied', 'budget_exceeded', 'uninstalled'],
    info: ['running', 'pending', 'queued', 'probing', 'installed'],
  }
  for (const [tone, statuses] of Object.entries(expectations)) {
    for (const status of statuses) assert.equal(toneFor(status), tone, `${status} should be '${tone}'`)
  }
})

test('the status vocabulary the core actually emits is fully covered', () => {
  // Task states from services/core/src/godcore/lifecycle.mjs.
  for (const state of ['pending', 'running', 'awaiting_approval', 'paused', 'succeeded', 'partial', 'failed', 'cancelled', 'timed_out']) {
    assert.ok(toneFor(state), `task state '${state}' has no tone and would render neutral`)
  }
  // Readiness and provider states.
  for (const state of ['ready', 'degraded', 'blocked', 'not_installed', 'unavailable', 'probing']) {
    // not_installed/unavailable are deliberately unmapped: they are absence, not
    // failure, and a neutral chip is the honest rendering. Assert that explicitly.
    if (state === 'not_installed' || state === 'unavailable') {
      assert.equal(toneFor(state), undefined, `${state} should stay neutral`)
    } else {
      assert.ok(toneFor(state), `'${state}' has no tone`)
    }
  }
  // Plugin states.
  for (const state of ['installed', 'enabled', 'disabled', 'uninstalled']) {
    assert.ok(toneFor(state), `plugin state '${state}' has no tone`)
  }
  // MCP risk tiers are not statuses and must not be silently coloured.
  for (const risk of ['read_only', 'write', 'destructive', 'external', 'system']) {
    assert.equal(toneFor(risk), undefined, `risk tier '${risk}' is not a status`)
  }
})

test('an unknown status stays neutral instead of defaulting to green', () => {
  assert.equal(toneFor('something-new'), undefined)
  assert.equal(toneFor(''), undefined)
  assert.equal(toneFor(null), undefined)
  assert.equal(toneFor(undefined), undefined)
})

test('tone matching is case-insensitive but not substring-loose', () => {
  assert.equal(toneFor('READY'), 'ok')
  assert.equal(toneFor('Ready'), 'ok')
  // 'not ready' must not match 'ready' and turn red into green.
  assert.equal(toneFor('not ready'), undefined)
  assert.equal(toneFor('failed-check'), undefined)
})

test('formatValue renders every backend value type without inventing data', () => {
  assert.equal(formatValue(null), '—')
  assert.equal(formatValue(undefined), '—')
  assert.equal(formatValue(true), 'yes')
  assert.equal(formatValue(false), 'no', 'false must be visible, not blank')
  assert.equal(formatValue(0), '0', 'zero must be visible')
  assert.equal(formatValue(42), '42')
  assert.equal(formatValue(0.33516), '0.3352')
  assert.equal(formatValue('text'), 'text')
  assert.equal(formatValue([]), '(none)')
  assert.equal(formatValue(['a', 'b']), 'a, b')
  assert.deepEqual(JSON.parse(formatValue({ a: 1 })), { a: 1 })
})

test('clip truncates visibly and leaves short values alone', () => {
  assert.equal(clip('short', 60), 'short')
  const long = 'x'.repeat(80)
  const clipped = clip(long, 60)
  assert.equal(clipped.length, 61)
  assert.ok(clipped.endsWith('…'), 'truncation must be marked')
  assert.equal(clip(null), '—')
})

test('shortId prefixes identifiers without claiming uniqueness', () => {
  assert.equal(shortId('abcdef1234567890'), 'abcdef12')
  assert.equal(shortId('abcdef1234567890', 4), 'abcd')
  assert.equal(shortId(null), '')
})
