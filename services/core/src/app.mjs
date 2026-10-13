// Application composition: wires policy, routing, providers, knowledge, media,
// plugins, MCP, God Core and the audit ledger into one service, and exposes the
// HTTP API the five product areas consume.
//
// Design rule: the browser never holds a credential and never decides policy. Every
// enforcement point lives here.

import { createServer } from 'node:http'
import { resolve, join, sep } from 'node:path'
import { totalmem, cpus, freemem } from 'node:os'
import { readFile, stat } from 'node:fs/promises'

import { AuditLedger, AUDIT_OUTCOMES } from './audit/ledger.mjs'
import { createEgressGuard, installGlobalEgressGuard, createDataPolicy, RUNTIME_POLICIES, mostSensitiveDataClass } from './policy/egress.mjs'
import { classifyText, redactDeep } from './policy/classify.mjs'
import { familyReport, tierClaimFor } from './klyvaron/tiers.mjs'
import { ModelRegistry, ModelRouter, MODEL_KINDS, MODALITIES, AVAILABILITY } from './router/registry.mjs'
import { OllamaProvider, OpenAiCompatLocalProvider, normalizeMessages } from './providers/local.mjs'
import { FreellmapiProvider } from './providers/freellmapi.mjs'
import { KnowledgePipeline } from './knowledge/pipeline.mjs'
import { CANDIDATE_STATES, MemoryStore } from './memory/store.mjs'
import { MediaJobQueue, JOB_STATES } from './media/jobs.mjs'
import { validateMedia, MEDIA_KINDS } from './media/validate.mjs'
import { PluginRegistry } from './plugins/registry.mjs'
import { validateManifest, SCOPES, ELEVATED_SCOPES } from './plugins/manifest.mjs'
import { McpRegistry, RISK, SERVER_KINDS } from './mcp/layer.mjs'
import { GodCore, TASK_STATES, LIFECYCLE } from './godcore/lifecycle.mjs'
import { registerBuiltins } from './builtins.mjs'
import { publicConfig, redactUrl } from './config.mjs'

const MAX_BODY_BYTES = 4 * 1024 * 1024

export class AetherisOmniApp {
  constructor({ config, ledger = null }) {
    this.config = config
    this.events = []

    // The model family is validated at startup, so a family record that claims a
    // capability nothing backs stops the process instead of reaching a user. Refusing
    // to boot on a dishonest record is the only enforcement that cannot be quietly
    // worked around later: by the time a request arrives, the check has already run.
    this.modelFamily = familyReport()
    if (!this.modelFamily.valid) {
      throw new Error(
        'the Klyvaron family record is inconsistent and will not be served:\n  - '
        + this.modelFamily.violations.join('\n  - '),
      )
    }
    this.ledger = ledger ?? new AuditLedger(resolve(config.dataDir, 'audit.sqlite'))

    // --- hardware profile (real measurements, used by the router) ----------
    this.hardware = {
      cpuCount: cpus().length,
      ramGb: round(totalmem() / 1024 ** 3, 2),
      ramFreeGb: round(freemem() / 1024 ** 3, 2),
      // No GPU detection is possible without vendor tooling; declare 0 rather than guess.
      vramGb: 0,
      gpuDetected: false,
      detectedAt: Date.now(),
    }

    // --- policy ------------------------------------------------------------
    this.guard = createEgressGuard({
      policy: config.policy,
      localAllowlist: config.localAllowlist,
      onlineAllowlist: config.onlineAllowlist,
      onDecision: (event) => this.#onEvent(event),
    })
    this.restoreGlobalFetch = installGlobalEgressGuard(this.guard)
    this.dataPolicy = createDataPolicy({ externalCeiling: config.externalCeiling })

    // --- registry & router -------------------------------------------------
    this.registry = new ModelRegistry()
    this.router = new ModelRouter({ registry: this.registry, hardware: this.hardware })
    this.providers = {}
    this.#registerProviders()

    // --- knowledge ---------------------------------------------------------
    this.knowledge = new KnowledgePipeline({
      dbFile: config.knowledge.dbFile,
      ledger: this.ledger,
      chunking: {
        targetChars: config.knowledge.chunkTargetChars,
        maxChars: config.knowledge.chunkMaxChars,
        overlapChars: config.knowledge.chunkOverlapChars,
      },
    })
    this.knowledge.rebuildIndex({ kind: 'startup' })

    // --- memory ------------------------------------------------------------
    // Its own database file, deliberately: §7 requires approved memory and the document
    // retrieval index to stay separate mechanisms, and separate files make that a fact
    // about the deployment rather than a convention in the code. Nothing that trains a
    // model reads this file.
    this.memory = new MemoryStore(resolve(config.dataDir, 'memory.sqlite'))

    // --- media -------------------------------------------------------------
    this.media = new MediaJobQueue({
      storageDir: resolve(config.dataDir, 'media'),
      concurrency: config.media.concurrency,
      ledger: this.ledger,
      onEvent: (event) => this.#onEvent(event),
    })

    // --- plugins & MCP -----------------------------------------------------
    this.plugins = new PluginRegistry({
      ledger: this.ledger,
      // Elevated scopes are never granted by default: an operator must opt in.
      grantedScopes: Object.values(SCOPES).filter((scope) => !ELEVATED_SCOPES.includes(scope)).concat(['fs.read', 'knowledge.read']),
      onEvent: (event) => this.#onEvent(event),
    })
    this.mcp = new McpRegistry({
      ledger: this.ledger,
      // SYSTEM-risk tools (terminal/process/device) are refused outright in this build.
      allowedRisks: [RISK.READ_ONLY, RISK.WRITE, RISK.DESTRUCTIVE, RISK.EXTERNAL],
      onEvent: (event) => this.#onEvent(event),
    })

    // --- God Core ----------------------------------------------------------
    this.godCore = new GodCore({
      router: this.router,
      knowledge: this.knowledge,
      mcp: this.mcp,
      plugins: this.plugins,
      ledger: this.ledger,
      policy: {
        mode: config.policy,
        allowExternalFor: (task) => this.#mayGoExternal(task),
      },
      onEvent: (event) => this.#onEvent(event),
      budget: { maxSteps: config.godMode.maxSteps, maxDurationMs: config.godMode.maxDurationMs },
    })

    this.startedAt = Date.now()
    this.ledger.record({
      category: 'system',
      action: 'startup',
      outcome: AUDIT_OUTCOMES.INFO,
      detail: { policy: config.policy, hardware: this.hardware, warnings: config.warnings },
    })

    // --- built-in plugins and the in-process MCP server ---------------------
    // Registered last so the ledger reads startup -> registration, and so a
    // built-in handler can call readiness() on a fully constructed app. Without
    // these the Plugins and MCP areas would have nothing real to inspect: a
    // browser cannot bind a local_tool handler, so they must be bound in code.
    this.builtins = registerBuiltins(this)
  }

  // --- wiring -------------------------------------------------------------

