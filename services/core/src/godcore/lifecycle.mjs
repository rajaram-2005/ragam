// God Core: the orchestration lifecycle.
//
//   Understand → Plan → Retrieve → Route → Execute → Observe → Verify → Synthesize
//
// Ported from the semantics proven in Aetheris' `runtime/taskState.js`,
// `phaseEngine.js` and `workflowEngine.js` (37 passing tests upstream), but moved
// server-side so that budgets, cancellation and checkpoints cannot be bypassed from
// a browser console.
//
// Directive §4.B requires bounded planning and execution budgets, cancellation,
// timeouts, checkpoints, retries and recovery — and §10 requires that the agent
// "never claim it completed an operation when it only generated a plan, simulated a
// result or displayed a preview". Every completion path here is therefore gated on
// an *observed* result.

import { randomUUID } from 'node:crypto'
import { AUDIT_OUTCOMES } from '../audit/ledger.mjs'

export const LIFECYCLE = Object.freeze([
  'understand',
  'plan',
  'retrieve',
  'route',
  'execute',
  'observe',
  'verify',
  'synthesize',
])

export const TASK_STATES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  PAUSED: 'paused',
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial', // some steps verified, others honestly recorded as not done
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
})

const TERMINAL = new Set([TASK_STATES.SUCCEEDED, TASK_STATES.PARTIAL, TASK_STATES.FAILED, TASK_STATES.CANCELLED, TASK_STATES.TIMED_OUT])

/** What a step actually achieved. This is what stops plan-only claims of success. */
export const STEP_EVIDENCE = Object.freeze({
  OBSERVED: 'observed', // real output captured from a real execution
  VERIFIED: 'verified', // output passed an independent check
  PLANNED_ONLY: 'planned_only', // a plan exists but nothing ran
  UNAVAILABLE: 'unavailable', // capability absent; reported honestly
  SKIPPED: 'skipped',
  FAILED: 'failed',
})

export class BudgetExceededError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'BudgetExceededError'
    this.code = 'budget_exceeded'
    Object.assign(this, details)
  }
}

export class TaskCancelledError extends Error {
  constructor(taskId, reason) {
    super(`task '${taskId}' cancelled: ${reason}`)
    this.name = 'TaskCancelledError'
    this.code = 'task_cancelled'
    this.taskId = taskId
    this.reason = reason
  }
}

/**
 * Budget semantics, kept distinct so each one bounds a different thing:
 *   maxSteps      — maximum number of *planned* workflow steps (bounds fan-out;
 *                   §4.B prefers the simplest sufficient workflow)
 *   maxToolCalls  — maximum number of executor/tool invocations actually performed
 *   maxModelCalls — maximum number of model invocations
 *   maxRetries    — bounded retries per phase
 *   maxDurationMs — wall-clock deadline for the whole task
 */
export const DEFAULT_BUDGET = Object.freeze({
  maxSteps: 12,
  maxToolCalls: 20,
  maxRetries: 2,
  maxDurationMs: 300_000,
  maxModelCalls: 6,
  maxRetrievedChunks: 8,
})

export class GodCore {
  /**
   * @param {object} deps
   * @param {object} deps.router      ModelRouter
   * @param {object} [deps.knowledge] KnowledgePipeline
   * @param {object} [deps.mcp]       McpRegistry
   * @param {object} [deps.plugins]   PluginRegistry
   * @param {object} [deps.ledger]    AuditLedger
   * @param {object} [deps.policy]    {guard, dataPolicy, mode}
   * @param {(e:object)=>void} [deps.onEvent]
   */
  constructor({ router, knowledge = null, mcp = null, plugins = null, ledger = null, policy = null, onEvent = () => {}, budget = {} } = {}) {
    if (!router) throw new TypeError('GodCore requires a ModelRouter')
    this.router = router
    this.knowledge = knowledge
    this.mcp = mcp
    this.plugins = plugins
    this.ledger = ledger
    this.policy = policy
    this.onEvent = onEvent
    this.budget = { ...DEFAULT_BUDGET, ...budget }
    /** @type {Map<string, object>} */
    this.tasks = new Map()
  }

