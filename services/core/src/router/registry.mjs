// Capability metadata + capability-aware Model Router.
//
// Directive §4.C: routing must be capability-aware, not name-based, and every
// configured model must carry metadata for supported inputs/outputs, context
// limits, tool calling, structured output, quantization, licence, hardware
// requirements, latency and availability.
//
// The cost function is a direct descendant of sparsiz's real routing mathematics
// (`sparsiz/faisanth.py:184 edge_cost`, `:189 node_cost`):
//     C_ij = α·L_ij + β·E_ij + γ·T_ij + δ·B_ij⁻¹ + ε·R_ij
// sparsiz applied it to compute nodes; here it is applied to model candidates.
// The `random.uniform`-based scoring elsewhere in sparsiz is NOT reused
// (see docs/01-audit.md §2.2).

export const MODALITIES = Object.freeze({
  TEXT_IN: 'text_in',
  TEXT_OUT: 'text_out',
  IMAGE_IN: 'image_in',
  IMAGE_OUT: 'image_out',
  VIDEO_IN: 'video_in',
  VIDEO_OUT: 'video_out',
  AUDIO_IN: 'audio_in',
  AUDIO_OUT: 'audio_out',
  EMBEDDING_OUT: 'embedding_out',
  RERANK: 'rerank',
})

export const MODEL_KINDS = Object.freeze({
  LOCAL_LLM: 'local_llm',
  LOCAL_EMBEDDING: 'local_embedding',
  LOCAL_RERANKER: 'local_reranker',
  LOCAL_VISION: 'local_vision',
  LOCAL_IMAGE_GEN: 'local_image_gen',
  LOCAL_VIDEO_GEN: 'local_video_gen',
  ONLINE_LLM: 'online_llm',
  ONLINE_EMBEDDING: 'online_embedding',
  ONLINE_IMAGE_GEN: 'online_image_gen',
  ONLINE_VIDEO_GEN: 'online_video_gen',
  ONLINE_AUDIO: 'online_audio',
})

/** Availability is *measured*, never assumed. See providers/base.mjs probe(). */
export const AVAILABILITY = Object.freeze({
  READY: 'ready',
  NOT_INSTALLED: 'not_installed',
  UNREACHABLE: 'unreachable',
  NEEDS_CREDENTIALS: 'needs_credentials',
  NEEDS_HARDWARE: 'needs_hardware',
  DISABLED: 'disabled',
})

const REQUIRED_FIELDS = ['id', 'kind', 'displayName', 'capabilities', 'location']

/**
 * Validate a model descriptor. Throws on anything missing or malformed so a
 * half-configured model cannot silently enter the routing table.
 */
export function validateModelDescriptor(input) {
  for (const field of REQUIRED_FIELDS) {
    if (input?.[field] === undefined || input?.[field] === null) {
      throw new TypeError(`model descriptor missing required field '${field}'`)
    }
  }
  if (!Object.values(MODEL_KINDS).includes(input.kind)) throw new TypeError(`unknown model kind '${input.kind}'`)
  if (!['local', 'online'].includes(input.location)) throw new TypeError(`model location must be 'local' or 'online'`)
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new TypeError('model must declare at least one capability')
  }
  for (const cap of input.capabilities) {
    if (!Object.values(MODALITIES).includes(cap)) throw new TypeError(`unknown capability '${cap}' on model '${input.id}'`)
  }
  const ctx = input.contextWindow
  if (ctx !== undefined && (!Number.isInteger(ctx) || ctx <= 0)) {
    throw new TypeError(`contextWindow must be a positive integer for model '${input.id}'`)
  }
  if (input.location === 'online' && !input.provider) {
    throw new TypeError(`online model '${input.id}' must declare a provider`)
  }
  return {
    id: String(input.id),
    kind: input.kind,
    displayName: String(input.displayName),
    capabilities: [...new Set(input.capabilities)],
    location: input.location,
    provider: input.provider ?? null,
    contextWindow: ctx ?? null,
    toolCalling: Boolean(input.toolCalling),
    structuredOutput: Boolean(input.structuredOutput),
    streaming: Boolean(input.streaming),
    quantization: input.quantization ?? null,
    licence: input.licence ?? 'unknown',
    parametersBillions: Number.isFinite(input.parametersBillions) ? input.parametersBillions : null,
    minVramGb: Number.isFinite(input.minVramGb) ? input.minVramGb : 0,
    minRamGb: Number.isFinite(input.minRamGb) ? input.minRamGb : 0,
    // Observed, not advertised. Updated by probe()/latency sampling.
    measured: {
      availability: AVAILABILITY.NOT_INSTALLED,
      lastProbedAt: null,
      medianLatencyMs: Number.isFinite(input.medianLatencyMs) ? input.medianLatencyMs : null,
      tokensPerSecond: Number.isFinite(input.tokensPerSecond) ? input.tokensPerSecond : null,
      probeDetail: null,
    },
    // Lower is better; used as a tie-breaker when several models can do the job.
    costWeight: Number.isFinite(input.costWeight) ? input.costWeight : 1,
    tags: Array.isArray(input.tags) ? [...input.tags] : [],
    aetherisLite: Boolean(input.aetherisLite),
    version: input.version ?? null,
  }
}