  #registerProviders() {
    const { config } = this
    if (config.ollama.enabled) {
      this.providers.ollama = new OllamaProvider({ baseUrl: config.ollama.baseUrl, guard: this.guard, onEvent: (e) => this.#onEvent(e) })
    }
    if (config.llamaCpp.enabled) {
      this.providers.llamacpp = new OpenAiCompatLocalProvider({
        baseUrl: config.llamaCpp.baseUrl,
        runtime: config.llamaCpp.runtime,
        apiKey: config.llamaCpp.apiKey,
        guard: this.guard,
        onEvent: (e) => this.#onEvent(e),
      })
    }
    if (config.freellmapi.enabled) {
      this.providers.freellmapi = new FreellmapiProvider({
        baseUrl: config.freellmapi.baseUrl,
        apiKey: config.freellmapi.apiKey,
        guard: this.guard,
        onEvent: (e) => this.#onEvent(e),
        videoTimeoutMs: config.freellmapi.videoTimeoutMs ?? config.media.videoTimeoutMs,
      })
    }
  }

  /**
   * Probe every configured provider and synchronise the registry with what was
   * actually found. This is what makes readiness honest: a model enters the routing
   * table as READY only because a live probe said so.
   */
  async probeAll({ registerDiscovered = true } = {}) {
    const results = {}
    for (const [name, provider] of Object.entries(this.providers)) {
      let probe
      try {
        probe = await provider.probe()
      } catch (error) {
        probe = { availability: AVAILABILITY.UNREACHABLE, detail: error?.message ?? String(error) }
      }
      results[name] = probe
      this.ledger.record({ category: 'model', action: `probe:${name}`, outcome: probe.availability === AVAILABILITY.READY ? AUDIT_OUTCOMES.SUCCESS : AUDIT_OUTCOMES.INFO, detail: probe })

      if (registerDiscovered && probe.availability === AVAILABILITY.READY) {
        await this.#registerDiscoveredModels(name, provider, probe)
      }
    }
    // Record availability for models already registered under this provider.
    // A descriptor's `provider` is the provider's own name, which is exactly the key
    // `results` is built with, so no translation is needed here.
    for (const model of this.registry.list()) {
      const probe = model.provider ? results[model.provider] : null
      if (!probe) continue
      this.registry.observe(model.id, {
        availability: probe.availability,
        detail: probe.detail,
      })
    }
    return { providers: results, models: this.registry.list().map((model) => ({ id: model.id, availability: model.measured.availability })) }
  }

  async #registerDiscoveredModels(name, provider, probe) {
    try {
      if (name === 'ollama') {
        const models = await provider.listLocalModels()
        for (const model of models) {
          const id = `ollama:${model.id}`
          const descriptor = {
            id,
            kind: MODEL_KINDS.LOCAL_LLM,
            displayName: `${model.id} (Ollama)`,
            capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
            location: 'local',
            streaming: true,
            toolCalling: false, // Ollama supports tools on some models; not assumed here.
            quantization: model.quantization ?? null,
            licence: 'unknown',
            parametersBillions: parseParameterSize(model.parameterSize),
            // Conservative RAM estimate: size on disk plus headroom.
            minRamGb: model.sizeBytes ? round((model.sizeBytes / 1024 ** 3) * 1.4, 2) : 2,
            tags: ['discovered', 'ollama'],
            costWeight: model.sizeBytes ? round(Math.max(0.5, model.sizeBytes / 1024 ** 3), 2) : 1,
          }
          this.registry.upsert(descriptor)
          this.registry.observe(id, { availability: AVAILABILITY.READY, detail: { discoveredVia: 'ollama /api/tags' } })
        }
      } else if (name === 'llamacpp') {
        const probeModels = probe.detail?.models ?? []
        for (const served of probeModels) {
          const id = `llamacpp:${served}`
          this.registry.upsert({
            id,
            kind: MODEL_KINDS.LOCAL_LLM,
            displayName: `${served} (${this.config.llamaCpp.runtime})`,
            capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
            location: 'local',
            streaming: true,
            toolCalling: true,
            licence: 'unknown',
            minRamGb: 1,
            tags: ['discovered', 'openai-compatible'],
          })
          this.registry.observe(id, { availability: AVAILABILITY.READY, detail: { discoveredVia: `${name} /v1/models` } })
        }
      } else if (name === 'freellmapi') {
        const models = await provider.listModels({ readyOnly: true }).catch(() => [])
        // Register one online chat entry plus the media capabilities the gateway
        // genuinely serves. The catalog is not enumerated into hundreds of rows:
        // 'auto' is the documented routing behaviour.
        this.registry.upsert({
          id: 'freellmapi:auto',
          kind: MODEL_KINDS.ONLINE_LLM,
          displayName: 'FreeLLMAPI auto-routed chat',
          capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
          location: 'online',
          provider: 'freellmapi',
          toolCalling: true,
          streaming: true,
          structuredOutput: true,
          licence: 'provider-terms',
          costWeight: 1.4,
          tags: ['gateway'],
        })
        this.registry.observe('freellmapi:auto', { availability: AVAILABILITY.READY, detail: { readyModels: models.length } })
        this.registry.upsert({
          id: 'freellmapi:embeddings',
          kind: MODEL_KINDS.ONLINE_EMBEDDING,
          displayName: 'FreeLLMAPI embeddings',
          capabilities: [MODALITIES.TEXT_IN, MODALITIES.EMBEDDING_OUT],
          location: 'online',
          provider: 'freellmapi',
          licence: 'provider-terms',
          costWeight: 1.1,
        })
        this.registry.observe('freellmapi:embeddings', { availability: AVAILABILITY.READY })
        this.registry.upsert({
          id: 'freellmapi:image',
          kind: MODEL_KINDS.ONLINE_IMAGE_GEN,
          displayName: 'FreeLLMAPI image generation',
          capabilities: [MODALITIES.TEXT_IN, MODALITIES.IMAGE_OUT],
          location: 'online',
          provider: 'freellmapi',
          licence: 'provider-terms',
          costWeight: 2,
        })
        this.registry.observe('freellmapi:image', { availability: AVAILABILITY.READY })
        this.registry.upsert({
          id: 'freellmapi:video',
          kind: MODEL_KINDS.ONLINE_VIDEO_GEN,
          displayName: 'FreeLLMAPI video generation',
          capabilities: [MODALITIES.TEXT_IN, MODALITIES.VIDEO_OUT],
          location: 'online',
          provider: 'freellmapi',
          licence: 'provider-terms',
          costWeight: 3,
          // Documented limitation, recorded so the UI can state it honestly.
          tags: ['gateway', 'video-platforms:pollinations|huggingface', 'not-supported-on-custom-endpoints'],
        })
        this.registry.observe('freellmapi:video', { availability: AVAILABILITY.READY })
      }
    } catch (error) {
      this.ledger.record({ category: 'model', action: `register_discovered:${name}`, outcome: AUDIT_OUTCOMES.FAILURE, detail: { error: error?.message } })
    }
  }

