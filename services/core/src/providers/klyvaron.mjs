// The Klyvaron provider: a first-party model served from this process.
//
// Nothing here crosses the network. Weights are local verified artifacts, inference
// runs locally inside `LocalCpuExecutor` (or cooperative in-memory mode for unit tests),
// and instruction-tuned `klyvaron-chat-v1` models (`klyvaron-pro-lm`, `klyvaron-max-lm`)
// render conversation turns + retrieved freshness ages cleanly while base completion
// models (`aetheris-lite-lm`) retain verbatim text continuation semantics.

import { BaseProvider, OPERATIONS, ProviderError } from './base.mjs'
import { AVAILABILITY } from '../router/registry.mjs'
import { KlyvaronRuntime, buildTokenizerFromManifest } from '../klyvaron/runtime.mjs'
import { ArtifactError } from '../klyvaron/format.mjs'
import { createHash } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'

const DEFAULT_CHAT_SYSTEM = 'Klyvaron first-party language model. Answer directly from available context and state clearly when supporting evidence is absent.'

function extractContextFromSystemMessages(messages) {
  const sysParts = messages.filter((m) => m?.role === 'system' && typeof m.content === 'string').map((m) => m.content.trim()).filter(Boolean)
  for (const text of sysParts) {
    if (/context material|retrieved|\[source=/i.test(text)) {
      return text.slice(0, 700)
    }
  }
  return 'none'
}

export class KlyvaronProvider extends BaseProvider {
  static operations = [OPERATIONS.CHAT, OPERATIONS.CHAT_STREAM]

  constructor({ runtime, guard, onEvent, timeoutMs = 120_000, loadMs = null, executor = null }) {
    super({ name: 'klyvaron', guard, onEvent, timeoutMs })
    if (!(runtime instanceof KlyvaronRuntime)) throw new TypeError('KlyvaronProvider requires a loaded KlyvaronRuntime')
    this.executor = executor
    this.runtime = executor ? Object.freeze({
      manifest: structuredClone(runtime.manifest),
      directory: runtime.directory,
      parameterCount: runtime.parameterCount,
      contextTokens: runtime.contextTokens,
      instructionTuned: runtime.instructionTuned,
      sha256: runtime.sha256,
      quantization: runtime.quantization,
      residentWeightBytes: runtime.residentWeightBytes,
    }) : runtime
    this.#promptTokenizer = runtime.manifest.tokenizer?.kind === 'byte-bpe'
      ? buildTokenizerFromManifest(runtime.manifest.tokenizer)
      : null
    this.expected = {
      weightsSha256: runtime.sha256,
      manifestSha256: createHash('sha256').update(JSON.stringify(runtime.manifest)).digest('hex'),
      ...(runtime.activeAdapter ? { adapterDir: runtime.activeAdapter.directory, adapterSha256: runtime.activeAdapter.sha256 } : {}),
    }
    this.activeAdapter = runtime.activeAdapter ?? null
    this.loadMs = loadMs
    this.#measurements = { completions: 0, generatedTokens: 0, totalMs: 0 }
  }

  attachAdapter(adapterDirectory) {
    if (!this.executor) {
      this.activeAdapter = this.runtime.attachAdapter(adapterDirectory)
    } else {
      const probe = KlyvaronRuntime.load(this.runtime.directory)
      this.activeAdapter = probe.attachAdapter(adapterDirectory)
    }
    this.expected = {
      weightsSha256: this.expected.weightsSha256,
      manifestSha256: this.expected.manifestSha256,
      adapterDir: this.activeAdapter.directory,
      adapterSha256: this.activeAdapter.sha256,
    }
    return this.activeAdapter
  }

  detachAdapter() {
    if (!this.executor) this.runtime.detachAdapter()
    this.activeAdapter = null
    this.expected = {
      weightsSha256: this.expected.weightsSha256,
      manifestSha256: this.expected.manifestSha256,
    }
  }

  #promptTokenizer
  #measurements
  #busy = false

  get instructionTuned() {
    return this.runtime.instructionTuned
  }

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
      limitations: [...this.runtime.manifest.limitations],
      measurement: this.measurement(),
    }
  }

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

  #tokenBudget(requested) {
    const manifestLimit = this.runtime.manifest.generation?.maxNewTokens ?? 64
    const ceiling = Math.min(manifestLimit, this.runtime.contextTokens)
    if (requested == null) return ceiling
    const value = Math.trunc(Number(requested))
    if (!Number.isFinite(value) || value < 1) throw new ProviderError('maxTokens must be a positive integer', { code: 'invalid_request', status: 400 })
    return Math.min(value, ceiling)
  }

  #buildInput(request) {
    const messages = Array.isArray(request.messages) ? request.messages : []
    const last = messages.length ? messages[messages.length - 1] : null
    const rawText = typeof last?.content === 'string' ? last.content : typeof request.prompt === 'string' ? request.prompt : ''
    if (!rawText.trim()) throw new ProviderError('a prompt is required', { code: 'invalid_request', status: 400 })

    const chatTemplate = this.runtime.manifest.chatTemplate
    if (!this.instructionTuned || chatTemplate?.format !== 'klyvaron-chat-v1' || rawText.startsWith('<|system|>\n')) {
      return {
        prompt: rawText,
        ages: request.ages ?? null,
        stop: Array.isArray(request.stop) && request.stop.length
          ? request.stop
          : (this.runtime.manifest.generation?.stop ?? []),
      }
    }

    const systemPrompt = chatTemplate.systemPrompt || DEFAULT_CHAT_SYSTEM
    const context = typeof request.context === 'string' && request.context.trim()
      ? request.context.trim()
      : extractContextFromSystemMessages(messages)
    const recentTurns = messages
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-5)

    const beforeCtx = `<|system|>\n${systemPrompt}\n<|context|>\n`
    let afterCtx = '\n'
    for (let i = 0; i < recentTurns.length; i += 1) {
      const turn = recentTurns[i]
      if (turn.role === 'user') {
        afterCtx += `<|user|>\n${turn.content.trim()}\n`
      } else {
        afterCtx += `<|assistant|>\n${turn.content.trim()}<|end|>\n`
      }
    }
    if (!afterCtx.endsWith('\n') || recentTurns[recentTurns.length - 1]?.role !== 'user') {
      afterCtx += `<|user|>\n${rawText.trim()}\n`
    }
    afterCtx += '<|assistant|>\n'

    const prompt = `${beforeCtx}${context}${afterCtx}`
    let ages = request.ages ?? null
    if (!ages && this.#promptTokenizer && (this.runtime.manifest.architecture.age_buckets ?? 0) > 0) {
      const tBefore = this.#promptTokenizer.encode(beforeCtx)
      const tCtx = this.#promptTokenizer.encode(context)
      const tAfter = this.#promptTokenizer.encode(afterCtx)
      const ctxAge = Number.isInteger(request.contextAgeBucket)
        ? request.contextAgeBucket
        : (context === 'none' ? 15 : 1)
      const ageArr = new Int32Array(tBefore.length + tCtx.length + tAfter.length)
      ageArr.fill(ctxAge, tBefore.length, tBefore.length + tCtx.length)
      ages = Array.from(ageArr)
    }

    const mergedStop = Array.isArray(request.stop) && request.stop.length
      ? request.stop
      : (this.runtime.manifest.generation?.stop ?? chatTemplate.stop ?? [])
    return { prompt, ages, stop: mergedStop }
  }

  async *#cooperative(generation, signal) {
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
    const { prompt, ages, stop } = this.#buildInput(request)
    const budget = this.#tokenBudget(request.maxTokens ?? request.max_new_tokens)
    const generation = {
      prompt,
      ages,
      state: Number.isInteger(request.state) ? request.state : null,
      maxNewTokens: budget,
      temperature: Number.isFinite(request.temperature) ? request.temperature : 0,
      topK: Number.isFinite(request.topK) ? request.topK : 40,
      seed: Number.isFinite(request.seed) ? request.seed : 0,
      stop,
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
      differentiators: result.differentiators ?? null,
      limitation: this.instructionTuned ? null
        : 'Klyvaron Lite is a base completion model: it continues the text you give it. It does not follow instructions and its output is not an answer.',
      usage: {
        promptTokens: result.promptTokens,
        completionTokens: result.generatedTokens,
        totalTokens: result.promptTokens + result.generatedTokens,
      },
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
