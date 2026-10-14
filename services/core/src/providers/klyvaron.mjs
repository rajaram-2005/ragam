// The Klyvaron provider: a first-party model served from this process.
//
// Unlike every other adapter in this directory, nothing here crosses the network. The
// weights are local files, the forward pass is local computation, and the only reason
// this still implements `BaseProvider` is so the router, the audit ledger and the chat
// path treat it exactly like any other model — no special case, and therefore no
// special case that can drift.
//
// THE HONESTY RULES THIS ADAPTER FOLLOWS
//
//  §5A  A base model must not be presented as an assistant. `instructionTuned` comes
//       from the artifact manifest, and when it is false the response says so and the
//       router will not select this model for a conversational request unless the user
//       explicitly pinned it.
//  §9   Token budgets are enforced, not documented. `maxTokens` is clamped by the
//       manifest and the context window; a request cannot ask for more than the model
//       can produce.
//  §10  No quality adjective is attached to a tier label. The descriptor carries
//       measured facts (parameters, context, tokens/second) and the artifact's own
//       declared limitations, and nothing else.

import { BaseProvider, OPERATIONS, ProviderError } from './base.mjs'
import { AVAILABILITY } from '../router/registry.mjs'
import { KlyvaronRuntime } from '../klyvaron/runtime.mjs'
import { ArtifactError } from '../klyvaron/format.mjs'
import { createHash } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'

export class KlyvaronProvider extends BaseProvider {
  static operations = [OPERATIONS.CHAT, OPERATIONS.CHAT_STREAM]

  /**
   * @param {object} options
   * @param {KlyvaronRuntime} options.runtime  a verified, loaded artifact
   * @param {object} options.guard             required by BaseProvider; never used here
   * @param {number} [options.timeoutMs]       wall-clock ceiling for one completion
   */
  constructor({ runtime, guard, onEvent, timeoutMs = 120_000, loadMs = null, executor = null }) {
    super({ name: 'klyvaron', guard, onEvent, timeoutMs })
    if (!(runtime instanceof KlyvaronRuntime)) throw new TypeError('KlyvaronProvider requires a loaded KlyvaronRuntime')
    this.executor = executor
    // The app retains verified metadata, not a second copy of every model's arrays.
    this.runtime = executor ? Object.freeze({
      manifest: structuredClone(runtime.manifest), directory: runtime.directory,
      parameterCount: runtime.parameterCount, contextTokens: runtime.contextTokens,
      instructionTuned: runtime.instructionTuned, sha256: runtime.sha256,
      quantization: runtime.quantization, residentWeightBytes: runtime.residentWeightBytes,
    }) : runtime
    this.expected = { weightsSha256: runtime.sha256,
      manifestSha256: createHash('sha256').update(JSON.stringify(runtime.manifest)).digest('hex') }
    this.loadMs = loadMs
    this.#measurements = { completions: 0, generatedTokens: 0, totalMs: 0 }
  }

  #measurements
  #busy = false

  get instructionTuned() {
    return this.runtime.instructionTuned
  }

  /** Redacted descriptor for health responses. Nothing here is secret, but the shape matches. */
  safeDescriptor() {
    const resident = !this.executor || (this.executor.resident?.directory === this.runtime.directory
      && JSON.stringify(this.executor.resident.expected) === JSON.stringify(this.expected))
    return {
      provider: this.name,
      model: this.runtime.manifest.id,
      version: this.runtime.manifest.version,
      tier: this.runtime.manifest.tier,
      parameters: this.runtime.parameterCount,
      quantization: this.runtime.quantization,
      residentWeightBytes: resident ? this.runtime.residentWeightBytes : 0,
      weightPayloadBytes: this.runtime.residentWeightBytes,
      resident,
      executionBackend: this.executor ? 'local_cpu_worker' : 'local_cpu_cooperative',
      contextTokens: this.runtime.contextTokens,
      instructionTuned: this.instructionTuned,
      weightsSha256: this.runtime.sha256,
      // The artifact's own words, verbatim. A provider that summarises its limitations
      // is a provider that can soften them.
      limitations: [...this.runtime.manifest.limitations],
      measurement: this.measurement(),
    }
  }

  /** Measured, not estimated: how fast this model actually generates on this host. */
  measurement() {
    const { completions, generatedTokens, totalMs } = this.#measurements
    return {
      completions,
      generatedTokens,
      meanTokensPerSecond: generatedTokens && totalMs ? Number(((generatedTokens / totalMs) * 1000).toFixed(2)) : null,
      meanLatencyMs: completions ? Number((totalMs / completions).toFixed(1)) : null,
    }
  }

  async probe() {
    // Startup verification established eligibility, not permanent RAM residency.
    // Worker loading independently rechecks bytes and the pinned manifest identity.
    // In-memory library users have cooperative execution, not worker isolation.
    return {
      availability: AVAILABILITY.READY,
      detail: {
        model: this.runtime.manifest.id,
        parameters: this.runtime.parameterCount,
        contextTokens: this.runtime.contextTokens,
        instructionTuned: this.instructionTuned,
        loadedInMs: this.loadMs,
        resident: this.safeDescriptor().resident,
        verification: this.executor ? 'verified_at_startup; reverified on worker load' : 'in_memory_runtime',
      },
      medianLatencyMs: this.measurement().meanLatencyMs ?? undefined,
      tokensPerSecond: this.measurement().meanTokensPerSecond ?? undefined,
    }
  }