  /** Hybrid/online gate: classification + policy + explicit authorization. */
  #mayGoExternal(task) {
    if (this.config.policy === RUNTIME_POLICIES.STRICT_OFFLINE) return false
    if (this.config.policy === RUNTIME_POLICIES.ONLINE_ENABLED) return true
    const classification = task.dataClass
      ? { dataClass: task.dataClass, reason: 'explicitly declared' }
      : classifyText(task.prompt)
    const decision = this.dataPolicy.authorizeExternalSend(classification.dataClass, task.context?.externalAuthorization ?? {})
    if (!decision.allowed) {
      this.ledger.record({
        category: 'policy',
        action: 'external_send_denied',
        outcome: AUDIT_OUTCOMES.DENIED,
        subject: task.id,
        detail: { dataClass: classification.dataClass, reason: decision.reason, signals: classification.signals },
      })
    }
    return decision.allowed
  }

  #onEvent(event) {
    this.events.push(event)
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a broken listener must not take the service down */
      }
    }
  }

  listeners = new Set()

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Public hook so the HTTP layer can record request telemetry. */
  onHttpRequest(event) {
    this.#onEvent({ type: 'http', ...event })
  }

  // --- capability operations ---------------------------------------------

  /**
   * Chat completion. Routes through the model router, enforces policy, redacts
   * secrets before any external send, and returns the routing decision alongside
   * the answer so the UI can show *why* this model was used.
   */
  /**
   * Record turns for session recall, when the client asked for a session.
   *
   * Opt-in: no session id means nothing is written at all, which is what makes "chat
   * without history" the default rather than a setting. A recording failure is swallowed
   * and audited, because losing a history entry is not a reason to lose the answer.
   */
  #recordTurns(sessionId, exchanges, dataClass) {
    if (!sessionId) return null
    try {
      for (const [role, content] of exchanges) {
        this.memory.appendTurn(sessionId, { role, content, dataClass })
      }
      return { sessionId }
    } catch (error) {
      this.ledger.record({
        category: 'memory',
        action: 'record_turn_failed',
        outcome: AUDIT_OUTCOMES.FAILURE,
        detail: { sessionId, code: error.code ?? 'unknown', message: error.message },
      })
      return { sessionId, recorded: false, reason: error.message }
    }
  }

  /**
   * Assemble the request: prompt, retrieved evidence, remembered items, and the
   * classification of the result.
   *
   * This is shared by chat() and streamChat() because it was NOT shared before, and the
   * two copies had drifted: both decided egress from the user's question alone, so a
   * public question that retrieved a confidential chunk was sent externally. Fixing that
   * in only one path would have left the other open, which is the argument for one
   * implementation rather than two.
   *
   * @returns {{workingMessages:Array, classification:object, allowExternal:boolean,
   *            grounding:object|null, memory:object|null}}
   */
  #assembleChatContext({ normalized, userText, dataClass, principal, useKnowledge, useMemory, purpose }) {
    const declared = dataClass ? { dataClass, reason: 'explicitly declared', signals: [] } : classifyText(userText)

    let grounding = null
    let workingMessages = normalized
    if (useKnowledge && this.knowledge) {
      grounding = this.knowledge.buildGroundedContext({ query: userText, principal, topK: 6 })
      if (grounding.hasEvidence) {
        workingMessages = [{ role: 'system', content: grounding.promptContext }, ...workingMessages]
      }
    }

    // Memory augmentation: only user-approved memories, never a pending candidate.
    let memory = null
    if (useMemory && this.memory) {
      memory = this.memory.buildContext(userText)
      if (memory.hasMemories) {
        workingMessages = [{ role: 'system', content: memory.promptContext }, ...workingMessages]
      }
    }

    // The classification of the REQUEST is the most sensitive thing in it. Text added to
    // a prompt raises the class of what would be sent, so egress is decided on the
    // assembled content rather than on how the turn started.
    const effectiveClass = mostSensitiveDataClass(
      declared.dataClass,
      grounding?.dataClass ?? null,
      ...(memory?.memories ?? []).map((m) => m.dataClass),
    )
    const classification = effectiveClass === declared.dataClass
      ? declared
      : {
          dataClass: effectiveClass,
          reason: `raised by injected context (declared: ${declared.dataClass})`,
          signals: [
            ...(grounding?.dataClass
              && mostSensitiveDataClass(declared.dataClass, grounding.dataClass) === grounding.dataClass
              ? [`retrieved evidence is ${grounding.dataClass}`] : []),
            ...(memory?.memories ?? []).filter((m) => m.dataClass !== declared.dataClass)
              .map((m) => `remembered item is ${m.dataClass}`),
          ],
        }

    const allowExternal = this.#mayGoExternal({
      id: purpose, prompt: userText, dataClass: classification.dataClass, context: {},
    })
    return { workingMessages, classification, allowExternal, grounding, memory }
  }

  async chat({ messages, prompt = null, model = null, temperature = 0.2, maxTokens = 1024, stream = false, principal = null, dataClass = null, useKnowledge = false, useMemory = false, sessionId = null, signal = null }) {
    const normalized = messages ? normalizeMessages(messages) : [{ role: 'user', content: String(prompt ?? '') }]
    const userText = normalized.filter((message) => message.role === 'user').map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')

    const { workingMessages, classification, allowExternal, grounding, memory } = this.#assembleChatContext({
      normalized, userText, dataClass, principal, useKnowledge, useMemory, purpose: 'chat',
    })
    // The user's turn is recorded before the model is called, so a failed generation
    // still leaves the question in the history rather than a conversation with a hole.
    if (sessionId) this.#recordTurns(sessionId, [['user', userText]], classification.dataClass)

    const route = this.router.route(
      { capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT], ...(stream ? { streaming: true } : {}), ...(model ? { preferId: model } : {}) },
      { policy: this.config.policy, allowExternal },
    )
    if (!route.satisfied) {
      this.ledger.record({ category: 'model', action: 'chat_route_failed', outcome: AUDIT_OUTCOMES.FAILURE, detail: { explanation: route.explanation, dataClass: classification.dataClass } })
      const error = new Error(route.explanation)
      error.code = 'no_model_available'
      error.status = 503
      error.route = { explanation: route.explanation, rejected: route.rejected }
      throw error
    }

    const chosen = route.chosen
    const isExternal = chosen.location === 'online'

    // Minimise transmitted data: redact secrets before an external send.
    let outbound = workingMessages
    let redaction = null
    if (isExternal) {
      const result = redactDeep(workingMessages)
      outbound = result.value
      redaction = result.findings.length ? { findings: result.findings, applied: true } : null
      if (redaction) {
        this.ledger.record({ category: 'policy', action: 'redact_before_external', outcome: AUDIT_OUTCOMES.ALLOWED, detail: { findings: redaction.findings, modelId: chosen.id } })
      }
    }

    const started = Date.now()
    try {
      if (stream) {
        const provider = this.#providerFor(chosen)
        const request = { model: this.#providerModelId(chosen), messages: outbound, temperature, maxTokens, signal }
        const chunks = []
        for await (const delta of provider.chatStream(request)) chunks.push(delta)
        const text = chunks.join('')
        const durationMs = Date.now() - started
        this.#recordChat({ chosen, classification, isExternal, durationMs, textLength: text.length, stream: true, grounding, redaction })
        if (sessionId) this.#recordTurns(sessionId, [['assistant', text]], classification.dataClass)
        return { text, stream: true, chunks: chunks.length, modelId: chosen.id, durationMs, routing: routeSummary(route), classification: classification.dataClass, sentExternally: isExternal, grounding: groundingSummary(grounding), memory: memorySummary(memory), redaction }
      }

      const provider = this.#providerFor(chosen)
      const result = await provider.chat({ model: this.#providerModelId(chosen), messages: outbound, temperature, maxTokens, signal })
      const durationMs = Date.now() - started
      this.registry.observe(chosen.id, { availability: AVAILABILITY.READY, medianLatencyMs: durationMs })
      this.#recordChat({ chosen, classification, isExternal, durationMs, textLength: result.text.length, stream: false, grounding, redaction, usage: result.usage })
      if (sessionId) this.#recordTurns(sessionId, [['assistant', result.text]], classification.dataClass)
      return {
        text: result.text,
        toolCalls: result.toolCalls ?? [],
        stream: false,
        modelId: chosen.id,
        providerModel: result.model ?? null,
        durationMs,
        usage: result.usage ?? null,
        routing: routeSummary(route),
        classification: classification.dataClass,
        memory: memorySummary(memory),
        sentExternally: isExternal,
        grounding: groundingSummary(grounding),
        redaction,
      }
    } catch (error) {
      this.ledger.record({
        category: 'model',
        action: 'chat_failed',
        outcome: AUDIT_OUTCOMES.FAILURE,
        detail: { modelId: chosen.id, code: error?.code, status: error?.status, message: error?.message, retryAfterMs: error?.retryAfterMs ?? null },
      })
      if (error?.code === 'EGRESS_BLOCKED') {
        // strict_offline must surface as a clear capability error, not a silent fallback.
        const blocked = new Error(`offline mode: cannot reach '${chosen.id}' — ${error.message}`)
        blocked.code = 'offline_capability_unavailable'
        blocked.status = 503
        throw blocked
      }
      throw error
    }
  }

  /**
   * Record a capability refusal in the audit ledger, then throw it.
   *
   * A refusal is a decision the system made, so it is auditable in the same way a
   * successful call is. Without this the ledger only ever showed work that
   * happened, and an operator could not answer "what did we refuse, and why".
   */
  #refuse(category, action, error, detail = {}) {
    try {
      this.ledger.record({
        category,
        action,
        outcome: AUDIT_OUTCOMES.FAILURE,
        detail: { code: error?.code ?? null, message: error?.message ?? String(error), ...detail },
      })
    } catch {
      // Auditing must never turn a clean refusal into a 500.
    }
    throw error
  }

  #recordChat({ chosen, classification, isExternal, durationMs, textLength, stream, grounding, redaction, usage = null }) {
    this.ledger.record({
      category: 'model',
      action: stream ? 'chat_stream' : 'chat',
      outcome: AUDIT_OUTCOMES.SUCCESS,
      detail: {
        modelId: chosen.id,
        location: chosen.location,
        sentExternally: isExternal,
        dataClass: classification.dataClass,
        durationMs,
        responseChars: textLength,
        grounded: Boolean(grounding?.hasEvidence),
        citations: grounding?.citations?.length ?? 0,
        redacted: redaction?.findings ?? null,
        usage,
      },
    })
  }

  #providerFor(model) {
    const key = model.location === 'online' ? 'freellmapi' : model.id.startsWith('ollama:') ? 'ollama' : 'llamacpp'
    const provider = this.providers[key]
    if (!provider) {
      const error = new Error(`no provider is configured for model '${model.id}' (expected '${key}')`)
      error.code = 'provider_not_configured'
      error.status = 503
      throw error
    }
    return provider
  }

  #providerModelId(model) {
    if (model.location === 'online') return model.id === 'freellmapi:auto' ? undefined : model.id.split(':').slice(1).join(':') || undefined
    return model.id.split(':').slice(1).join(':')
  }

  /** Image generation. Returns a job; the artifact exists only after validation. */
  async generateImage({ prompt, model = null, n = 1, size = null, principal = null, dataClass = null, externalAuthorization = null }) {
    if (!prompt || !String(prompt).trim()) throw badRequest('prompt is required')
    const classification = dataClass ? { dataClass } : classifyText(String(prompt))
    const allowExternal = this.#mayGoExternal({ id: 'image', prompt: String(prompt), dataClass: classification.dataClass, context: { externalAuthorization } })

    const route = this.router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.IMAGE_OUT], ...(model ? { preferId: model } : {}) }, { policy: this.config.policy, allowExternal })
    if (!route.satisfied) {
      const error = new Error(`image generation unavailable: ${route.explanation}`)
      error.code = 'capability_unavailable'
      error.status = 503
      error.route = { explanation: route.explanation, rejected: route.rejected }
      return this.#refuse('model', 'image_refused', error, { policy: this.config.policy, rejected: route.rejected.length })
    }
    const chosen = route.chosen
    if (chosen.location !== 'online') {
      const error = new Error(`local image generation is not implemented for '${chosen.id}' in this build`)
      error.code = 'not_implemented'
      error.status = 501
      return this.#refuse('model', 'image_refused', error, { modelId: chosen.id })
    }
    const provider = this.providers.freellmapi
    if (!provider) throw providerMissing('freellmapi')

    return this.media.enqueue({
      kind: MEDIA_KINDS.IMAGE,
      params: { prompt: String(prompt).slice(0, 500), n, size, modelId: chosen.id },
      subject: principal,
      timeoutMs: this.config.media.imageTimeoutMs,
      run: async ({ signal, progress }) => {
        progress(10, 'submitting')
        const result = await provider.generateImage({ prompt: String(prompt), model: this.#providerModelId(chosen), n, size, signal, timeoutMs: this.config.media.imageTimeoutMs })
        progress(80, 'downloading')
        // If the provider returned URLs rather than b64, fetch them through the guard.
        if (!result.images.some((entry) => typeof entry.b64_json === 'string') && result.images[0]?.url) {
          const response = await this.guard.fetch(result.images[0].url, { signal })
          if (!response.ok) throw new Error(`image download failed with HTTP ${response.status}`)
          const buffer = Buffer.from(await response.arrayBuffer())
          return { bytes: new Uint8Array(buffer), contentType: response.headers.get('content-type'), platform: result.platform, model: result.model }
        }
        return result
      },
    })
  }

  /**
   * Video generation. Enqueues a real job whose cancellation aborts the gateway
   * request, which in turn stops the provider-side poll.
   */
  async generateVideo({ prompt, model = null, duration = null, aspectRatio = null, image = null, seed = null, audio = null, principal = null, dataClass = null, externalAuthorization = null }) {
    if (!prompt || !String(prompt).trim()) throw badRequest('prompt is required')
    const classification = dataClass ? { dataClass } : classifyText(String(prompt))
    const allowExternal = this.#mayGoExternal({ id: 'video', prompt: String(prompt), dataClass: classification.dataClass, context: { externalAuthorization } })

    const route = this.router.route({ capabilities: [MODALITIES.TEXT_IN, MODALITIES.VIDEO_OUT], ...(model ? { preferId: model } : {}) }, { policy: this.config.policy, allowExternal })
    if (!route.satisfied) {
      const error = new Error(`video generation unavailable: ${route.explanation}`)
      error.code = 'capability_unavailable'
      error.status = 503
      error.route = { explanation: route.explanation, rejected: route.rejected }
      // State the limitation instead of silently substituting an image (§9).
      error.limitation = 'no video-capable provider is reachable under the current policy; a still image is NOT offered as a substitute'
      return this.#refuse('model', 'video_refused', error, { policy: this.config.policy, rejected: route.rejected.length })
    }
    const chosen = route.chosen
    if (chosen.location !== 'online') {
      const error = new Error(`local video generation is not available: '${chosen.id}' has no implemented runtime on this hardware profile (${this.hardware.ramGb}GB RAM, no GPU)`)
      error.code = 'needs_hardware'
      error.status = 501
      return this.#refuse('model', 'video_refused', error, { modelId: chosen.id, hardware: this.hardware })
    }
    const provider = this.providers.freellmapi
    if (!provider) throw providerMissing('freellmapi')

    return this.media.enqueue({
      kind: MEDIA_KINDS.VIDEO,
      params: { prompt: String(prompt).slice(0, 500), duration, aspectRatio, seed, audio, modelId: chosen.id, providerLimitations: chosen.tags },
      subject: principal,
      timeoutMs: this.config.media.videoTimeoutMs,
      run: async ({ signal, progress }) => {
        progress(5, 'submitted to gateway')
        // The gateway holds one bounded request; we cannot observe its internal poll,
        // so progress is reported honestly as elapsed-time based, not fabricated.
        const startedAt = Date.now()
        const ticker = setInterval(() => {
          const elapsed = Date.now() - startedAt
          const estimate = Math.min(90, Math.round((elapsed / this.config.media.videoTimeoutMs) * 100) + 5)
          progress(estimate, `awaiting provider (${Math.round(elapsed / 1000)}s elapsed)`)
        }, 2000)
        try {
          const result = await provider.generateVideo({ prompt: String(prompt), model: this.#providerModelId(chosen), duration, aspectRatio, image, seed, audio, signal, timeoutMs: this.config.media.videoTimeoutMs })
          progress(95, 'validating mp4')
          return result
        } finally {
          clearInterval(ticker)
        }
      },
    })
  }

  /** Readiness: what actually works right now, with reasons for what does not. */
  readiness() {
    const models = this.registry.list()
    const ready = models.filter((model) => model.measured.availability === AVAILABILITY.READY)
    return {
      status: ready.length ? 'ready' : 'degraded',
      policy: this.config.policy,
      offlineEnforced: this.guard.offlineEnforced,
      hardware: this.hardware,
      models: { total: models.length, ready: ready.length },
      capabilities: {
        chat: ready.some((model) => model.capabilities.includes(MODALITIES.TEXT_OUT)),
        embeddings: ready.some((model) => model.capabilities.includes(MODALITIES.EMBEDDING_OUT)),
        imageGeneration: ready.some((model) => model.capabilities.includes(MODALITIES.IMAGE_OUT)),
        videoGeneration: ready.some((model) => model.capabilities.includes(MODALITIES.VIDEO_OUT)),
        knowledge: this.knowledge.stats().store.documents > 0,
      },
      providers: Object.fromEntries(
        Object.entries(this.providers).map(([name, provider]) => [name, { configured: true, safe: provider.safeDescriptor ? provider.safeDescriptor() : { provider: name } }]),
      ),
      warnings: this.config.warnings,
      // Never claim a capability the probes did not confirm.
      notReady: models.filter((model) => model.measured.availability !== AVAILABILITY.READY).map((model) => ({ id: model.id, availability: model.measured.availability, detail: model.measured.probeDetail })),
    }
  }

  /** Serve a stored artifact, refusing path escape. */
  async readArtifact(jobId) {
    const job = this.media.get(jobId)
    if (job.state !== JOB_STATES.SUCCEEDED || !job.artifact) {
      const error = new Error(`job '${jobId}' has no completed artifact (state=${job.state})`)
      error.code = 'artifact_not_ready'
      error.status = 409
      throw error
    }
    const { bytes, artifact } = await this.media.readArtifact(jobId)
    return { bytes, artifact, job }
  }

  /**
   * Stream a chat completion as SSE. Lives on the class because it needs the
   * private policy/routing helpers; the HTTP layer only hands it a response.
   */
  async streamChat(response, body, writeHead, write, end) {
    const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    try {
      const normalized = body.messages ? normalizeMessages(body.messages) : [{ role: 'user', content: String(body.prompt ?? '') }]
      const userText = normalized
        .filter((message) => message.role === 'user')
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n')
      const { workingMessages, classification, allowExternal, grounding, memory } = this.#assembleChatContext({
        normalized,
        userText,
        dataClass: body.dataClass ?? null,
        principal: body.principal ?? null,
        useKnowledge: body.useKnowledge === true,
        useMemory: body.useMemory === true,
        purpose: 'chat-stream',
      })

      const route = this.router.route(
        {
          capabilities: [MODALITIES.TEXT_IN, MODALITIES.TEXT_OUT],
          streaming: true,
          ...(body.model ? { preferId: body.model } : {}),
        },
        { policy: this.config.policy, allowExternal },
      )
      if (!route.satisfied) {
        send('error', { code: 'no_model_available', message: route.explanation, rejected: route.rejected })
        return end()
      }

      let outbound = workingMessages
      const isExternal = route.chosen.location === 'online'
      if (isExternal) {
        const redacted = redactDeep(workingMessages)
        outbound = redacted.value
        if (redacted.findings.length) {
          send('redaction', { findings: redacted.findings })
          this.ledger.record({ category: 'policy', action: 'redact_before_external', outcome: AUDIT_OUTCOMES.ALLOWED, detail: { findings: redacted.findings, modelId: route.chosen.id } })
        }
      }

      writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      send('route', {
        modelId: route.modelId,
        routing: routeSummary(route),
        dataClass: classification.dataClass,
        sentExternally: isExternal,
        grounding: groundingSummary(grounding),
        memory: memorySummary(memory),
      })

      const provider = this.#providerFor(route.chosen)
      const started = Date.now()
      let chunks = 0
      let chars = 0
      for await (const delta of provider.chatStream({
        model: this.#providerModelId(route.chosen),
        messages: outbound,
        temperature: body.temperature ?? 0.2,
        maxTokens: body.maxTokens ?? 1024,
      })) {
        chunks += 1
        chars += delta.length
        send('delta', { text: delta })
      }
      const durationMs = Date.now() - started
      send('done', { modelId: route.modelId, chunks, chars, durationMs })
      this.registry.observe(route.chosen.id, { availability: AVAILABILITY.READY, medianLatencyMs: durationMs })
      this.ledger.record({
        category: 'model',
        action: 'chat_stream',
        outcome: AUDIT_OUTCOMES.SUCCESS,
        detail: { modelId: route.modelId, chunks, chars, durationMs, sentExternally: isExternal, dataClass: classification.dataClass, grounded: Boolean(grounding?.hasEvidence) },
      })
    } catch (error) {
      send('error', { code: error?.code ?? 'stream_failed', message: error?.message ?? String(error) })
      this.ledger.record({ category: 'model', action: 'chat_stream', outcome: AUDIT_OUTCOMES.FAILURE, detail: { error: error?.message, code: error?.code } })
    }
    return end()
  }

  close() {
    try {
      this.restoreGlobalFetch?.()
    } catch {
      /* ignore */
    }
    this.knowledge?.close()
    this.ledger?.close()
  }
}

