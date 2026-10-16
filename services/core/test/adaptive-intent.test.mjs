// Intent -> registry -> plan. The tests that carry this file are the refusals: an unresolved
// request produces a question rather than a default, a plan against an uninstalled capability
// names the capability, and a plan that cannot be run as written says so instead of being
// quietly shortened.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CONFIDENCE, INTENT_RULES, SENSITIVE_TERMS, readIntent, requiredCapabilities } from '../src/adaptive/intent.mjs'
import { CapabilityRegistry, RegistryError, registryFrom } from '../src/adaptive/registry.mjs'
import { PlanError, canonical, digestOf, planSteps, singleStepPlan } from '../src/adaptive/plan.mjs'
import { makeLineCountExecutors } from '../src/adaptive/executors.mjs'

function makeTree(name, files) {
  const root = mkdtempSync(join(tmpdir(), `adaptive-intent-${name}-`))
  return { root, files }
}

const cleanup = []
test.after(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }) })

function executors() {
  const root = mkdtempSync(join(tmpdir(), 'adaptive-intent-tree-'))
  cleanup.push(root)
  return makeLineCountExecutors({ roots: [root] })
}

// --- intent ---------------------------------------------------------------------

test('a request that names a capability produces the capability tag and the phrase it came from', () => {
  const intent = readIntent({ utterance: 'count the lines under services/core' })
  assert.equal(intent.resolved, true)
  assert.deepEqual(intent.capabilities, ['tree.line-count'])
  assert.equal(intent.confidence, CONFIDENCE.STATED)
  // Evidence, not a label: the phrase that produced the requirement is recorded.
  assert.match(intent.because.join(' '), /count-lines-exact: 'count the lines' \(stated\)/)
  assert.equal(intent.emotionalSignalsUsed, false)
})

test('a paraphrase resolves as inferred, and says so', () => {
  const intent = readIntent({ utterance: 'what is the LOC of the tree?' })
  assert.equal(intent.resolved, true)
  assert.equal(intent.confidence, CONFIDENCE.INFERRED)
  assert.match(intent.because.join(' '), /count-lines-paraphrase/)
})

test('a request nothing here can serve is refused with a question, not a default', () => {
  const intent = readIntent({ utterance: 'summarise the architecture document in Bengali' })
  assert.equal(intent.resolved, false)
  assert.deepEqual(intent.capabilities, [])
  assert.equal(intent.confidence, null)
  assert.match(intent.clarification, /Which of the capabilities this installation provides/)
  assert.match(intent.limitation, /refused rather than answered by a model that is not present/)
})

test('an empty utterance raises rather than resolving to nothing', () => {
  assert.throws(() => readIntent({ utterance: '   ' }), (error) => error.code === 'empty_utterance')
  assert.throws(() => readIntent({}), (error) => error.code === 'empty_utterance')
})

test('emotion in a request does not change what was asked', () => {
  // The interaction state may change how this is answered. It must not change which capability
  // is required, and it must not become a stored attribute.
  const neutral = readIntent({ utterance: 'count the lines under services/core' })
  const emotional = readIntent({ utterance: "I'm frustrated and tired -- count the lines under services/core, please" })
  assert.deepEqual(emotional.capabilities, neutral.capabilities)
  assert.equal(emotional.emotionalSignalsUsed, false, 'intent must not consume emotional signals')
})

test('a sensitive term is read, recorded as read, and used for nothing', () => {
  const withTerm = readIntent({ utterance: 'count the lines in the therapy notes directory' })
  const withoutTerm = readIntent({ utterance: 'count the lines in the notes directory' })
  assert.deepEqual(withTerm.sensitiveTermsObserved, ['therapy'])
  assert.deepEqual(withTerm.capabilities, withoutTerm.capabilities, 'the term may not steer capability selection')
  assert.ok(SENSITIVE_TERMS.includes('therapy'))
})

test('constraints are read when stated and absent when not', () => {
  const stated = readIntent({ utterance: 'count the lines under services/core within 250 ms' })
  assert.equal(stated.constraints.maxLatencyMs, 250)
  assert.match(stated.constraints.maxLatencyBecause, /within 250 ms/)
  const none = readIntent({ utterance: 'count the lines' })
  assert.equal(none.constraints.maxLatencyMs, undefined, 'no default latency is invented')
  assert.equal(none.constraints.within, undefined)
})

test('every rule cites a phrase from the request, and the table is data a reader can check', () => {
  assert.ok(INTENT_RULES.length >= 2)
  for (const rule of INTENT_RULES) {
    assert.ok(rule.capabilities.every((tag) => tag.includes('.')))
    const intent = readIntent({ utterance: `please ${rule.patterns[0].source.replace(/\\b|\[\^\.\]\*|\(\?:|\?|\|.*$/g, ' ')}` })
    assert.ok(intent.because.length > 0 || !intent.resolved)
  }
  assert.deepEqual(requiredCapabilities({ capabilities: ['tree.line-count'] }), ['tree.line-count'])
  assert.deepEqual(requiredCapabilities(null), [])
})

