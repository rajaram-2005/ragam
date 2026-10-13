import test from 'node:test'
import assert from 'node:assert/strict'
import { GodCore, LIFECYCLE, TASK_STATES, STEP_EVIDENCE, DEFAULT_BUDGET } from '../src/godcore/lifecycle.mjs'
import { ModelRegistry, ModelRouter, MODEL_KINDS, MODALITIES, AVAILABILITY } from '../src/router/registry.mjs'
import { KnowledgePipeline } from '../src/knowledge/pipeline.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

function makeCore({ knowledge = null, budget = {}, policy = 'strict_offline', allowExternal = false } = {}) {
  const registry = new ModelRegistry()
  registry.register({
    id: 'local:tiny',
    kind: MODEL_KINDS.LOCAL_LLM,
    displayName: 'Tiny local model',
    capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
    location: 'local',
    streaming: true,
    contextWindow: 8192,
  })
  registry.observe('local:tiny', { availability: AVAILABILITY.READY, medianLatencyMs: 40 })
  const router = new ModelRouter({ registry, hardware: { ramGb: 8, vramGb: 0 } })
  const ledger = new AuditLedger(':memory:')
  const events = []
  const core = new GodCore({
    router,
    knowledge,
    ledger,
    policy: { mode: policy, allowExternalFor: () => allowExternal },
    onEvent: (event) => events.push(event),
    budget,
  })
  return { core, registry, router, ledger, events }
}

const POLICY_DOC = `Thermal runaway threshold.
The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius.
Isolation resistance must remain above 500 ohms per volt at all times.`

test('the lifecycle exposes exactly the eight mandated phases, in order', () => {
  assert.deepEqual(LIFECYCLE, ['understand', 'plan', 'retrieve', 'route', 'execute', 'observe', 'verify', 'synthesize'])
})

test('a full run visits every phase in order and records a checkpoint per phase', async () => {
  const { core, events } = makeCore()
  const task = core.submit({ prompt: 'Summarise the contactor requirement.' })
  const finished = await core.run(task.id)

  const visited = events.filter((event) => event.type === 'phase_started').map((event) => event.phase)
  assert.deepEqual(visited, LIFECYCLE)
  assert.equal(finished.steps.length, LIFECYCLE.length)
  assert.deepEqual(finished.steps.map((step) => step.phase), LIFECYCLE)
  assert.ok(finished.checkpoint.label.startsWith('before:'))
  assert.ok(events.some((event) => event.type === 'checkpoint'))
})

test('THE HONESTY RULE: a plan with no executor is PARTIAL, never SUCCEEDED', async () => {
  const { core } = makeCore()
  const task = core.submit({ prompt: 'Refactor the ingest module and run the tests.' })
  const finished = await core.run(task.id)

  assert.equal(finished.state, TASK_STATES.PARTIAL, 'a plan-only run must not report success')
  assert.equal(finished.result.answered, false)
  assert.equal(finished.result.output, null)
  assert.ok(finished.limitations.some((note) => /no executor was supplied/.test(note)))
  assert.ok(finished.limitations.some((note) => /not verified/.test(note)))

  const executeStep = finished.steps.find((step) => step.phase === 'execute')
  assert.equal(executeStep.evidence, STEP_EVIDENCE.PLANNED_ONLY)
  const synthesizeStep = finished.steps.find((step) => step.phase === 'synthesize')
  assert.equal(synthesizeStep.evidence, STEP_EVIDENCE.PLANNED_ONLY)
})

test('a run with a real executor and passing verification SUCCEEDS', async () => {
  const { core } = makeCore()
  const task = core.submit({
    prompt: 'Compute the checksum of the file.',
    context: {
      executeHandler: async () => ({ executor: 'checksum-tool', output: { sha256: 'a'.repeat(64) }, evidence: STEP_EVIDENCE.OBSERVED }),
      verifier: (_task, observation) => ({ passed: typeof observation.outputPreview?.sha256 === 'string', detail: 'sha256 present' }),
    },
  })
  const finished = await core.run(task.id)
  assert.equal(finished.state, TASK_STATES.SUCCEEDED, JSON.stringify(finished.limitations))
  assert.equal(finished.result.answered, true)
  assert.deepEqual(finished.result.output, { sha256: 'a'.repeat(64) })
  assert.equal(finished.verification.passed, true)
  assert.ok(finished.verification.checks.some((check) => check.name === 'custom'))
  assert.equal(finished.steps.find((step) => step.phase === 'verify').evidence, STEP_EVIDENCE.VERIFIED)
})