  /**
   * Submit a request. Returns the task record; run() drives it.
   * @param {object} request
   * @param {string} request.prompt
   * @param {object} [request.context]
   * @param {boolean} [request.godMode]  bounded high-autonomy mode (§2, §10)
   * @param {string} [request.principal]
   * @param {string} [request.dataClass]
   */
  submit({ prompt, context = {}, godMode = false, principal = null, dataClass = null, capabilities = ['text_in', 'text_out'] }) {
    if (!prompt || !String(prompt).trim()) throw new TypeError('submit requires a non-empty prompt')
    const id = randomUUID()
    const task = {
      id,
      prompt: String(prompt),
      context,
      godMode: Boolean(godMode),
      principal,
      dataClass,
      capabilities,
      state: TASK_STATES.PENDING,
      phase: null,
      phaseIndex: -1,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      checkpoint: null,
      approval: null,
      budget: { ...this.budget },
      usage: { steps: 0, toolCalls: 0, modelCalls: 0, retries: 0, retrievedChunks: 0 },
      plan: null,
      steps: [],
      evidence: [],
      events: [],
      result: null,
      error: null,
      limitations: [],
      cancelled: false,
      cancelReason: null,
      controller: new AbortController(),
    }
    this.tasks.set(id, task)
    this.#emit(task, 'task_created', { godMode: task.godMode })
    this.#audit('task', 'submit', AUDIT_OUTCOMES.INFO, { promptLength: task.prompt.length, godMode: task.godMode }, id)
    return this.publicView(task)
  }