// --- HTTP layer -----------------------------------------------------------

/**
 * Map a domain error to an HTTP status.
 *
 * Domain modules (MCP, plugins, knowledge) throw errors that carry a stable
 * `code` and know nothing about HTTP — that translation belongs here. Without it
 * every unrecognised error fell through to 500, which wrongly reported client
 * mistakes (an unknown server, invalid arguments, a denied permission) as server
 * faults. An explicit `error.status` always wins over this table.
 */
const ERROR_STATUS = Object.freeze({
  // The client named something that does not exist.
  unknown_server: 404,
  unknown_tool: 404,
  unknown_prompt: 404,
  unknown_resource: 404,
  unknown_task: 404,
  unknown_document: 404,
  unknown_job: 404,
  unknown_plugin: 404,
  not_found: 404,
  artifact_not_found: 404,

  // The request itself was wrong.
  invalid_arguments: 400,
  invalid_output: 400,
  invalid_manifest: 400,
  invalid_request: 400,
  validation_error: 400,
  ingestion_rejected: 400,
  body_too_large: 413,
  // Cancellation is client-initiated, so it is not a server fault.
  cancelled: 400,

  // Refused on policy grounds.
  permission_denied: 403,
  plugin_permission_denied: 403,
  acl_denied: 403,
  unauthorized: 401,
  egress_blocked: 403,
  EGRESS_BLOCKED: 403,
  policy_denied: 403,
  retention_denied: 403,

  // Needs a decision or a resource before it can proceed.
  approval_required: 409,
  already_running: 409,
  conflict: 409,
  rate_limited: 429,

  // Genuinely server-side.
  timeout: 504,
  not_implemented: 501,
  capability_unavailable: 503,
  no_model_available: 503,
  offline_capability_unavailable: 503,
  provider_unreachable: 502,
})