/** Default routing weights. Tunable per deployment; recorded in every decision. */
export const DEFAULT_ROUTING_WEIGHTS = Object.freeze({
  capabilityFit: 0.4, // does it actually support every requested capability?
  privacy: 0.25, // local beats external
  latency: 0.15, // measured median latency
  resourceFit: 0.1, // does it fit the profiled hardware?
  quality: 0.1, // declared/measured quality tier
})

export class ModelRegistry {
  constructor({ weights = DEFAULT_ROUTING_WEIGHTS } = {}) {
    /** @type {Map<string, object>} */
    this.models = new Map()
    this.weights = { ...DEFAULT_ROUTING_WEIGHTS, ...weights }
  }

  register(descriptor) {
    const model = validateModelDescriptor(descriptor)
    if (this.models.has(model.id)) throw new Error(`model '${model.id}' is already registered`)
    this.models.set(model.id, model)
    return model
  }

  upsert(descriptor) {
    if (this.models.has(descriptor.id)) this.models.delete(descriptor.id)
    return this.register(descriptor)
  }

  unregister(id) {
    return this.models.delete(id)
  }

  get(id) {
    const model = this.models.get(id)
    if (!model) throw new Error(`unknown model '${id}'`)
    return model
  }

  has(id) {
    return this.models.has(id)
  }

  /** Record a measured availability/latency observation. Never fabricates readiness. */
  observe(id, observation) {
    const model = this.get(id)
    if (!Object.values(AVAILABILITY).includes(observation.availability)) {
      throw new TypeError(`unknown availability '${observation.availability}'`)
    }
    model.measured.availability = observation.availability
    model.measured.lastProbedAt = observation.at ?? Date.now()
    if (observation.detail !== undefined) model.measured.probeDetail = observation.detail
    if (Number.isFinite(observation.medianLatencyMs)) model.measured.medianLatencyMs = observation.medianLatencyMs
    if (Number.isFinite(observation.tokensPerSecond)) model.measured.tokensPerSecond = observation.tokensPerSecond
    return model.measured
  }

  list({ kind = null, location = null, availableOnly = false } = {}) {
    return [...this.models.values()].filter((model) => {
      if (kind && model.kind !== kind) return false
      if (location && model.location !== location) return false
      if (availableOnly && model.measured.availability !== AVAILABILITY.READY) return false
      return true
    })
  }

  /** Every model that could satisfy a capability request, ignoring availability. */
  candidates(request) {
    const needed = request.capabilities || []
    return this.list({ kind: request.kind ?? null, location: request.location ?? null }).filter((model) =>
      needed.every((capability) => model.capabilities.includes(capability)),
    )
  }
}

/**
 * The router. Given a capability request, a runtime policy and a hardware profile,
 * it returns an ordered list of usable candidates plus the reason each was
 * accepted or rejected. Rejection reasons are surfaced to the user verbatim —
 * an unavailable capability produces a clear error, never a silent substitute.
 */
export class ModelRouter {
  constructor({ registry, weights = DEFAULT_ROUTING_WEIGHTS, hardware = null }) {
    if (!registry) throw new TypeError('ModelRouter requires a registry')
    this.registry = registry
    this.weights = { ...DEFAULT_ROUTING_WEIGHTS, ...weights }
    this.hardware = hardware
  }

