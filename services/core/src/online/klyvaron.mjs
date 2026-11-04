// Klyvaron product tiers in the online architecture.
//
// Klyvaron's built-in processor is model-independent: deterministic parsing, retrieval,
// extractive ranking and bounded task workflows run without weights or network access. The
// optional provider preset below is a separate BYOK integration; it is not required by the
// built-in engine and is never described as Klyvaron-owned inference.
//
// Three rules this module exists to keep true:
//
//   1. A tier is not a model. `independentWeights: false` and `provenance.kind:
//      'third_party_api'` are facts, not UI copy that a later template can drop.
//   2. The tier cannot name a vendor the operator did not save. Resolution goes through the
//      connection store, so provenance is read from the same record the request uses.
//   3. A tier with no preset stays unconfigured and refuses a request by name. It never falls
//      back to a different model, because a product tier that silently becomes another product
//      tier is a mislabel.

import { failure } from './failure.mjs'

export const KLYVARON_TIERS = Object.freeze([
  Object.freeze({
    id: 'lite',
    label: 'Klyvaron Lite',
    intent: 'Fast, bounded text processing and concise extractive workflows on modest resources.'
  }),
  Object.freeze({
    id: 'pro',
    label: 'Klyvaron Pro',
    intent: 'Larger local context and multi-step deterministic workflows for documents and data.'
  }),
  Object.freeze({
    id: 'max',
    label: 'Klyvaron Max',
    intent: 'The largest bounded local workflows with parallel independent processing steps.'
  }),
])

export const TIER_IDS = Object.freeze(KLYVARON_TIERS.map((tier) => tier.id))
export const MODALITIES = Object.freeze(['chat', 'image', 'video'])

export const KLYVARON_NOTE = 'Klyvaron Lite, Pro and Max are model-independent processing profiles. The built-in deterministic processor requires no AI model, weights, training, download, provider or network call. Optional BYOK model routing is separate and names its provider/model explicitly.'

/** The label for a tier id, or null when it is not a tier this build defines. */
export function tierFor(id) {
  return KLYVARON_TIERS.find((tier) => tier.id === id) ?? null
}

/**
 * Provenance for one resolved destination.
 *
 * `provider` is the saved connection's own label; `model` is the exact id sent in the request.
 * `training` says what this project did, which is nothing: the model was trained by its publisher,
 * and no fine-tuning or distillation by this installation is involved.
 */
export function provenanceFor(connection, model) {
  return {
    kind: 'third_party_api',
    providerId: connection.id,
    provider: connection.label ?? connection.id,
    wire: connection.wire ?? null,
    model,
    firstPartyWeights: false,
    training: 'none_by_this_project',
    statement: `Served by ${connection.label ?? connection.id} (${connection.wire ?? 'configured wire'}) using ${model}. No Klyvaron weights are used.`,
  }
}

/**
 * Resolve a tier preset into the connection and model a request will use.
 *
 * `configFor` is the store's own `config(id)`, so an unconfigured connection refuses with the
 * store's error rather than being reported as a usable tier. `wireFor` is injected by the caller
 * for the same reason: the modality check must read the adapter, not a table that can drift.
 */
export function resolveTier({ tier, modality, store, configFor, wireFor }) {
  const preset = store.klyvaronPreset(tier, modality)
  if (!preset) {
    throw failure('klyvaron_tier_unconfigured', `${tierFor(tier)?.label ?? tier} has no ${modality} preset. Choose a saved connection and a listed model in Provider Settings.`, 409)
  }
  const config = configFor(preset.connectionId)
  const wire = wireFor(config.wire)
  const actual = wire.modality ?? 'chat'
  if (actual !== modality) {
    throw failure('klyvaron_tier_modality', `${tierFor(tier)?.label ?? tier} is set to ${config.label}, which serves ${actual}, not ${modality}.`, 409)
  }
  return { tier, preset, config, wire, model: preset.model, provenance: provenanceFor(config, preset.model) }
}