test('failing verification prevents a success claim', async () => {
  const { core } = makeCore()
  const task = core.submit({
    prompt: 'Do the thing.',
    context: {
      executeHandler: async () => ({ executor: 'broken', output: 'result', evidence: STEP_EVIDENCE.OBSERVED }),
      verifier: () => ({ passed: false, detail: 'unit tests still failing' }),
    },
  })
  const finished = await core.run(task.id)
  assert.notEqual(finished.state, TASK_STATES.SUCCEEDED)
  assert.equal(finished.verification.passed, false)
  assert.equal(finished.result.answered, false)
  assert.ok(finished.limitations.some((note) => /verification failed: custom/.test(note)))
})

test('an executor that produces no output cannot be reported as complete', async () => {
  const { core } = makeCore()
  const task = core.submit({ prompt: 'x', context: { executeHandler: async () => ({ executor: 'silent' }) } })
  const finished = await core.run(task.id)
  assert.notEqual(finished.state, TASK_STATES.SUCCEEDED)
  assert.equal(finished.observation.outputPresent, false)
  assert.ok(finished.limitations.some((note) => /cannot be claimed as complete/.test(note)))
})

test('an executor returning a non-object is treated as a failure', async () => {
  const { core } = makeCore()
  const task = core.submit({ prompt: 'x', context: { executeHandler: async () => 'just a string' } })
  const finished = await core.run(task.id)
  assert.equal(finished.state, TASK_STATES.FAILED)
  assert.match(finished.error, /no observable result/)
})

test('intent triage drives the plan, and its heuristic nature is disclosed', async () => {
  const { core } = makeCore()
  const coding = await core.run(core.submit({ prompt: 'Implement and test a repository change' }).id)
  assert.ok(coding.plan.steps.some((step) => step.id === 'coding-task'))
  assert.ok(coding.plan.rationale.includes('coding'))
  assert.ok(coding.limitations.some((note) => /intent detection is heuristic/.test(note)), 'the limitation must be disclosed')

  const media = await core.run(core.submit({ prompt: 'Create an image of the factory' }).id)
  assert.ok(media.plan.steps.some((step) => step.id === 'generate-image'))

  const general = await core.run(core.submit({ prompt: 'Hello there' }).id)
  assert.ok(general.plan.rationale.includes('general'))
})

test('planning is bounded by the step budget', async () => {
  const { core } = makeCore({ budget: { maxSteps: 1 } })
  const task = core.submit({ prompt: 'Generate an image and a video and write code' })
  const finished = await core.run(task.id)
  assert.ok(finished.plan.steps.length <= 1)
  assert.ok(finished.limitations.some((note) => /plan truncated/.test(note)))
})

test('retrieval is skipped without a knowledge intent and reported unavailable without a pipeline', async () => {
  const { core } = makeCore()
  const task = core.submit({ prompt: 'What is our company policy on cell thermal limits?' })
  const finished = await core.run(task.id)
  const retrieveStep = finished.steps.find((step) => step.phase === 'retrieve')
  assert.equal(retrieveStep.evidence, STEP_EVIDENCE.UNAVAILABLE)
  assert.ok(finished.limitations.some((note) => /no knowledge pipeline is configured/.test(note)))

  const plain = await core.run(core.submit({ prompt: 'Say hello' }).id)
  assert.equal(plain.steps.find((step) => step.phase === 'retrieve').evidence, STEP_EVIDENCE.SKIPPED)
})

test('a company-knowledge task retrieves real cited evidence', async () => {
  const knowledge = new KnowledgePipeline({ dbFile: ':memory:' })
  await knowledge.ingestText({ title: 'BMS Policy', text: POLICY_DOC })
  const { core } = makeCore({ knowledge })

  const task = core.submit({
    prompt: 'What is our company policy on the contactor opening threshold?',
    context: {
      // Grounding can only be verified against a produced answer, so this task runs
      // through the real executor seam rather than stopping at a plan.
      executeHandler: async (t) => ({
        executor: 'policy-answer',
        output: 'The pack contactor must open within 250 ms above 68 degrees Celsius.',
        citations: t.retrieval?.citations ?? [],
      }),
    },
  })
  const finished = await core.run(task.id)

  assert.equal(finished.retrieval.hasEvidence, true)
  assert.ok(finished.retrieval.citations.length > 0)
  assert.equal(finished.retrieval.citations[0].title, 'BMS Policy')
  assert.ok(finished.retrieval.method)
  assert.ok(finished.usage.retrievedChunks > 0)
  assert.equal(finished.steps.find((step) => step.phase === 'retrieve').evidence, STEP_EVIDENCE.OBSERVED)

  // Grounding is verified: with evidence present, a grounding check must run.
  assert.ok(finished.verification.checks.some((check) => check.name === 'grounding'))
  assert.equal(finished.result.grounded, true)
  assert.equal(finished.state, TASK_STATES.SUCCEEDED)
  knowledge.close()
})