  /**
   * @param {object} request
   * @param {string[]} request.capabilities required MODALITIES
   * @param {string} [request.kind]         restrict to a MODEL_KINDS value
   * @param {boolean} [request.toolCalling] require tool calling
   * @param {boolean} [request.streaming]   require streaming
   * @param {number} [request.minContext]   required context window
   * @param {boolean} [request.localOnly]   forbid online candidates
   * @param {string} [request.preferId]     pin a specific model if able
   */
  route(request, { policy = 'strict_offline', allowExternal = false } = {}) {
    const needed = request.capabilities || []
    if (!needed.length) throw new TypeError('route() requires at least one capability')

    const all = this.registry.candidates({ capabilities: needed, kind: request.kind })
    const accepted = []
    const rejected = []

    for (const model of all) {
      const reason = this.#reject(model, request, { policy, allowExternal })
      if (reason) {
        rejected.push({ id: model.id, reason })
        continue
      }
      accepted.push({ model, score: this.#score(model, request) })
    }

    // A pinned model wins only if it survived the same gates.
    if (request.preferId) {
      const pinned = accepted.find((entry) => entry.model.id === request.preferId)
      if (pinned) {
        const rest = accepted.filter((entry) => entry !== pinned).sort((a, b) => b.score.total - a.score.total)
        return this.#decision([pinned, ...rest], rejected, request, policy)
      }
    }

    accepted.sort((a, b) => b.score.total - a.score.total)
    return this.#decision(accepted, rejected, request, policy)
  }

  #decision(accepted, rejected, request, policy) {
    const ranked = accepted.map((entry) => ({ ...entry.model, score: entry.score }))
    const chosen = ranked[0] ?? null
    return {
      chosen,
      modelId: chosen?.id ?? null,
      candidates: ranked.map((m) => ({ id: m.id, score: m.score.total, breakdown: m.score.breakdown })),
      rejected,
      request,
      policy,
      satisfied: Boolean(chosen),
      // Honest explanation when nothing can serve the request.
      explanation: chosen
        ? `selected '${chosen.id}' (${chosen.kind}, ${chosen.location})`
        : rejected.length
          ? `no model can satisfy [${request.capabilities.join(', ')}]: ${rejected.map((r) => `${r.id} — ${r.reason}`).join('; ')}`
          : `no registered model declares [${request.capabilities.join(', ')}]`,
    }
  }

  #reject(model, request, { policy, allowExternal }) {
    if (request.toolCalling && !model.toolCalling) return 'does not support tool calling'
    if (request.streaming && !model.streaming) return 'does not support streaming'
    if (request.structuredOutput && !model.structuredOutput) return 'does not support structured output'
    if (request.minContext && (model.contextWindow ?? 0) < request.minContext) {
      return `context window ${model.contextWindow ?? 0} < required ${request.minContext}`
    }
    if (model.location === 'online') {
      if (request.localOnly) return 'online model excluded by localOnly request'
      if (policy === 'strict_offline') return 'blocked by strict_offline policy'
      if (!allowExternal) return 'external egress not authorized for this request'
    }
    const availability = model.measured.availability
    if (availability === AVAILABILITY.DISABLED) return 'disabled by operator'
    if (availability === AVAILABILITY.NEEDS_CREDENTIALS) return 'provider credentials not configured'
    if (availability === AVAILABILITY.NOT_INSTALLED) return 'runtime or weights not installed locally'
    if (availability === AVAILABILITY.NEEDS_HARDWARE) return 'insufficient hardware for this model'
    if (availability === AVAILABILITY.UNREACHABLE) return 'provider unreachable at last probe'
    if (this.hardware && model.location === 'local') {
      if (model.minVramGb > (this.hardware.vramGb ?? 0) || model.minRamGb > (this.hardware.ramGb ?? 0)) {
        return `needs ${model.minRamGb}GB RAM / ${model.minVramGb}GB VRAM, host has ${this.hardware.ramGb}GB / ${this.hardware.vramGb}GB`
      }
    }
    return null
  }

  /**
   * Weighted score in [0,1]. Every term is derived from declared or *measured*
   * metadata — no random component, so a decision is reproducible.
   */
  #score(model, request) {
    const w = this.weights
    const capabilityFit = model.capabilities.length
      ? (request.capabilities || []).filter((c) => model.capabilities.includes(c)).length / request.capabilities.length
      : 0

    const privacy = model.location === 'local' ? 1 : 0

    // Latency: invert measured ms into 0..1 with a 4 s soft ceiling; unknown
    // latency is treated as mediocre rather than great, so probing is rewarded.
    const ms = model.measured.medianLatencyMs
    const latency = ms == null ? 0.5 : Math.max(0, Math.min(1, 1 - ms / 4000))

    let resourceFit = 1
    if (this.hardware && model.location === 'local') {
      const ramRatio = model.minRamGb ? Math.min(1, this.hardware.ramGb / model.minRamGb) : 1
      const vramRatio = model.minVramGb ? Math.min(1, (this.hardware.vramGb ?? 0) / model.minVramGb) : 1
      resourceFit = Math.min(ramRatio, vramRatio)
    }

    // Smaller/cheaper models are preferred when they can do the job.
    const quality = 1 / (1 + (model.costWeight - 1))

    const breakdown = { capabilityFit, privacy, latency, resourceFit, quality }
    const total =
      w.capabilityFit * capabilityFit + w.privacy * privacy + w.latency * latency + w.resourceFit * resourceFit + w.quality * quality

    return { total: round(total), breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, round(v)])) }
  }
}

function round(value) {
  return Math.round(value * 1e6) / 1e6
}