  /** Clamp a requested token budget to what the manifest and context allow. */
  #tokenBudget(requested) {
    const manifestLimit = this.runtime.manifest.generation?.maxNewTokens ?? 64
    const ceiling = Math.min(manifestLimit, this.runtime.contextTokens)
    if (requested == null) return ceiling
    const value = Math.trunc(Number(requested))
    if (!Number.isFinite(value) || value < 1) throw new ProviderError('maxTokens must be a positive integer', { code: 'invalid_request', status: 400 })
    return Math.min(value, ceiling)
  }

  #promptFrom(request) {
    // A base completion model continues text. The prompt is the last message's content;
    // roles are ignored deliberately rather than rendered into a pseudo-transcript the
    // model was never trained on.
    const messages = Array.isArray(request.messages) ? request.messages : []
    const last = messages.length ? messages[messages.length - 1] : null
    const prompt = typeof last?.content === 'string' ? last.content : typeof request.prompt === 'string' ? request.prompt : ''
    if (!prompt.trim()) throw new ProviderError('a prompt is required', { code: 'invalid_request', status: 400 })
    return prompt
  }

  async *#cooperative(generation, signal) {
    // Library/test use can supply an in-memory runtime without an artifact directory.
    // The application uses the worker executor instead, including mid-pass cancellation.
    if (this.#busy) throw new ProviderError('local runtime is busy', { code: 'local_busy', status: 503 })
    this.#busy = true
    const deadline = performance.now() + this.timeoutMs
    const steps = this.runtime.generateSteps({ ...generation, signal })
    try {
      for (;;) {
        if (signal?.aborted) throw new ProviderError('local generation cancelled', { code: 'cancelled', status: 499 })
        const step = steps.next()
        if (performance.now() > deadline) throw new ProviderError('local generation exceeded its deadline', { code: 'timeout', status: 504 })
        if (step.done) { yield { type: 'result', result: step.value }; break }
        yield step.value
        await nextTurn()
      }
    } finally { steps.return(); this.#busy = false }
  }

  async *#iterate(request) {
    const started = performance.now()
    const prompt = this.#promptFrom(request)
    const budget = this.#tokenBudget(request.maxTokens ?? request.max_new_tokens)
    const generation = {
      prompt, maxNewTokens: budget,
      temperature: Number.isFinite(request.temperature) ? request.temperature : 0,
      topK: Number.isFinite(request.topK) ? request.topK : 40,
      seed: Number.isFinite(request.seed) ? request.seed : 0,
      stop: Array.isArray(request.stop) ? request.stop : [],
    }
    let result = null
    try {
      const events = this.executor
        ? this.executor.events({ directory: this.runtime.directory, expected: this.expected, generation }, { signal: request.signal, timeoutMs: this.timeoutMs })
        : this.#cooperative(generation, request.signal)
      for await (const event of events) {
        if (event.type === 'token') yield event.text
        else if (event.type === 'resource') await request.onResourceAdjustment?.(event.adjustment)
        else if (event.type === 'result') result = event.result
      }
      if (!result) throw new ProviderError('local inference returned no completion', { code: 'inference_failed', status: 503 })
      if (result.stoppedBy === 'cancelled') throw new ProviderError('local generation cancelled', { code: 'cancelled', status: 499 })
    } catch (error) {
      this.onEvent({ type: 'provider_error', provider: this.name, code: error.code, ms: performance.now() - started })
      if (error instanceof ArtifactError) throw new ProviderError(`klyvaron: ${error.message}`, { code: error.code, status: error.code === 'needs_hardware' ? 503 : 400 })
      throw error
    }
    const elapsed = Math.max(0.001, performance.now() - started)
    this.#measurements.completions += 1
    this.#measurements.generatedTokens += result.generatedTokens
    this.#measurements.totalMs += elapsed
    this.onEvent({ type: 'provider_request', provider: this.name, operation: request.stream ? OPERATIONS.CHAT_STREAM : OPERATIONS.CHAT, status: 200, ms: elapsed })
    const response = {
      text: result.text,
      resourceAdjustment: result.resourceAdjustment,
      instructionTuned: this.instructionTuned,
      model: this.runtime.manifest.id,
      version: this.runtime.manifest.version,
      doneReason: result.stoppedBy,
      provider: this.name,
      limitation: this.instructionTuned ? null
        : 'Klyvaron Lite is a base completion model: it continues the text you give it. It does not follow instructions and its output is not an answer.',
      usage: { promptTokens: result.promptTokens, completionTokens: result.generatedTokens,
        totalTokens: result.promptTokens + result.generatedTokens },
      timingMs: elapsed,
      tokensPerSecond: Number(((result.generatedTokens / elapsed) * 1000).toFixed(2)),
    }
    await request.onComplete?.(response)
    return response
  }

  async chat(request) {
    this.assertSupports(OPERATIONS.CHAT)
    const stream = this.#iterate({ ...request, stream: false })
    for (;;) { const next = await stream.next(); if (next.done) return next.value }
  }

  async *chatStream(request) {
    this.assertSupports(OPERATIONS.CHAT_STREAM)
    return yield* this.#iterate({ ...request, stream: true })
  }
}