test('a knowledge query with no matching evidence says so instead of inventing procedure', async () => {
  const knowledge = new KnowledgePipeline({ dbFile: ':memory:' })
  await knowledge.ingestText({ title: 'BMS Policy', text: POLICY_DOC })
  const { core } = makeCore({ knowledge })
  const finished = await core.run(core.submit({ prompt: 'What is our company policy on xylophone maintenance schedules?' }).id)
  assert.equal(finished.retrieval.hasEvidence, false)
  assert.equal(finished.steps.find((step) => step.phase === 'retrieve').evidence, STEP_EVIDENCE.UNAVAILABLE)
  assert.ok(finished.limitations.some((note) => /rather than invent procedure/.test(note)))
  knowledge.close()
})

test('routing failure surfaces the real explanation, not a fabricated answer', async () => {
  const registry = new ModelRegistry()
  registry.register({ id: 'online:only', kind: MODEL_KINDS.ONLINE_LLM, displayName: 'O', capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT], location: 'online', provider: 'freellmapi' })
  registry.observe('online:only', { availability: AVAILABILITY.READY })
  const router = new ModelRouter({ registry })
  const core = new GodCore({ router, policy: { mode: 'strict_offline', allowExternalFor: () => false } })

  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  assert.equal(finished.state, TASK_STATES.FAILED)
  assert.match(finished.error, /no model available/)
  assert.match(finished.error, /blocked by strict_offline policy/)
})

test('pause stops at a checkpoint and resume continues from it', async () => {
  const { core, events } = makeCore()
  const task = core.submit({ prompt: 'A long task' })

  // Pause when the 'plan' phase starts.
  const handlers = {
    plan: async (t, ctx) => {
      core.pause(t.id, 'operator intervened')
      return { evidence: STEP_EVIDENCE.PLANNED_ONLY, detail: {} }
    },
  }
  const paused = await core.run(task.id, handlers)
  assert.equal(paused.state, TASK_STATES.PAUSED)
  assert.ok(paused.checkpoint)
  assert.ok(events.some((event) => event.type === 'task_paused'))

  const resumed = await core.resume(task.id)
  assert.ok([TASK_STATES.PARTIAL, TASK_STATES.SUCCEEDED, TASK_STATES.FAILED].includes(resumed.state))
  assert.ok(resumed.steps.length > paused.steps.length, 'resume must make further progress')
  assert.ok(events.some((event) => event.type === 'task_resumed'))
})

test('a task snapshot is immutable: later progress cannot rewrite it', async () => {
  const { core } = makeCore()
  const task = core.submit({ prompt: 'snapshot stability' })

  // Capture a view part-way through, then let the task run to completion.
  let early = null
  const finished = await core.run(task.id, {
    retrieve: async (t) => {
      early = core.get(t.id)
      return { evidence: STEP_EVIDENCE.SKIPPED, detail: {} }
    },
  })

  assert.ok(early, 'the mid-run snapshot must have been taken')
  assert.ok(early.steps.length < finished.steps.length, 'the run must have progressed past the snapshot')
  // The bug this locks down: steps used to be handed out by reference, so the
  // early snapshot silently grew to match the finished task and every checkpoint
  // comparison became meaningless.
  assert.equal(early.state, TASK_STATES.RUNNING)
  assert.notEqual(early.steps.length, finished.steps.length)
  assert.ok(early.steps.every((step) => step.phase !== 'synthesize'))

  // Mutating a snapshot must not reach back into core state.
  early.steps.push({ phase: 'forged', status: 'complete' })
  early.usage.toolCalls = 9999
  early.limitations.push('forged limitation')
  const after = core.get(task.id)
  assert.equal(after.steps.some((step) => step.phase === 'forged'), false)
  assert.equal(after.usage.toolCalls, finished.usage.toolCalls)
  assert.equal(after.limitations.includes('forged limitation'), false)

  // The AbortController is never exposed, so a caller cannot bypass cancel().
  assert.equal('controller' in finished, false)
  assert.equal(JSON.stringify(finished).includes('AbortController'), false)
})

