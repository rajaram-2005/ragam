// Routing: what may run, what may not, and why.
//
// The tests that carry weight here are the refusals. "A capable candidate is chosen" is the
// feature; "a candidate that fails a privacy constraint is refused even when it is the only
// one that could do the job, and the refusal names the constraint" is the property that
// keeps the feature from quietly becoming a data-egress path.

import test from 'node:test'
import assert from 'node:assert/strict'

import { CapabilityError, assertMayRead, validateCapability, withinScope } from '../src/adaptive/capability.mjs'
import { routeTask, RoutingError } from '../src/adaptive/router.mjs'

const tool = (overrides = {}) =>
  validateCapability({
    id: 'counter',
    kind: 'tool',
    provides: ['tree.line-count'],
    permissions: { fsRead: ['/work/tree'], fsWrite: [], network: false },
    ...overrides,
  })

// --- descriptors ---------------------------------------------------------------

test('a capability with an unmeasured cost declared as a measurement is refused', () => {
  // The failure this prevents: an author writing `cost: { medianMs: 5 }` by hand, which then
  // outranks a real measurement taken on this machine.
  assert.throws(
    () => tool({ cost: { medianMs: 5 } }),
    (error) => error instanceof CapabilityError && error.code === 'unmeasured_cost',
  )
})

test('a capability id and its kind are validated, and a bad one names what was wrong', () => {
  assert.throws(() => tool({ id: 'Not Kebab' }), (e) => e.code === 'invalid_id')
  assert.equal(tool({ kind: 'model' }).kind, 'model', 'all three kinds are valid: tools, skills and models')
  assert.throws(() => tool({ kind: 'wizard' }), (e) => e.code === 'invalid_kind')
  assert.throws(() => tool({ provides: [] }), (e) => e.code === 'no_capabilities')
  assert.throws(() => tool({ provides: ['nonsense'] }), (e) => e.code === 'invalid_capability_tag')
})

test('the returned descriptor is frozen, so a later mutation cannot change a decision made on it', () => {
  const descriptor = tool()
  assert.ok(Object.isFrozen(descriptor))
  assert.throws(() => { descriptor.id = 'somethingelse' }, TypeError)
  assert.throws(() => { descriptor.permissions.fsRead.push('/etc') }, TypeError)
})

// --- permissions ---------------------------------------------------------------

test('read scope is a boundary, not a prefix comparison', () => {
  const scope = ['/work/tree']
  assert.equal(withinScope(scope, '/work/tree'), true)
  assert.equal(withinScope(scope, '/work/tree/sub/file.mjs'), true)
  // The classic bug: '/work/treehouse' starts with '/work/tree' as a string and is not inside it.
  assert.equal(withinScope(scope, '/work/treehouse/file.mjs'), false)
  assert.equal(withinScope(scope, '/work/other/file.mjs'), false)
  assert.equal(withinScope(scope, '/work/tree/../other'), false)
})

test('an executor refuses a path outside its declared scope, and says which scope it has', () => {
  const descriptor = tool()
  assert.doesNotThrow(() => assertMayRead(descriptor, '/work/tree/a.mjs'))
  assert.throws(
    () => assertMayRead(descriptor, '/etc/passwd'),
    (error) =>
      error instanceof CapabilityError &&
      error.code === 'permission_denied' &&
      /declared read scope is \[\/work\/tree\]/.test(error.message),
  )
})

// --- routing -------------------------------------------------------------------

test('the cheapest measured candidate that satisfies the constraints is chosen', () => {
  const slow = tool({ id: 'slow', cost: { measured: { medianMs: 40, samples: 3, input: 'tree A' } } })
  const fast = tool({ id: 'fast', cost: { measured: { medianMs: 12, samples: 3, input: 'tree A' } } })
  const decision = routeTask({ capabilities: ['tree.line-count'] }, [slow, fast])
  assert.equal(decision.chosen.id, 'fast')
  assert.match(decision.chosen.because, /12 ms median over 3 run\(s\) on tree A/)
  assert.equal(decision.alternatives.length, 1)
  assert.equal(decision.alternatives[0].id, 'slow')
  assert.equal(decision.alternatives[0].relativeCost, 12 / 40)
})