function statusForError(error) {
  if (!error) return 500
  if (Number.isInteger(error.status)) return error.status
  const mapped = ERROR_STATUS[error.code]
  if (mapped) return mapped
  // EgressBlockedError carries code 'EGRESS_BLOCKED' in upper case.
  if (error.name === 'EgressBlockedError') return 403
  return 500
}

export function createHttpServer(app) {
  return createServer(async (request, response) => {
    const started = Date.now()
    try {
      await handle(request, response, app)
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error?.status ?? statusForError(error), {
          error: error?.code ?? 'internal_error',
          message: error?.message ?? 'internal error',
          ...(error?.route ? { route: error.route } : {}),
          ...(error?.limitation ? { limitation: error.limitation } : {}),
          ...(error?.errors ? { details: error.errors } : {}),
        }, app)
      } else {
        try {
          response.end()
        } catch {
          /* socket already gone */
        }
      }
    } finally {
      app.onHttpRequest({ method: request.method, url: request.url, ms: Date.now() - started, status: response.statusCode ?? 0 })
    }
  })
}

async function handle(request, response, app) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(app, { 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' }))
    return response.end()
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = request.method ?? 'GET'
  const segments = path.split('/').filter(Boolean)

  // --- system -------------------------------------------------------------
  if (method === 'GET' && path === '/api/health') return sendJson(response, 200, { status: 'ok', uptimeMs: Date.now() - app.startedAt, policy: app.config.policy }, app)
  if (method === 'GET' && path === '/api/ready') return sendJson(response, 200, app.readiness(), app)
  if (method === 'GET' && path === '/api/config') return sendJson(response, 200, publicConfig(app.config), app)
  if (method === 'GET' && path === '/api/hardware') return sendJson(response, 200, app.hardware, app)
  if (method === 'GET' && path === '/api/events') return sendJson(response, 200, { events: app.events.slice(-200) }, app)

  // --- models -------------------------------------------------------------
  if (method === 'GET' && path === '/api/models') {
    const availableOnly = url.searchParams.get('ready') === 'true'
    return sendJson(response, 200, {
      models: app.registry.list({ availableOnly }).map(publicModel),
      // The declared family, with its validation result. Served alongside the routable
      // models because they answer different questions: `models` is what can serve a
      // request now, `family` is what Aetheris has built and what backs each claim.
      family: app.modelFamily,
      hardware: app.hardware,
    }, app)
  }
  if (method === 'POST' && path === '/api/models/probe') return sendJson(response, 200, await app.probeAll(), app)

  // --- chat ---------------------------------------------------------------
  if (method === 'POST' && path === '/api/chat') {
    const body = await readBody(request)
    const result = await app.chat({ ...body, stream: false })
    return sendJson(response, 200, result, app)
  }
  if (method === 'POST' && path === '/api/chat/stream') {
    const body = await readBody(request)
    return app.streamChat(
      response,
      body,
      (status, headers) => response.writeHead(status, corsHeaders(app, headers)),
      (chunk) => response.write(chunk),
      () => response.end(),
    )
  }

  // --- memory -------------------------------------------------------------
  // The surface for the things a user asked to be remembered, and for searching their
  // own past conversations. Both live inside the five areas -- memory is a control in
  // Chat, not a sixth destination.
  if (method === 'GET' && path === '/api/memory') {
    return sendJson(response, 200, {
      memories: app.memory.listMemories({ limit: Number(url.searchParams.get('limit') ?? 200) }),
      candidates: app.memory.listCandidates({ status: CANDIDATE_STATES.PENDING }),
      stats: app.memory.stats(),
    }, app)
  }
  if (method === 'POST' && path === '/api/memory') {
    // Remembering is a user action, so this route is the user's hand. There is no body
    // field that makes it an agent's: the store's approver is a constant, enforced by a
    // database CHECK.
    return sendJson(response, 201, app.memory.remember(await readBody(request)), app)
  }
  if (method === 'GET' && segments[1] === 'memory' && segments[2] === 'search') {
    const query = url.searchParams.get('q') ?? ''
    return sendJson(response, 200, { query, results: app.memory.searchMemories(query, { topK: Number(url.searchParams.get('limit') ?? 10) }) }, app)
  }
  if (method === 'POST' && segments[1] === 'memory' && segments[2] === 'candidates' && segments.length === 3) {
    // Exactly three segments: without the length check this route also matched
    // /api/memory/candidates/<id>/decide and proposed a candidate instead of deciding
    // one, which is how the decide endpoint returned 'pending' for an approval.
    return sendJson(response, 201, app.memory.propose(await readBody(request)), app)
  }
  if (method === 'POST' && segments[1] === 'memory' && segments[2] === 'candidates' && segments[3] && segments[4] === 'decide') {
    const body = await readBody(request)
    return sendJson(response, 200, app.memory.decideCandidate(segments[3], { approve: body.approve === true, kind: body.kind, subject: body.subject ?? null, tags: body.tags }), app)
  }
  if (method === 'DELETE' && segments[1] === 'memory' && segments[2] === 'forget-all') {
    return sendJson(response, 200, app.memory.forgetAll(await readBody(request)), app)
  }
  if (method === 'PATCH' && segments[1] === 'memory' && segments[2]) {
    return sendJson(response, 200, app.memory.updateMemory(segments[2], await readBody(request)), app)
  }
  if (method === 'DELETE' && segments[1] === 'memory' && segments[2]) {
    // readBody, not a fetch-style request.text(): this is a Node request, and readBody
    // already maps an absent body to {} rather than throwing.
    const body = await readBody(request)
    return sendJson(response, 200, app.memory.forget(segments[2], { reason: body.reason ?? null, requestedBy: 'user' }), app)
  }

  // --- session recall -----------------------------------------------------
  if (method === 'POST' && path === '/api/sessions') {
    const body = await readBody(request)
    return sendJson(response, 201, app.memory.startSession({ title: body.title ?? null }), app)
  }
  if (method === 'GET' && path === '/api/sessions') {
    return sendJson(response, 200, { sessions: app.memory.listSessions({ limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)
  }
  if (method === 'GET' && segments[1] === 'sessions' && segments[2] === 'recall') {
    const query = url.searchParams.get('q') ?? ''
    return sendJson(response, 200, app.memory.recall(query, { topK: Number(url.searchParams.get('limit') ?? 10) }), app)
  }
  if (method === 'GET' && segments[1] === 'sessions' && segments[2]) {
    const session = app.memory.getSession(segments[2])
    if (!session) {
      const error = new Error(`no session '${segments[2]}'`)
      error.code = 'not_found'
      error.status = 404
      throw error
    }
    return sendJson(response, 200, session, app)
  }
  if (method === 'DELETE' && segments[1] === 'sessions' && segments[2]) {
    return sendJson(response, 200, app.memory.deleteSession(segments[2]), app)
  }

  // --- tasks (God Core) ---------------------------------------------------
  if (method === 'POST' && path === '/api/tasks') {
    const body = await readBody(request)
    const task = app.godCore.submit(body)
    if (body.run !== false) {
      const finished = await app.godCore.run(task.id, body.handlers ?? {})
      return sendJson(response, 200, finished, app)
    }
    return sendJson(response, 201, task, app)
  }
  if (method === 'GET' && path === '/api/tasks') return sendJson(response, 200, { tasks: app.godCore.list({ state: url.searchParams.get('state'), limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)
  if (method === 'GET' && segments[1] === 'tasks' && segments[2]) return sendJson(response, 200, app.godCore.get(segments[2]), app)
  if (method === 'POST' && segments[1] === 'tasks' && segments[2] && segments[3]) {
    const taskId = segments[2]
    const action = segments[3]
    // pause/cancel return an action summary while resume/approve return the task
    // view. Clients should not have to know which is which, so every lifecycle
    // response carries the authoritative view under `task`.
    const respond = (result) => sendJson(response, 200, { ...result, task: app.godCore.get(taskId) }, app)
    if (action === 'pause') return respond(app.godCore.pause(taskId, (await readBody(request)).reason))
    if (action === 'resume') return respond(await app.godCore.resume(taskId))
    if (action === 'cancel') return respond(app.godCore.cancel(taskId, (await readBody(request)).reason))
    if (action === 'approve') return respond(await app.godCore.approve(taskId, await readBody(request)))
  }

  // --- image --------------------------------------------------------------
  if (method === 'POST' && path === '/api/image/generate') return sendJson(response, 202, await app.generateImage(await readBody(request)), app)
  if (method === 'GET' && path === '/api/image/jobs') return sendJson(response, 200, { jobs: app.media.list({ kind: MEDIA_KINDS.IMAGE, limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)

  // --- video --------------------------------------------------------------
  if (method === 'POST' && path === '/api/video/generate') return sendJson(response, 202, await app.generateVideo(await readBody(request)), app)
  if (method === 'GET' && path === '/api/video/jobs') return sendJson(response, 200, { jobs: app.media.list({ kind: MEDIA_KINDS.VIDEO, limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)

  // --- media jobs (shared) ------------------------------------------------
  if (method === 'GET' && segments[1] === 'media' && segments[2] === 'jobs') {
    if (segments[3]) return sendJson(response, 200, app.media.get(segments[3]), app)
    return sendJson(response, 200, { jobs: app.media.list({ limit: Number(url.searchParams.get('limit') ?? 50) }) }, app)
  }
  if (method === 'POST' && segments[1] === 'media' && segments[2] === 'jobs' && segments[3] && segments[4] === 'cancel') {
    const body = await readBody(request)
    return sendJson(response, 200, app.media.cancel(segments[3], body.reason), app)
  }
  if (method === 'GET' && segments[1] === 'media' && segments[2] === 'artifact' && segments[3]) {
    const { bytes, artifact } = await app.readArtifact(segments[3])
    response.writeHead(200, corsHeaders(app, {
      'content-type': artifact.mime ?? 'application/octet-stream',
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-aetheris-sha256': artifact.sha256,
      'x-aetheris-validated': 'true',
    }))
    return response.end(Buffer.from(bytes))
  }
  if (method === 'DELETE' && segments[1] === 'media' && segments[2] === 'jobs' && segments[3]) {
    return sendJson(response, 200, await app.media.deleteArtifact(segments[3]), app)
  }

  // --- knowledge ----------------------------------------------------------
  if (method === 'POST' && path === '/api/knowledge/ingest') return sendJson(response, 201, await app.knowledge.ingestText(await readBody(request)), app)
  if (method === 'POST' && path === '/api/knowledge/search') return sendJson(response, 200, app.knowledge.search(await readBody(request)), app)
  if (method === 'POST' && path === '/api/knowledge/reindex') return sendJson(response, 200, app.knowledge.rebuildIndex(), app)
  if (method === 'GET' && path === '/api/knowledge/stats') return sendJson(response, 200, app.knowledge.stats(), app)
  if (method === 'GET' && path === '/api/knowledge/documents') return sendJson(response, 200, { documents: app.knowledge.store.listDocuments({}) }, app)
  if (method === 'DELETE' && segments[1] === 'knowledge' && segments[2] === 'documents' && segments[3]) {
    const body = url.searchParams.get('reason') ? { reason: url.searchParams.get('reason') } : {}
    return sendJson(response, 200, app.knowledge.purgeDocument(segments[3], body), app)
  }

  // --- plugins ------------------------------------------------------------
  if (method === 'GET' && path === '/api/plugins') {
    // The UI needs to tell an enabled plugin from a disabled or uninstalled one,
    // so the filters the registry already supports are exposed here.
    return sendJson(
      response,
      200,
      {
        plugins: app.plugins.list({
          state: url.searchParams.get('state'),
          protocol: url.searchParams.get('protocol'),
        }),
      },
      app,
    )
  }
  if (method === 'GET' && path === '/api/plugins/capabilities') return sendJson(response, 200, { capabilities: app.plugins.capabilities() }, app)
  if (method === 'POST' && path === '/api/plugins/validate') {
    try {
      return sendJson(response, 200, { valid: true, ...validateManifest(await readBody(request)) }, app)
    } catch (error) {
      return sendJson(response, 400, { valid: false, error: error.message, details: error.errors ?? [] }, app)
    }
  }
  if (method === 'POST' && path === '/api/plugins/discover') return sendJson(response, 200, app.plugins.discover(await readBody(request)), app)
  if (method === 'POST' && path === '/api/plugins/install') return sendJson(response, 201, app.plugins.install(await readBody(request)), app)
  if (method === 'POST' && segments[1] === 'plugins' && segments[2] && segments[3]) {
    const action = segments[3]
    const body = await readBody(request)
    if (action === 'enable') return sendJson(response, 200, app.plugins.enable(segments[2]), app)
    if (action === 'disable') return sendJson(response, 200, app.plugins.disable(segments[2]), app)
    if (action === 'uninstall') return sendJson(response, 200, app.plugins.uninstall(segments[2]), app)
    if (action === 'preflight') return sendJson(response, 200, app.plugins.preflight(segments[2], body.capability, body), app)
    if (action === 'invoke') return sendJson(response, 200, await app.plugins.invoke(segments[2], body.capability, body.input ?? {}, body), app)
  }

  // --- MCP ----------------------------------------------------------------
  if (method === 'GET' && path === '/api/mcp/servers') return sendJson(response, 200, { servers: app.mcp.listServers() }, app)
  if (method === 'GET' && path === '/api/mcp/tools') {
    return sendJson(response, 200, { tools: app.mcp.listTools({ serverId: url.searchParams.get('server'), risk: url.searchParams.get('risk'), query: url.searchParams.get('q') }) }, app)
  }
  if (method === 'GET' && path === '/api/mcp/resources') return sendJson(response, 200, { resources: app.mcp.listResources({ serverId: url.searchParams.get('server') }) }, app)
  if (method === 'GET' && path === '/api/mcp/prompts') return sendJson(response, 200, { prompts: app.mcp.listPrompts({ serverId: url.searchParams.get('server') }) }, app)
  if (method === 'POST' && path === '/api/mcp/preflight') {
    const body = await readBody(request)
    return sendJson(response, 200, app.mcp.preflight(body.server, body.tool, body), app)
  }
  if (method === 'POST' && path === '/api/mcp/call') {
    const body = await readBody(request)
    return sendJson(response, 200, await app.mcp.callTool(body.server, body.tool, body.arguments ?? {}, body), app)
  }
  if (method === 'POST' && segments[1] === 'mcp' && segments[2] === 'servers' && segments[3] && segments[4] === 'toggle') {
    const body = await readBody(request)
    return sendJson(response, 200, app.mcp.setEnabled(segments[3], Boolean(body.enabled)), app)
  }

  // --- audit --------------------------------------------------------------
  if (method === 'GET' && path === '/api/audit') {
    return sendJson(response, 200, {
      events: app.ledger.query({ limit: Number(url.searchParams.get('limit') ?? 50), category: url.searchParams.get('category') ?? '', beforeSeq: Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER) }),
      count: app.ledger.count(url.searchParams.get('category') ?? null),
    }, app)
  }

  return sendJson(response, 404, { error: 'not_found', message: `no route for ${method} ${path}` }, app)
}

function publicModel(model) {
  return {
    id: model.id,
    kind: model.kind,
    displayName: model.displayName,
    capabilities: model.capabilities,
    location: model.location,
    provider: model.provider,
    contextWindow: model.contextWindow,
    toolCalling: model.toolCalling,
    structuredOutput: model.structuredOutput,
    streaming: model.streaming,
    quantization: model.quantization,
    licence: model.licence,
    parametersBillions: model.parametersBillions,
    minRamGb: model.minRamGb,
    minVramGb: model.minVramGb,
    aetherisLite: model.aetherisLite,
    // Derived, not declared: present only when this model id IS the artifact behind a
    // capability the tier actually provides. See klyvaron/tiers.mjs tierClaimFor().
    tier: tierClaimFor(model.id),
    version: model.version,
    tags: model.tags,
    measured: model.measured,
  }
}

function routeSummary(route) {
  return { modelId: route.modelId, explanation: route.explanation, candidates: route.candidates, rejected: route.rejected, policy: route.policy }
}

/**
 * What memory contributed, reported without quoting it.
 *
 * The reply says how many remembered items were used and at what classification, so a
 * user can see that memory was consulted and that it raised the sensitivity of the
 * request. It does not echo the memories, because they are already in the UI.
 */
function memorySummary(memory) {
  if (!memory) return null
  return {
    used: memory.hasMemories === true,
    count: memory.memories?.length ?? 0,
    matched: memory.matched ?? null,
    dataClasses: [...new Set((memory.memories ?? []).map((m) => m.dataClass))],
  }
}

function groundingSummary(grounding) {
  if (!grounding) return null
  return { method: grounding.method, hasEvidence: grounding.hasEvidence, evidenceCount: grounding.evidenceCount, citations: grounding.citations }
}

function corsHeaders(app, extra = {}) {
  const origin = app.config.allowedOrigin
  return {
    ...(origin ? { 'access-control-allow-origin': origin } : {}),
    'cache-control': 'no-store',
    ...extra,
  }
}

function sendJson(response, status, payload, app) {
  const body = JSON.stringify(payload)
  response.writeHead(status, corsHeaders(app, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) }))
  response.end(body)
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk)
      if (size > MAX_BODY_BYTES) {
        const error = new Error('request body exceeds the 4 MB limit')
        error.code = 'body_too_large'
        error.status = 413
        reject(error)
        request.destroy()
        return
      }
      body += chunk
    })
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {})
      } catch (error) {
        const wrapped = new Error(`invalid JSON body: ${error.message}`)
        wrapped.code = 'invalid_json'
        wrapped.status = 400
        reject(wrapped)
      }
    })
    request.on('error', reject)
  })
}

function badRequest(message) {
  const error = new Error(message)
  error.code = 'invalid_request'
  error.status = 400
  return error
}

function providerMissing(name) {
  const error = new Error(`provider '${name}' is not configured`)
  error.code = 'provider_not_configured'
  error.status = 503
  return error
}

function parseParameterSize(value) {
  if (!value) return null
  const match = /([\d.]+)\s*([BMK])/i.exec(String(value))
  if (!match) return null
  const n = Number(match[1])
  const unit = match[2].toUpperCase()
  if (unit === 'B') return n
  if (unit === 'M') return round(n / 1000, 3)
  return round(n / 1_000_000, 6)
}

function round(value, digits = 6) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

export { JOB_STATES, TASK_STATES, LIFECYCLE, validateMedia, join, sep, readFile, stat }