test('a terminal task cannot be paused or resumed', async () => {
  const { core } = makeCore()
  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  assert.equal(finished.terminal, true)
  assert.throws(() => core.pause(finished.id), /cannot be paused/)
  await assert.rejects(() => core.resume(finished.id), /cannot be resumed/)
})

test('cancel aborts in-flight work and the executor observes the signal', async () => {
  const { core, events } = makeCore()
  const task = core.submit({ prompt: 'A slow task' })
  let aborted = false
  const handlers = {
    execute: async (t, { signal }) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5000)
        signal.addEventListener('abort', () => {
          aborted = true
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
      return { output: 'never' }
    },
  }
  const pending = core.run(task.id, handlers)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const result = core.cancel(task.id, 'user cancelled')
  assert.equal(result.cancelled, true)
  const finished = await pending
  assert.equal(finished.state, TASK_STATES.CANCELLED)
  assert.equal(aborted, true, 'the AbortSignal must reach the executor')
  assert.ok(events.some((event) => event.type === 'task_finished' && event.state === TASK_STATES.CANCELLED))
})

test('cancelling a terminal task is a no-op', async () => {
  const { core } = makeCore()
  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  const result = core.cancel(finished.id)
  assert.equal(result.cancelled, false)
  assert.match(result.reason, /already terminal/)
})

test('the duration budget produces TIMED_OUT, not a silent hang', async () => {
  const { core } = makeCore({ budget: { maxDurationMs: 120 } })
  const task = core.submit({ prompt: 'A very slow task' })
  const finished = await core.run(task.id, {
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return { output: 'too late' }
    },
  })
  assert.equal(finished.state, TASK_STATES.TIMED_OUT)
  assert.match(finished.error, /exceeded 120ms budget/)
})

test('the tool-call budget is enforced and reported as PARTIAL with the reason', async () => {
  const { core } = makeCore({ budget: { maxToolCalls: 0 } })
  let executed = false
  const finished = await core.run(
    core.submit({
      prompt: 'x',
      context: {
        executeHandler: async () => {
          executed = true
          return { executor: 'never', output: 'nope' }
        },
      },
    }).id,
  )
  assert.equal(executed, false, 'the budget must be checked before the executor runs')
  assert.equal(finished.state, TASK_STATES.PARTIAL)
  assert.ok(finished.limitations.some((note) => /budget exceeded/.test(note)))
  assert.ok(finished.steps.some((step) => step.status === 'budget_exceeded'))
})

test('the tool-call budget allows exactly the configured number of executions', async () => {
  const { core } = makeCore({ budget: { maxToolCalls: 1 } })
  const finished = await core.run(
    core.submit({
      prompt: 'x',
      context: { executeHandler: async () => ({ executor: 'noop', output: 'ok' }) },
    }).id,
  )
  assert.equal(finished.usage.toolCalls, 1)
  assert.equal(finished.state, TASK_STATES.SUCCEEDED)
})

test('a failing phase is retried within the retry budget, then fails honestly', async () => {
  const { core, events } = makeCore({ budget: { maxRetries: 2 } })
  let attempts = 0
  const finished = await core.run(
    core.submit({
      prompt: 'x',
      context: {
        executeHandler: async () => {
          attempts += 1
          throw new Error('transient upstream failure')
        },
      },
    }).id,
  )
  assert.equal(attempts, 3, 'one initial attempt plus two bounded retries')
  assert.equal(finished.usage.retries, 2)
  assert.equal(finished.state, TASK_STATES.FAILED)
  assert.match(finished.error, /transient upstream failure/)
  assert.equal(events.filter((event) => event.type === 'phase_retry').length, 2)
  // The retry attempts are visible in the step history.
  assert.ok(finished.steps.filter((step) => step.status === 'retrying').length === 2)
})