test('an unmeasured candidate loses to a measured one and is never treated as free', () => {
  const measured = tool({ id: 'measured', cost: { measured: { medianMs: 900, samples: 2, input: 'tree A' } } })
  const unknown = tool({ id: 'unknown' })
  const decision = routeTask({ capabilities: ['tree.line-count'] }, [measured, unknown])
  assert.equal(decision.chosen.id, 'measured')
})

test('with nothing measured, the choice is made and marked as unmeasured rather than implied precise', () => {
  const decision = routeTask({ capabilities: ['tree.line-count'] }, [tool({ id: 'alpha' }), tool({ id: 'beta' })])
  assert.equal(decision.chosen.id, 'alpha', 'ties break by id so two runs agree')
  assert.equal(decision.chosen.unmeasured, true)
  assert.match(decision.chosen.because, /unmeasured/)
})

test('a privacy constraint refuses an external candidate even when it is the only one that fits', () => {
  const external = tool({ id: 'cloud-counter', privacy: 'external' })
  const decision = routeTask({ capabilities: ['tree.line-count'] }, [external])
  assert.equal(decision.chosen, null)
  assert.equal(decision.refused.code, 'constraints_unsatisfied')
  assert.equal(decision.considered[0].code, 'privacy')
  assert.match(decision.considered[0].reason, /External execution is opt-in per request/)

  // And the same candidate is routable once external use is explicitly permitted.
  const allowed = routeTask({ capabilities: ['tree.line-count'] }, [external], { allowExternal: true })
  assert.equal(allowed.chosen.id, 'cloud-counter')
})

test('a latency budget refuses an unmeasured candidate instead of assuming it is fast', () => {
  const unbudgeted = routeTask({ capabilities: ['tree.line-count'] }, [tool()])
  assert.equal(unbudgeted.chosen.id, 'counter', 'an unmeasured candidate is usable when no budget is set')

  const budgeted = routeTask({ capabilities: ['tree.line-count'], maxLatencyMs: 50 }, [tool()])
  assert.equal(budgeted.chosen, null)
  assert.equal(budgeted.considered[0].code, 'latency')
  assert.match(budgeted.considered[0].reason, /An unmeasured route cannot be shown to meet a latency bound/)
})

test('a measured candidate over budget is refused with the measurement that refused it', () => {
  const slow = tool({ cost: { measured: { medianMs: 120, samples: 3, input: 'tree A' } } })
  const decision = routeTask({ capabilities: ['tree.line-count'], maxLatencyMs: 50 }, [slow])
  assert.equal(decision.chosen, null)
  assert.match(decision.considered[0].reason, /measured 120 ms against a 50 ms budget/)
})

test('a pinned candidate is honoured only if it survived every constraint', () => {
  const inside = tool({ id: 'inside' })
  const outside = tool({ id: 'outside', permissions: { fsRead: ['/somewhere/else'], fsWrite: [], network: false } })
  const task = { capabilities: ['tree.line-count'], within: '/work/tree' }
  const honoured = routeTask(task, [inside], { preferId: 'inside' })
  assert.equal(honoured.chosen.id, 'inside')

  // Pinning cannot smuggle past a gate: it is filtered before the preference is applied.
  const refused = routeTask(task, [inside, outside], { preferId: 'outside' })
  assert.equal(refused.chosen.id, 'inside')
  assert.equal(refused.considered.find((c) => c.id === 'outside').code, 'permission')
})

test('a task with no route is refused with every candidate named, rather than degrading', () => {
  const decision = routeTask({ capabilities: ['tree.line-count', 'tree.semantic-diff'] }, [tool()])
  assert.equal(decision.chosen, null)
  assert.equal(decision.considered.length, 1)
  assert.equal(decision.considered[0].code, 'no_capability')
  assert.match(decision.considered[0].reason, /tree\.line-count, tree\.semantic-diff/)
})

test('a request that names no capability is a programming error, not a refusal', () => {
  assert.throws(() => routeTask({ capabilities: [] }, [tool()]), (e) => e instanceof RoutingError && e.code === 'no_capabilities')
  assert.throws(() => routeTask({ capabilities: ['tree.line-count'] }, null), (e) => e.code === 'no_candidates')
})
