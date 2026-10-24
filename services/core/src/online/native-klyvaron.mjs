// First-party Klyvaron Pro (`klyvaron-pro-lm`) and Klyvaron Max (`klyvaron-max-lm`)
// native model manager for `OnlineApp`.
//
// Enforces every non-negotiable readiness invariant:
//   1. Never marks a model loaded or `selectorEnabled: true` until BOTH full artifact/SHA-256
//      verification AND a genuine live `generate()` inference pass succeed on its own weights.
//   2. Strictly checks architecture parameters against `PRESETS.pro` (27,559,946) and
//      `PRESETS.max` (92,077,066), refusing weight reuse between Pro and Max or smaller
//      substitute test checkpoints (`preset_architecture_mismatch`).
//   3. Keeps subscription/product routing plans completely separate from first-party
//      Klyvaron model identities (`klyvaron-pro-lm` and `klyvaron-max-lm`).
//   4. Never falls back to a third-party provider when a native Klyvaron model fails or is missing.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { SIZE_PRESETS, configDigest, parameterCount } from '../klyvaron/architecture.mjs'
import { ArtifactError } from '../klyvaron/format.mjs'
import { LocalCpuExecutor } from '../klyvaron/execution.mjs'
import { KlyvaronRuntime } from '../klyvaron/runtime.mjs'
import { KlyvaronStore } from '../klyvaron/store.mjs'
import { KlyvaronProvider } from '../providers/klyvaron.mjs'
import { failure } from './failure.mjs'

export const FIRST_PARTY_MODEL_SPECS = Object.freeze({
  'klyvaron-pro-lm': Object.freeze({
    id: 'klyvaron-pro-lm',
    label: 'Klyvaron Pro',
    displayName: 'Klyvaron Pro (first-party · 27.6M)',
    preset: 'pro',
    expectedArchitecture: SIZE_PRESETS.pro.config,
    expectedParameters: parameterCount(SIZE_PRESETS.pro.config),
    expectedArchitectureDigest: configDigest(SIZE_PRESETS.pro.config),
  }),
  'klyvaron-max-lm': Object.freeze({
    id: 'klyvaron-max-lm',
    label: 'Klyvaron Max',
    displayName: 'Klyvaron Max (first-party · 92.1M)',
    preset: 'max',
    expectedArchitecture: SIZE_PRESETS.max.config,
    expectedParameters: parameterCount(SIZE_PRESETS.max.config),
    expectedArchitectureDigest: configDigest(SIZE_PRESETS.max.config),
  }),
})

export const FIRST_PARTY_MODEL_IDS = Object.freeze(Object.keys(FIRST_PARTY_MODEL_SPECS))

const VERIFICATION_PROMPT = '[source=architecture.md] Klyvaron runs local Transformer weights verified by SHA-256.'
const VERIFICATION_QUESTION = 'What does architecture.md state about architecture?'

function matchesPresetArchitecture(manifestArch, expected) {
  return (
    manifestArch.vocab_size === expected.vocabSize
    && manifestArch.d_model === expected.dModel
    && manifestArch.n_layers === expected.nLayers
    && manifestArch.n_heads === expected.nHeads
    && manifestArch.d_ff === expected.dFf
    && manifestArch.seq_len === expected.seqLen
    && manifestArch.tie_embeddings === expected.tieEmbeddings
    && (manifestArch.age_buckets ?? 0) === expected.ageBuckets
    && (manifestArch.state_classes ?? 0) === expected.stateClasses
    && Boolean(manifestArch.verdict_head) === expected.verdictHead
    && Boolean(manifestArch.state_head) === expected.stateHead
  )
}

export class NativeKlyvaronHost {
  constructor({ root, dataDir = null, ledger = null, idleTimeoutMs = 60_000 } = {}) {
    this.root = resolve(root)
    this.store = new KlyvaronStore({ root: this.root, dataDir })
    this.executor = new LocalCpuExecutor({ idleTimeoutMs })
    this.ledger = ledger
    this.records = new Map()
    this.providers = new Map()
    this.#initializeAndVerifyInstalled()
  }