test('a phase that recovers on retry succeeds', async () => {
  const { core } = makeCore()
  let attempts = 0
  const finished = await core.run(
    core.submit({
      prompt: 'x',
      context: {
        executeHandler: async () => {
          attempts += 1
          if (attempts < 2) throw new Error('flaky')
          return { executor: 'flaky', output: 'recovered' }
        },
      },
    }).id,
  )
  assert.equal(attempts, 2)
  assert.equal(finished.usage.retries, 1)
  assert.equal(finished.result.answered, true)
  assert.equal(finished.state, TASK_STATES.SUCCEEDED)
})

test('godMode is recorded and bounded, not a licence to exceed policy', async () => {
  const { core } = makeCore({ budget: { maxSteps: 3 } })
  const task = core.submit({ prompt: 'Autonomously fix the repository', godMode: true })
  assert.equal(task.godMode, true)
  const finished = await core.run(task.id)
  assert.equal(finished.godMode, true)
  assert.equal(finished.budget.maxSteps, 3, 'godMode still runs inside the configured budget')
  assert.ok(finished.plan.bounded)
})

test('an approval gate pauses the task until it is granted', async () => {
  const { core, events } = makeCore()
  const task = core.submit({ prompt: 'Delete the stale artifacts' })
  const paused = await core.run(task.id, {
    execute: async () => ({ requiresApproval: { reason: 'destructive filesystem operation', scopes: ['fs.write'] } }),
  })
  assert.equal(paused.state, TASK_STATES.AWAITING_APPROVAL)
  assert.equal(paused.approval.reason, 'destructive filesystem operation')
  assert.ok(events.some((event) => event.type === 'approval_required'))

  const resumed = await core.approve(task.id, { approvals: ['fs.write'], handlers: { execute: async () => ({ output: 'deleted', evidence: STEP_EVIDENCE.OBSERVED }) } })
  assert.ok([TASK_STATES.SUCCEEDED, TASK_STATES.PARTIAL].includes(resumed.state))
  assert.ok(events.some((event) => event.type === 'task_approved'))
})

test('approving a task that is not awaiting approval is refused', async () => {
  const { core } = makeCore()
  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  await assert.rejects(() => core.approve(finished.id, {}), /not awaiting approval/)
})

test('task views expose the lifecycle without leaking controllers', async () => {
  const { core } = makeCore()
  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  const serialized = JSON.stringify(finished)
  assert.equal(serialized.includes('AbortController'), false)
  assert.equal(serialized.includes('"controller"'), false)
  assert.deepEqual(finished.lifecycle, LIFECYCLE)
  assert.ok(Array.isArray(finished.events))
  assert.equal(typeof finished.durationMs, 'number')
})

test('submit validates its input and unknown tasks are rejected', async () => {
  const { core } = makeCore()
  assert.throws(() => core.submit({ prompt: '' }), TypeError)
  assert.throws(() => core.submit({}), TypeError)
  assert.throws(() => core.get('nope'), /unknown task/)
  assert.throws(() => core.pause('nope'), /unknown task/)
  assert.throws(() => new GodCore({}), TypeError)
})

test('running an already-terminal task is refused', async () => {
  const { core } = makeCore()
  const finished = await core.run(core.submit({ prompt: 'hello' }).id)
  await assert.rejects(() => core.run(finished.id), /cannot be run/)
})

test('the audit ledger records submission and terminal outcome', async () => {
  const { core, ledger } = makeCore()
  const task = core.submit({ prompt: 'hello' })
  await core.run(task.id)
  const events = ledger.query({ category: 'task', limit: 50 })
  assert.ok(events.some((event) => event.action === 'submit'))
  assert.ok(events.some((event) => event.action.startsWith('finish:')))
})

test('default budgets are bounded and sane', () => {
  assert.ok(DEFAULT_BUDGET.maxSteps > 0 && DEFAULT_BUDGET.maxSteps <= 64)
  assert.ok(DEFAULT_BUDGET.maxDurationMs >= 1000)
  assert.ok(DEFAULT_BUDGET.maxRetries >= 0 && DEFAULT_BUDGET.maxRetries <= 10)
  assert.ok(DEFAULT_BUDGET.maxModelCalls >= 1)
})

test('task listing filters by state', async () => {
  const { core } = makeCore()
  await core.run(core.submit({ prompt: 'one' }).id)
  core.submit({ prompt: 'two' })
  assert.equal(core.list({}).length, 2)
  assert.equal(core.list({ state: TASK_STATES.PENDING }).length, 1)
  assert.ok(core.list({ state: TASK_STATES.PARTIAL }).length >= 1)
})