// --- registry -------------------------------------------------------------------

test('the registry indexes by capability, and re-registering the same implementation is idempotent', () => {
  const { materialise, stream } = executors()
  const registry = registryFrom([materialise, stream])
  assert.deepEqual(registry.ids.sort(), ['line-count-materialise', 'line-count-stream'])
  assert.deepEqual(registry.idsFor('tree.line-count').sort(), ['line-count-materialise', 'line-count-stream'])
  assert.equal(registry.has('tree.line-count'), true)
  assert.equal(registry.has('tree.semantic-diff'), false)
  assert.equal(registry.register(materialise), registry.get('line-count-materialise'), 'the same descriptor is not a duplicate')

  const described = registry.describe()
  assert.equal(described.implementations, 2)
  assert.deepEqual(described.kinds, { tool: 2, skill: 0, model: 0 })
  assert.deepEqual(described.byTag['tree.line-count'].sort(), ['line-count-materialise', 'line-count-stream'])
})

test('one id cannot mean two things', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const impostor = { ...materialise, provides: ['tree.semantic-diff'] }
  assert.throws(() => registry.register(impostor), (error) => {
    assert.equal(error.code, 'duplicate_id')
    assert.match(error.message, /a capability id must mean one thing/)
    return true
  })
})

test('unimplemented capabilities are listed by tag rather than summarised', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  assert.deepEqual(registry.unimplemented(['tree.line-count', 'image.generate', 'video.generate']), ['image.generate', 'video.generate'])
  assert.deepEqual(registry.candidatesFor(['tree.line-count']).map((d) => d.id), ['line-count-materialise'])
  assert.deepEqual(registry.candidatesFor(['tree.line-count', 'image.generate']), [], 'a task needing both has no candidate')
  assert.throws(() => new CapabilityRegistry().register({ id: 'X', kind: 'tool', provides: ['a.b'] }),
    (error) => error.code === 'invalid_id')
})

// --- planning -------------------------------------------------------------------

function planFor(utterance, registry, budget = {}, steps = null) {
  const intent = readIntent({ utterance })
  return planSteps({
    intent,
    registry,
    budget,
    steps: steps ?? [{ id: 'count', capability: 'tree.line-count', operation: 'count', expected: { preferredId: 'line-count-stream' } }],
  })
}

test('a plan is ordered by its dependencies and carries a digest of itself', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const intent = readIntent({ utterance: 'count the lines under services/core' })
  const plan = planSteps({
    intent,
    registry,
    steps: [
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'] },
      { id: 'first', capability: 'tree.line-count' },
    ],
  })
  assert.deepEqual(plan.order, ['first', 'second'], 'dependencies first, regardless of declaration order')
  assert.match(plan.digest, /^[0-9a-f]{64}$/)
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }), 'key order must not change the digest')
  assert.equal(canonical([1, { b: 2, a: 1 }]), '[1,{"a":1,"b":2}]')
  // The digest has to depend on the work, not just on the shape: a plan whose order changed is a
  // different plan and a checkpoint of one must not resume the other.
  const reordered = planSteps({
    intent,
    registry,
    steps: [
      { id: 'first', capability: 'tree.line-count' },
      { id: 'second', capability: 'tree.line-count', dependsOn: ['first'] },
    ],
  })
  assert.notEqual(reordered.digest, plan.digest, 'dependency order is part of the plan')
})

test('a plan needing something that is not installed names the capability and refuses', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const intent = readIntent({ utterance: 'generate a video of the dashboard' })
  // Force the capability through: the point is the plan check, not the intent table.
  const forced = { ...intent, resolved: true, capabilities: ['video.generate'], request: 'generate a video' }
  assert.throws(
    () => planSteps({ intent: forced, registry, steps: [{ id: 'render', capability: 'video.generate' }] }),
    (error) => {
      assert.equal(error.code, 'capability_unavailable')
      assert.match(error.message, /nothing installed implements video\.generate/)
      assert.match(error.message, /a missing capability, not a failed task/)
      return true
    },
  )
})

test('an optional step with no implementation stays in the plan, marked optional', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const intent = { resolved: true, request: 'count and diff', capabilities: ['tree.line-count'], confidence: CONFIDENCE.STATED }
  const plan = planSteps({
    intent,
    registry,
    steps: [
      { id: 'count', capability: 'tree.line-count' },
      { id: 'diff', capability: 'tree.semantic-diff', optional: true },
    ],
  })
  assert.deepEqual(plan.optionalUnavailable, ['tree.semantic-diff'])
  assert.equal(plan.steps.find((step) => step.id === 'diff').optional, true)
})