  /** Synchronously load, validate, run real inference, and gate every installed model. */
  #initializeAndVerifyInstalled() {
    for (const id of FIRST_PARTY_MODEL_IDS) {
      this.#verifySingleSync(id)
    }
    this.#rejectCrossTierWeightReuse()
  }

  #rejectCrossTierWeightReuse() {
    const pro = this.records.get('klyvaron-pro-lm')
    const max = this.records.get('klyvaron-max-lm')
    if (pro?.weightsSha256 && max?.weightsSha256 && pro.weightsSha256 === max.weightsSha256) {
      max.status = 'failed'
      max.selectorEnabled = false
      max.error = {
        code: 'duplicate_weights_prohibited',
        message: 'klyvaron-max-lm has the same SHA-256 weight digest as klyvaron-pro-lm; reusing Pro weights as Max is prohibited.',
      }
      this.providers.delete('klyvaron-max-lm')
    }
  }

  #verifySingleSync(id) {
    const spec = FIRST_PARTY_MODEL_SPECS[id]
    if (!spec) {
      throw failure('unknown_klyvaron_model', `Unknown first-party Klyvaron model '${id}'.`, 404)
    }
    const modelDir = join(this.store.libraryPath, id)
    this.providers.delete(id)

    if (!existsSync(modelDir)) {
      const record = {
        id,
        label: spec.label,
        displayName: spec.displayName,
        preset: spec.preset,
        status: 'not_installed',
        selectorEnabled: false,
        expectedParameters: spec.expectedParameters,
        expectedArchitectureDigest: spec.expectedArchitectureDigest,
        version: null,
        format: null,
        quantization: null,
        weightsSha256: null,
        bytes: null,
        residentWeightBytes: null,
        parameters: null,
        contextTokens: spec.expectedArchitecture.seqLen,
        tokenizer: null,
        inferenceVerification: null,
        error: null,
      }
      this.records.set(id, record)
      return record
    }

    // Phase A: Load + full SHA-256 + tensor completeness + strict preset architecture check.
    const loadStarted = performance.now()
    let runtime
    try {
      runtime = KlyvaronRuntime.load(modelDir)
    } catch (error) {
      const record = {
        id,
        label: spec.label,
        displayName: spec.displayName,
        preset: spec.preset,
        status: 'failed',
        selectorEnabled: false,
        expectedParameters: spec.expectedParameters,
        expectedArchitectureDigest: spec.expectedArchitectureDigest,
        version: null,
        format: null,
        quantization: null,
        weightsSha256: null,
        bytes: null,
        residentWeightBytes: null,
        parameters: null,
        contextTokens: spec.expectedArchitecture.seqLen,
        tokenizer: null,
        inferenceVerification: null,
        error: {
          code: error instanceof ArtifactError ? error.code : 'load_failed',
          message: error.message,
        },
      }
      this.records.set(id, record)
      this.ledger?.record({
        category: 'model',
        action: 'klyvaron_native_verify',
        outcome: 'failed',
        detail: { model: id, stage: 'load', code: record.error.code, message: record.error.message },
      })
      return record
    }
    const loadMs = Number((performance.now() - loadStarted).toFixed(2))

    if (runtime.manifest.id !== id) {
      const record = this.#failedRecord(spec, runtime, 'manifest_id_mismatch',
        `Directory '${id}' holds manifest id '${runtime.manifest.id}'; substitution is prohibited.`)
      this.records.set(id, record)
      return record
    }

    if (!matchesPresetArchitecture(runtime.config, spec.expectedArchitecture)
      || runtime.parameterCount !== spec.expectedParameters) {
      const record = this.#failedRecord(
        spec,
        runtime,
        'preset_architecture_mismatch',
        `${id} holds ${runtime.parameterCount.toLocaleString()} parameters (${JSON.stringify(runtime.config)}), `
        + `expected exact ${spec.preset} preset (${spec.expectedParameters.toLocaleString()} parameters). `
        + 'Smaller test checkpoints and cross-tier substitutes are refused.',
      )
      this.records.set(id, record)
      return record
    }

    if (runtime.manifest.provenance?.origin === 'test_fixture') {
      const record = this.#failedRecord(
        spec,
        runtime,
        'fixture_weights_refused',
        `${id} carries test_fixture random weights rather than trained weights; fixtures never qualify a model.`,
      )
      this.records.set(id, record)
      return record
    }

    // Phase B: Genuine live inference verification on actual loaded weights BEFORE `ready`!
    const inferStarted = performance.now()
    let probeOutput
    let kvParity
    try {
      const probePrompt = `<|system|>\n${runtime.manifest.chatTemplate?.systemPrompt ?? 'Answer from context.'}\n`
        + `<|context|>\n${VERIFICATION_PROMPT}\n<|user|>\n${VERIFICATION_QUESTION}\n<|assistant|>\n`
      probeOutput = runtime.generate({
        prompt: probePrompt,
        maxNewTokens: 4,
        minNewTokens: 2,
        temperature: 0,
        stop: runtime.manifest.generation?.stop ?? ['<|end|>'],
      })
      const kvIds = runtime.tokenizer.encode('Klyvaron architecture verification sequence.')
      kvParity = runtime.verifyKvCacheParity(kvIds)
      if (!probeOutput.generatedTokens || !probeOutput.text.trim()) {
        throw new Error('live inference verification generated an empty response')
      }
      if (!kvParity.greedyMatch || kvParity.maxAbsError > 1e-4) {
        throw new Error(`KV cache parity check failed (maxAbsError=${kvParity.maxAbsError})`)
      }
    } catch (error) {
      const record = this.#failedRecord(
        spec,
        runtime,
        error.code ?? 'inference_verification_failed',
        `Live inference verification failed for ${id}: ${error.message}`,
      )
      this.records.set(id, record)
      return record
    }
    const inferMs = Number((performance.now() - inferStarted).toFixed(2))
    const tokPerSec = Number(((probeOutput.generatedTokens / Math.max(inferMs, 0.001)) * 1000).toFixed(2))

    const provider = new KlyvaronProvider({
      runtime,
      guard: { fetch() { throw new Error('network egress is disabled for native Klyvaron models') } },
      onEvent: (event) => {
        if (event.type === 'provider_error') {
          this.ledger?.record({ category: 'model', action: 'klyvaron_native_error', outcome: 'error', detail: { model: id, ...event } })
        }
      },
      loadMs,
      executor: this.executor,
    })
    this.providers.set(id, provider)

    const record = {
      id,
      label: spec.label,
      displayName: spec.displayName,
      preset: spec.preset,
      status: 'ready',
      selectorEnabled: true,
      expectedParameters: spec.expectedParameters,
      expectedArchitectureDigest: spec.expectedArchitectureDigest,
      version: runtime.manifest.version,
      format: runtime.manifest.format,
      quantization: runtime.quantization,
      instructionTuned: runtime.instructionTuned,
      weightsFile: runtime.manifest.weights.file,
      weightsSha256: runtime.sha256,
      fp32SourceSha256: runtime.manifest.provenance?.quantizedFrom?.weightsSha256 ?? null,
      bytes: runtime.manifest.weights.bytes,
      residentWeightBytes: runtime.residentWeightBytes,
      parameters: runtime.parameterCount,
      contextTokens: runtime.contextTokens,
      architecture: { ...runtime.config },
      tokenizer: {
        kind: runtime.manifest.tokenizer.kind,
        vocabSize: runtime.tokenizer.size,
        digest: runtime.manifest.tokenizer.digest,
      },
      provenance: runtime.manifest.provenance,
      limitations: [...runtime.manifest.limitations],
      activeAdapter: null,
      inferenceVerification: {
        verifiedAt: new Date().toISOString(),
        loadMs,
        durationMs: inferMs,
        tokensPerSecond: tokPerSec,
        promptTokens: probeOutput.promptTokens,
        completionTokens: probeOutput.generatedTokens,
        samplePreview: probeOutput.text.slice(0, 160),
        differentiators: probeOutput.differentiators ?? null,
        kvCacheMaxAbsError: kvParity.maxAbsError,
      },
      error: null,
    }
    this.records.set(id, record)
    this.ledger?.record({
      category: 'model',
      action: 'klyvaron_native_verify',
      outcome: 'ready',
      detail: {
        model: id,
        version: record.version,
        weightsSha256: record.weightsSha256,
        parameters: record.parameters,
        loadMs,
        inferMs,
        tokensPerSecond: tokPerSec,
      },
    })
    return record
  }

  #failedRecord(spec, runtime, code, message) {
    this.ledger?.record({
      category: 'model',
      action: 'klyvaron_native_verify',
      outcome: 'failed',
      detail: { model: spec.id, stage: 'verify', code, message },
    })
    return {
      id: spec.id,
      label: spec.label,
      displayName: spec.displayName,
      preset: spec.preset,
      status: 'failed',
      selectorEnabled: false,
      expectedParameters: spec.expectedParameters,
      expectedArchitectureDigest: spec.expectedArchitectureDigest,
      version: runtime.manifest.version ?? null,
      format: runtime.manifest.format ?? null,
      quantization: runtime.quantization ?? null,
      weightsSha256: runtime.sha256 ?? null,
      bytes: runtime.manifest.weights?.bytes ?? null,
      residentWeightBytes: runtime.residentWeightBytes ?? null,
      parameters: runtime.parameterCount ?? null,
      contextTokens: runtime.contextTokens ?? spec.expectedArchitecture.seqLen,
      tokenizer: runtime.manifest.tokenizer
        ? { kind: runtime.manifest.tokenizer.kind, vocabSize: runtime.tokenizer.size, digest: runtime.manifest.tokenizer.digest }
        : null,
      inferenceVerification: null,
      error: { code, message },
    }
  }

  /** Re-verify one or all first-party models on disk (e.g. after training or restart). */
  verify(id = null) {
    if (id !== null) {
      const record = this.#verifySingleSync(id)
      this.#rejectCrossTierWeightReuse()
      return this.get(record.id)
    }
    this.#initializeAndVerifyInstalled()
    return this.summary()
  }

  isKnownFirstPartyId(id) {
    return Object.hasOwn(FIRST_PARTY_MODEL_SPECS, id)
  }

  isSelectable(id) {
    const rec = this.records.get(id)
    return Boolean(rec && rec.status === 'ready' && rec.selectorEnabled === true && this.providers.has(id))
  }

  get(id) {
    const rec = this.records.get(id)
    if (!rec) return null
    const provider = this.providers.get(id)
    return {
      ...structuredClone(rec),
      runtimeMeasurement: provider ? provider.measurement() : null,
      residentInWorker: Boolean(provider && provider.safeDescriptor().resident),
    }
  }

  list() {
    return FIRST_PARTY_MODEL_IDS.map((id) => this.get(id))
  }

  selectableModelEntries() {
    return this.list()
      .filter((entry) => entry.status === 'ready' && entry.selectorEnabled === true)
      .map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        provider: 'klyvaron',
        firstParty: true,
        preset: entry.preset,
        parameters: entry.parameters,
        contextTokens: entry.contextTokens,
        quantization: entry.quantization,
        weightsSha256: entry.weightsSha256,
        location: 'native',
        availability: 'inference_verified',
        selectable: true,
      }))
  }

  summary() {
    const models = this.list()
    const ready = models.filter((m) => m.status === 'ready' && m.selectorEnabled)
    return {
      readyCount: ready.length,
      totalFirstPartyModels: models.length,
      executor: this.executor.snapshot(),
      models,
    }
  }

  /** Require a verified `ready` first-party provider, or fail closed with an actionable error. */
  requireProvider(id) {
    const rec = this.records.get(id)
    if (!rec) {
      throw failure('unknown_klyvaron_model', `Unknown Klyvaron model '${id}'.`, 404)
    }
    if (rec.status === 'not_installed') {
      throw failure(
        'klyvaron_model_missing',
        `${rec.label} (${id}) weights are not installed in ${this.store.libraryPath}. No fallback to another model or provider is performed.`,
        503,
      )
    }
    const provider = this.providers.get(id)
    if (rec.status !== 'ready' || !rec.selectorEnabled || !provider) {
      throw failure(
        rec.error?.code ?? 'klyvaron_model_not_ready',
        `${rec.label} (${id}) is not verified for inference (${rec.error?.code ?? rec.status}: ${rec.error?.message ?? 'verification incomplete'}). No fallback to another model or provider is performed.`,
        503,
      )
    }
    return { record: rec, provider }
  }

  /** Activate a verified `klyvaron.adapter/1` package on an installed ready first-party model. */
  activateAdapter(id, adapterDirectory) {
    const { record, provider } = this.requireProvider(id)
    const attached = provider.attachAdapter(adapterDirectory)
    record.activeAdapter = attached
    this.ledger?.record({
      category: 'model',
      action: 'klyvaron_adapter_activate',
      outcome: 'active',
      detail: { model: id, adapterId: attached.id, adapterSha256: attached.sha256 },
    })
    return this.get(id)
  }

  /** Roll back any active adapter on `id`, restoring untouched verified base weights. */
  rollbackAdapter(id) {
    const rec = this.records.get(id)
    const provider = this.providers.get(id)
    if (provider) provider.detachAdapter()
    if (rec) rec.activeAdapter = null
    this.ledger?.record({
      category: 'model',
      action: 'klyvaron_adapter_rollback',
      outcome: 'restored_base',
      detail: { model: id, weightsSha256: rec?.weightsSha256 ?? null },
    })
    return this.get(id)
  }

  async close() {
    this.providers.clear()
    await this.executor.close()
  }
}