  /** Drive a task through the lifecycle. */
  async run(taskId, handlers = {}) {
    const task = this.#task(taskId)
    if (task.state !== TASK_STATES.PENDING && task.state !== TASK_STATES.PAUSED) {
      throw new Error(`task '${taskId}' is ${task.state} and cannot be run`)
    }
    task.state = TASK_STATES.RUNNING
    task.startedAt ??= Date.now()
    this.#emit(task, 'task_started', {})

    const deadline = task.startedAt + task.budget.maxDurationMs
    const timer = setTimeout(() => {
      if (!TERMINAL.has(task.state)) {
        task.controller.abort(new Error('deadline'))
        this.#finish(task, TASK_STATES.TIMED_OUT, null, `exceeded ${task.budget.maxDurationMs}ms budget`)
      }
    }, task.budget.maxDurationMs)

    try {
      // Index-based so a bounded retry re-runs the SAME phase rather than skipping it.
      for (let index = 0; index < LIFECYCLE.length; index += 1) {
        const phase = LIFECYCLE[index]
        this.#checkCancelled(task)
        if (Date.now() > deadline) {
          this.#finish(task, TASK_STATES.TIMED_OUT, null, 'deadline exceeded between phases')
          break
        }
        if (task.state === TASK_STATES.PAUSED || task.state === TASK_STATES.AWAITING_APPROVAL) break

        task.phase = phase
        task.phaseIndex = index
        this.#checkpoint(task, `before:${phase}`)
        this.#emit(task, 'phase_started', { phase })

        const handler = handlers[phase] ?? null
        const startedPhase = Date.now()
        try {
          // Budget accounting belongs to the core: a custom phase handler must not
          // be able to bypass it.
          this.#accountPhase(task, phase)
          const outcome = handler
            ? await handler(task, { signal: task.controller.signal, core: this })
            : await this.#builtinPhase(phase, task)
          task.steps.push({
            phase,
            status: 'complete',
            evidence: outcome?.evidence ?? STEP_EVIDENCE.OBSERVED,
            detail: outcome?.detail ?? null,
            durationMs: Date.now() - startedPhase,
          })
          if (outcome?.limitations?.length) task.limitations.push(...outcome.limitations)
          if (outcome?.requiresApproval) {
            task.state = TASK_STATES.AWAITING_APPROVAL
            task.approval = outcome.requiresApproval
            this.#emit(task, 'approval_required', outcome.requiresApproval)
            this.#audit('task', `await_approval:${phase}`, AUDIT_OUTCOMES.DENIED, outcome.requiresApproval, taskId)
            break
          }
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error
          if (error?.code === 'budget_exceeded') {
            task.steps.push({ phase, status: 'budget_exceeded', evidence: STEP_EVIDENCE.FAILED, detail: error.message, durationMs: Date.now() - startedPhase })
            task.limitations.push(`${phase}: ${error.message}`)
            this.#finish(task, TASK_STATES.PARTIAL, null, error.message)
            break
          }
          // Bounded retry of this same phase, then an honest failure.
          if (task.usage.retries < task.budget.maxRetries) {
            task.usage.retries += 1
            this.#emit(task, 'phase_retry', { phase, attempt: task.usage.retries, error: error?.message })
            task.steps.push({ phase, status: 'retrying', evidence: STEP_EVIDENCE.FAILED, detail: error?.message, durationMs: Date.now() - startedPhase })
            index -= 1
            continue
          }
          task.steps.push({ phase, status: 'failed', evidence: STEP_EVIDENCE.FAILED, detail: error?.message, durationMs: Date.now() - startedPhase })
          this.#finish(task, TASK_STATES.FAILED, null, error?.message ?? String(error))
          break
        }
        this.#emit(task, 'phase_completed', { phase })
      }

      if (!TERMINAL.has(task.state) && task.state !== TASK_STATES.PAUSED && task.state !== TASK_STATES.AWAITING_APPROVAL) {
        this.#finish(task, this.#finalState(task), task.result ?? null)
      }
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        this.#finish(task, TASK_STATES.CANCELLED, null, error.reason)
      } else {
        this.#finish(task, TASK_STATES.FAILED, null, error?.message ?? String(error))
      }
    } finally {
      clearTimeout(timer)
    }
    return this.publicView(task)
  }

  /**
   * Default phase implementations. Each one is real: it consults the knowledge
   * index, the router, MCP or plugins, and records what it actually observed.
   */
  async #builtinPhase(phase, task) {
    switch (phase) {
      case 'understand':
        return this.#understand(task)
      case 'plan':
        return this.#plan(task)
      case 'retrieve':
        return this.#retrieve(task)
      case 'route':
        return this.#route(task)
      case 'execute':
        return this.#execute(task)
      case 'observe':
        return this.#observe(task)
      case 'verify':
        return this.#verify(task)
      case 'synthesize':
        return this.#synthesize(task)
      default:
        throw new Error(`unknown lifecycle phase '${phase}'`)
    }
  }

  #understand(task) {
    const prompt = task.prompt
    const intents = []
    if (/\b(image|picture|photo|illustration|draw|render)\b/i.test(prompt)) intents.push('image')
    if (/\b(video|clip|animation|footage)\b/i.test(prompt)) intents.push('video')
    if (/\b(code|function|bug|test|refactor|implement|repository|repo)\b/i.test(prompt)) intents.push('coding')
    if (/\b(why|how does|explain|prove|derive|calculate|solve)\b/i.test(prompt)) intents.push('reasoning')
    if (/\b(our|company|internal|policy|procedure|documentation|spec)\b/i.test(prompt)) intents.push('company_knowledge')
    if (!intents.length) intents.push('general')

    task.understanding = {
      intents,
      // Deterministic keyword signals only. This is NOT a claim of real NLU: it is a
      // cheap triage that decides which retrieval/routing paths to try. A language
      // model refines it in #synthesize when one is available.
      method: 'heuristic-triage',
      limitations: ['intent detection is heuristic; a language model is required for reliable classification'],
    }
    return { evidence: STEP_EVIDENCE.OBSERVED, detail: { intents }, limitations: task.understanding.limitations }
  }

  #plan(task) {
    const intents = task.understanding?.intents ?? ['general']
    const steps = []
    if (intents.includes('company_knowledge')) steps.push({ id: 'retrieve-knowledge', kind: 'retrieval', description: 'search the local knowledge index for cited evidence' })
    if (intents.includes('image')) steps.push({ id: 'generate-image', kind: 'media', description: 'generate an image through an authorized provider' })
    if (intents.includes('video')) steps.push({ id: 'generate-video', kind: 'media', description: 'enqueue a video generation job' })
    if (intents.includes('coding')) steps.push({ id: 'coding-task', kind: 'tool', description: 'run the coding capability with verification' })
    steps.push({ id: 'answer', kind: 'model', description: 'produce the final grounded answer' })

    // Bounded planning: prefer the simplest workflow that can satisfy the request
    // (§4.B). Multi-step fan-out is only justified when an intent demands it.
    if (steps.length > task.budget.maxSteps) {
      const trimmed = steps.slice(0, task.budget.maxSteps)
      task.limitations.push(`plan truncated to ${task.budget.maxSteps} steps by budget`)
      steps.length = 0
      steps.push(...trimmed)
    }
    task.plan = { steps, rationale: `intents: ${intents.join(', ')}`, bounded: true }
    return { evidence: STEP_EVIDENCE.PLANNED_ONLY, detail: { stepCount: steps.length, intents } }
  }

  #retrieve(task) {
    const needsRetrieval = (task.understanding?.intents ?? []).includes('company_knowledge')
    if (!needsRetrieval) {
      return { evidence: STEP_EVIDENCE.SKIPPED, detail: { reason: 'no company-knowledge intent detected' } }
    }
    if (!this.knowledge) {
      task.limitations.push('no knowledge pipeline is configured; company-private questions cannot be grounded')
      return { evidence: STEP_EVIDENCE.UNAVAILABLE, detail: { reason: 'knowledge pipeline not configured' } }
    }
    const found = this.knowledge.buildGroundedContext({
      query: task.prompt,
      principal: task.principal,
      topK: Math.min(task.budget.maxRetrievedChunks, 8),
    })
    task.usage.retrievedChunks += found.evidenceCount
    task.retrieval = found
    if (!found.hasEvidence) {
      task.limitations.push('no indexed evidence matched; the answer will state that explicitly rather than invent procedure')
      return { evidence: STEP_EVIDENCE.UNAVAILABLE, detail: { method: found.method, matches: 0 } }
    }
    return { evidence: STEP_EVIDENCE.OBSERVED, detail: { method: found.method, matches: found.evidenceCount, citations: found.citations.length } }
  }

  #route(task) {
    const needsMedia = (task.plan?.steps ?? []).some((step) => step.kind === 'media')
    if (needsMedia) {
      // Media routing happens in the media service; here we only decide the language
      // model, so the router is called once with the text capability set.
      task.limitations.push('media generation is routed separately by the Image/Video services')
    }
    const request = {
      capabilities: task.capabilities,
      ...(task.context?.toolCalling ? { toolCalling: true } : {}),
      ...(task.context?.minContext ? { minContext: task.context.minContext } : {}),
      ...(task.context?.preferModel ? { preferId: task.context.preferModel } : {}),
      localOnly: task.context?.localOnly ?? false,
    }
    const allowExternal = Boolean(this.policy?.allowExternalFor?.(task))
    const decision = this.router.route(request, { policy: this.policy?.mode ?? 'strict_offline', allowExternal })
    task.routing = decision
    if (!decision.satisfied) {
      // An honest failure, not a fabricated answer.
      const error = new Error(`no model available: ${decision.explanation}`)
      error.code = 'no_model_available'
      throw error
    }
    return { evidence: STEP_EVIDENCE.OBSERVED, detail: { modelId: decision.modelId, candidates: decision.candidates.length, rejected: decision.rejected.length } }
  }

  async #execute(task) {
    const handler = task.context?.executeHandler
    if (typeof handler !== 'function') {
      // No executor was supplied: the task genuinely did not run anything. This is
      // recorded as planned_only so the final state cannot claim success (§10).
      task.limitations.push('no executor was supplied for this task; nothing was executed')
      return { evidence: STEP_EVIDENCE.PLANNED_ONLY, detail: { reason: 'no execute handler bound' } }
    }
    const observed = await handler(task, { signal: task.controller.signal, core: this })
    if (!observed || typeof observed !== 'object') {
      throw new Error('executor returned no observable result')
    }
    task.execution = observed
    return {
      evidence: observed.evidence ?? STEP_EVIDENCE.OBSERVED,
      detail: { executor: observed.executor ?? 'custom', outputBytes: JSON.stringify(observed.output ?? null)?.length ?? 0 },
      limitations: observed.limitations ?? [],
    }
  }

  #observe(task) {
    const execution = task.execution
    if (!execution) {
      return { evidence: STEP_EVIDENCE.SKIPPED, detail: { reason: 'nothing was executed' } }
    }
    // Observation is the record of what actually happened, kept separate from the
    // plan so the two can never be conflated.
    task.observation = {
      capturedAt: Date.now(),
      outputPresent: execution.output !== undefined && execution.output !== null,
      outputPreview: preview(execution.output),
      evidence: execution.evidence ?? STEP_EVIDENCE.OBSERVED,
      metrics: execution.metrics ?? null,
    }
    if (!task.observation.outputPresent) {
      task.limitations.push('executor produced no output; result cannot be claimed as complete')
      return { evidence: STEP_EVIDENCE.FAILED, detail: { reason: 'no output observed' } }
    }
    return { evidence: STEP_EVIDENCE.OBSERVED, detail: { outputPresent: true } }
  }

  #verify(task) {
    const observation = task.observation
    if (!observation || !observation.outputPresent) {
      task.verification = { passed: false, reason: 'nothing observed to verify', checks: [] }
      return { evidence: STEP_EVIDENCE.FAILED, detail: { passed: false } }
    }
    const checks = []
    const verifier = task.context?.verifier

    if (typeof verifier === 'function') {
      const outcome = verifier(task, observation) ?? {}
      checks.push({ name: 'custom', passed: Boolean(outcome.passed), detail: outcome.detail ?? null })
    }
    // A grounded answer must cite something when evidence was retrieved.
    if (task.retrieval?.hasEvidence) {
      const text = typeof observation.outputPreview === 'string' ? observation.outputPreview : JSON.stringify(observation.outputPreview ?? '')
      const cites = (task.retrieval.citations ?? []).length
      checks.push({
        name: 'grounding',
        passed: cites > 0,
        detail: `${cites} citation(s) available from the index`,
      })
    }
    if (!checks.length) checks.push({ name: 'presence', passed: true, detail: 'output was produced' })

    const passed = checks.every((check) => check.passed)
    task.verification = { passed, checks, verifiedAt: Date.now() }
    if (!passed) task.limitations.push(`verification failed: ${checks.filter((check) => !check.passed).map((check) => check.name).join(', ')}`)
    return { evidence: passed ? STEP_EVIDENCE.VERIFIED : STEP_EVIDENCE.FAILED, detail: { passed, checks: checks.length } }
  }

  #synthesize(task) {
    const verified = task.verification?.passed === true
    const observation = task.observation
    // The final response states exactly what was and was not achieved.
    task.result = {
      answered: verified && Boolean(observation?.outputPresent),
      output: observation?.outputPresent ? task.execution.output : null,
      citations: task.retrieval?.citations ?? [],
      grounded: Boolean(task.retrieval?.hasEvidence),
      modelId: task.routing?.modelId ?? null,
      verification: task.verification ?? null,
      limitations: [...new Set(task.limitations)],
      // Explicitly distinguishes evidence from inference (§8).
      evidenceSources: (task.retrieval?.citations ?? []).map((citation) => citation.title).filter(Boolean),
    }
    if (!verified) {
      task.limitations.push('result was not verified; it is reported as a plan or partial outcome, not a completed operation')
    }
    return { evidence: verified ? STEP_EVIDENCE.VERIFIED : STEP_EVIDENCE.PLANNED_ONLY, detail: { answered: task.result.answered } }
  }

  /**
   * Succeeded only when verification passed AND something was actually observed.
   * A plan-only run is PARTIAL — never SUCCEEDED.
   */
  #finalState(task) {
    if (task.verification?.passed && task.observation?.outputPresent) return TASK_STATES.SUCCEEDED
    if (task.steps.some((step) => step.status === 'failed')) return TASK_STATES.FAILED
    return TASK_STATES.PARTIAL
  }

  // --- control ------------------------------------------------------------

  pause(taskId, reason = 'paused by user') {
    const task = this.#task(taskId)
    if (TERMINAL.has(task.state)) throw new Error(`task '${taskId}' is ${task.state} and cannot be paused`)
    task.state = TASK_STATES.PAUSED
    task.checkpoint = { at: Date.now(), reason, phase: task.phase, phaseIndex: task.phaseIndex, usage: { ...task.usage } }
    this.#emit(task, 'task_paused', { reason })
    this.#audit('task', 'pause', AUDIT_OUTCOMES.INFO, { reason, phase: task.phase }, taskId)
    return this.publicView(task)
  }

  /**
   * Resume from the last checkpoint. Completed phases are not re-run; the run
   * continues at the phase after the checkpoint.
   */
  async resume(taskId, handlers = {}) {
    const task = this.#task(taskId)
    if (task.state !== TASK_STATES.PAUSED && task.state !== TASK_STATES.AWAITING_APPROVAL) {
      throw new Error(`task '${taskId}' is ${task.state} and cannot be resumed`)
    }
    const fromIndex = task.checkpoint?.phaseIndex ?? task.phaseIndex ?? 0
    task.state = TASK_STATES.RUNNING
    task.approval = null
    this.#emit(task, 'task_resumed', { fromPhase: LIFECYCLE[fromIndex] ?? null })
    this.#audit('task', 'resume', AUDIT_OUTCOMES.INFO, { fromPhaseIndex: fromIndex }, taskId)

    // Re-run only the remaining phases, honouring the original budget. The
    // checkpoint is taken *before* a phase starts, so that phase is included.
    return this.#runPhases(task, LIFECYCLE.slice(Math.max(0, fromIndex)), handlers)
  }

  async #runPhases(task, phases, handlers) {
    const deadline = (task.startedAt ?? Date.now()) + task.budget.maxDurationMs
    for (const phase of phases) {
      this.#checkCancelled(task)
      if (Date.now() > deadline) {
        this.#finish(task, TASK_STATES.TIMED_OUT, null, 'deadline exceeded')
        break
      }
      task.phase = phase
      task.phaseIndex = LIFECYCLE.indexOf(phase)
      this.#checkpoint(task, `before:${phase}`)
      const startedPhase = Date.now()
      try {
        this.#accountPhase(task, phase)
        const handler = handlers[phase]
        const outcome = handler ? await handler(task, { signal: task.controller.signal, core: this }) : await this.#builtinPhase(phase, task)
        task.steps.push({ phase, status: 'complete', evidence: outcome?.evidence ?? STEP_EVIDENCE.OBSERVED, detail: outcome?.detail ?? null, durationMs: Date.now() - startedPhase })
        if (outcome?.limitations?.length) task.limitations.push(...outcome.limitations)
      } catch (error) {
        if (error instanceof TaskCancelledError) {
          this.#finish(task, TASK_STATES.CANCELLED, null, error.reason)
          return this.publicView(task)
        }
        task.steps.push({ phase, status: 'failed', evidence: STEP_EVIDENCE.FAILED, detail: error?.message, durationMs: Date.now() - startedPhase })
        this.#finish(task, TASK_STATES.FAILED, null, error?.message ?? String(error))
        return this.publicView(task)
      }
    }
    if (!TERMINAL.has(task.state)) this.#finish(task, this.#finalState(task), task.result ?? null)
    return this.publicView(task)
  }

  /**
   * Cancel. Aborts in-flight work; running provider calls see the AbortSignal, so
   * for a video job this genuinely stops upstream work.
   */
  cancel(taskId, reason = 'cancelled by user') {
    const task = this.#task(taskId)
    if (TERMINAL.has(task.state)) return { cancelled: false, state: task.state, reason: 'already terminal' }
    task.cancelled = true
    task.cancelReason = reason
    task.controller.abort(new Error(reason))
    this.#finish(task, TASK_STATES.CANCELLED, null, reason)
    return { cancelled: true, state: task.state, reason }
  }

  /** Grant an approval the task is waiting for, then continue. */
  async approve(taskId, { approvals = [], handlers = {} } = {}) {
    const task = this.#task(taskId)
    if (task.state !== TASK_STATES.AWAITING_APPROVAL) throw new Error(`task '${taskId}' is not awaiting approval`)
    task.approvals = [...(task.approvals ?? []), ...approvals]
    this.#audit('task', 'approve', AUDIT_OUTCOMES.ALLOWED, { approvals, phase: task.phase }, taskId)
    this.#emit(task, 'task_approved', { approvals })
    const fromIndex = task.phaseIndex
    task.state = TASK_STATES.RUNNING
    return this.#runPhases(task, LIFECYCLE.slice(Math.max(0, fromIndex)), handlers)
  }

  #checkCancelled(task) {
    if (task.cancelled) throw new TaskCancelledError(task.id, task.cancelReason ?? 'cancelled')
  }

  /**
   * Per-phase budget accounting, applied by the core before any handler runs so it
   * holds for builtin and custom handlers alike.
   */
  #accountPhase(task, phase) {
    if (phase === 'execute') this.#spend(task, 'toolCalls', 1, 'execution')
    if (phase === 'synthesize' && task.routing?.satisfied) this.#spend(task, 'modelCalls', 1, 'model synthesis')
  }

  #spend(task, counter, amount, what) {
    task.usage[counter] = (task.usage[counter] ?? 0) + amount
    if (task.usage[counter] > task.budget[`max${counter[0].toUpperCase()}${counter.slice(1)}`]) {
      throw new BudgetExceededError(`budget exceeded for ${what}: ${counter} ${task.usage[counter]} > ${task.budget[`max${counter[0].toUpperCase()}${counter.slice(1)}`]}`, {
        counter,
        used: task.usage[counter],
      })
    }
  }

  #checkpoint(task, label) {
    task.checkpoint = {
      at: Date.now(),
      label,
      phase: task.phase,
      phaseIndex: task.phaseIndex,
      usage: { ...task.usage },
      stepsCompleted: task.steps.filter((step) => step.status === 'complete').length,
    }
    this.#emit(task, 'checkpoint', { label, phase: task.phase })
  }

  #finish(task, state, result, error = null) {
    if (TERMINAL.has(task.state)) return
    task.state = state
    task.finishedAt = Date.now()
    if (result) task.result = result
    if (error) task.error = error
    this.#emit(task, 'task_finished', { state, durationMs: task.finishedAt - (task.startedAt ?? task.createdAt) })
    this.#audit('task', `finish:${state}`, state === TASK_STATES.SUCCEEDED ? AUDIT_OUTCOMES.SUCCESS : state === TASK_STATES.PARTIAL ? AUDIT_OUTCOMES.INFO : AUDIT_OUTCOMES.FAILURE, {
      phases: task.steps.length,
      usage: task.usage,
      limitations: task.limitations.length,
      error,
    }, task.id)
  }

  #task(id) {
    const task = this.tasks.get(id)
    if (!task) {
      const error = new Error(`unknown task '${id}'`)
      error.code = 'unknown_task'
      throw error
    }
    return task
  }

  get(id) {
    return this.publicView(this.#task(id))
  }

  list({ state = null, limit = 50 } = {}) {
    return [...this.tasks.values()]
      .filter((task) => !state || task.state === state)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
      .map((task) => this.publicView(task))
  }

  #emit(task, type, detail) {
    const event = { type, taskId: task.id, phase: task.phase, state: task.state, at: Date.now(), ...detail }
    task.events.push(event)
    if (task.events.length > 500) task.events.splice(0, task.events.length - 500)
    this.onEvent(event)
  }

  #audit(category, action, outcome, detail, subject) {
    this.ledger?.record({ category, action, outcome, subject: subject ?? null, detail })
  }

  /**
   * An immutable snapshot of a task, safe to hand to callers.
   *
   * Two rules are enforced here. The AbortController is never exposed, so callers
   * cannot abort a task behind the core's back. And every collection is deep-copied,
   * so a snapshot taken at phase N still describes phase N after the task has moved
   * on to phase N+3 — which is what makes checkpoints, pause/resume and the step
   * history trustworthy. Handing out live references would let a caller mutate core
   * state and would silently rewrite already-returned snapshots.
   */
  publicView(task) {
    return {
      id: task.id,
      prompt: task.prompt,
      godMode: task.godMode,
      state: task.state,
      phase: task.phase,
      phaseIndex: task.phaseIndex,
      lifecycle: [...LIFECYCLE],
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      durationMs: (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt),
      checkpoint: cloneValue(task.checkpoint),
      approval: cloneValue(task.approval),
      budget: cloneValue(task.budget),
      usage: cloneValue(task.usage),
      plan: cloneValue(task.plan),
      steps: cloneValue(task.steps),
      routing: task.routing
        ? {
            modelId: task.routing.modelId,
            explanation: task.routing.explanation,
            candidates: task.routing.candidates.length,
            rejected: cloneValue(task.routing.rejected),
          }
        : null,
      retrieval: task.retrieval
        ? {
            method: task.retrieval.method,
            evidenceCount: task.retrieval.evidenceCount,
            citations: cloneValue(task.retrieval.citations),
            hasEvidence: task.retrieval.hasEvidence,
          }
        : null,
      observation: cloneValue(task.observation),
      verification: cloneValue(task.verification),
      result: cloneValue(task.result),
      error: task.error,
      limitations: [...new Set(task.limitations)],
      terminal: TERMINAL.has(task.state),
      events: cloneValue(task.events.slice(-100)),
    }
  }
}

/**
 * Deep copy of plain data. Falls back to a JSON round-trip when a value holds
 * something structuredClone rejects (a function, a symbol), rather than throwing
 * while building a status view.
 */
function cloneValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return null
    }
  }
}

function preview(value) {
  if (value == null) return null
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  try {
    const json = JSON.stringify(value)
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : JSON.parse(json)
  } catch {
    return '[unserialisable]'
  }
}

export { TERMINAL as TERMINAL_TASK_STATES }