test('a plan too long for its budget is refused, not truncated', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const intent = { resolved: true, request: 'many steps', capabilities: ['tree.line-count'], confidence: CONFIDENCE.STATED }
  const steps = Array.from({ length: 4 }, (_, i) => ({ id: `step-${i}`, capability: 'tree.line-count' }))
  assert.throws(() => planSteps({ intent, registry, budget: { maxSteps: 3 }, steps }), (error) => {
    assert.equal(error.code, 'plan_too_long')
    assert.match(error.message, /refused rather than truncated/)
    return true
  })
  const allowed = planSteps({ intent, registry, budget: { maxSteps: 4 }, steps })
  assert.equal(allowed.bounded, true)
  assert.equal(allowed.steps.length, 4)
})

test('an unresolved intent cannot be planned, and a cycle cannot be ordered', () => {
  const { materialise } = executors()
  const registry = registryFrom([materialise])
  const unresolved = readIntent({ utterance: 'summarise this in Bengali' })
  assert.throws(
    () => planSteps({ intent: unresolved, registry, steps: [{ id: 'x', capability: 'tree.line-count' }] }),
    (error) => {
      assert.equal(error.code, 'intent_unresolved')
      assert.match(error.message, /encodes the guess as work/)
      return true
    },
  )
  const resolved = { resolved: true, request: 'cycle', capabilities: ['tree.line-count'], confidence: CONFIDENCE.STATED }
  assert.throws(
    () => planSteps({ intent: resolved, registry, steps: [
      { id: 'alpha', capability: 'tree.line-count', dependsOn: ['beta'] },
      { id: 'beta', capability: 'tree.line-count', dependsOn: ['alpha'] },
    ] }),
    (error) => { assert.equal(error.code, 'cyclic_plan'); return true },
  )
  assert.throws(
    () => planSteps({ intent: resolved, registry, steps: [{ id: 'alpha', capability: 'tree.line-count', dependsOn: ['ghost'] }] }),
    (error) => error.code === 'unknown_dependency',
  )
  assert.throws(() => planSteps({ intent: resolved, registry, steps: [] }), (error) => error.code === 'empty_plan')
  assert.throws(() => planSteps({ intent: resolved, registry }), (error) => error.code === 'empty_plan')
})

test('the single-step builder produces the same shape as a hand-written plan', () => {
  const { materialise, stream } = executors()
  const registry = registryFrom([materialise, stream])
  const intent = readIntent({ utterance: 'count the lines under services/core' })
  const plan = singleStepPlan({ intent, registry, expected: { preferredId: 'line-count-stream' } })
  assert.equal(plan.steps.length, 1)
  assert.deepEqual(plan.order, ['run'])
  assert.equal(plan.steps[0].capability, 'tree.line-count')
  assert.equal(plan.steps[0].expected.preferredId, 'line-count-stream')
  const again = singleStepPlan({ intent, registry, expected: { preferredId: 'line-count-stream' } })
  assert.equal(again.digest, plan.digest, 'the same plan digests the same way')
  const different = singleStepPlan({ intent, registry, expected: { preferredId: 'line-count-materialise' } })
  assert.notEqual(different.digest, plan.digest, 'a different preferred implementation is a different plan')
})

test('the intent reader and the registry are read-only from the planner', () => {
  const { materialise, stream } = executors()
  const registry = registryFrom([materialise, stream])
  const intent = readIntent({ utterance: 'count the lines under services/core' })
  const before = registry.describe()
  planFor(intent.request, registry, {}, [{ id: 'count', capability: 'tree.line-count' }])
  assert.deepEqual(registry.describe(), before, 'planning must not mutate the registry it reads')
  assert.deepEqual(registry.ids, ['line-count-materialise', 'line-count-stream'], 'and must not register anything')
})

test('a registry declares its own kinds, so a skill-only capability is visible as such', () => {
  const { materialise } = executors()
  const asSkill = { ...materialise, id: 'line-count-skill', kind: 'skill', provides: ['tree.line-count'], limitations: ['Counts newline bytes.'] }
  const registry = registryFrom([asSkill])
  assert.deepEqual(registry.describe().kinds, { tool: 0, skill: 1, model: 0 })
  assert.deepEqual(registry.descriptorsFor('tree.line-count').map((d) => d.limitations), [['Counts newline bytes.']])
  // And the limitation travels with the descriptor, so a caller that reads it can act on it.
  assert.deepEqual(registry.describe().byTag['tree.line-count'], ['line-count-skill'])
})
