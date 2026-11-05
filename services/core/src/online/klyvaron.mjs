// Klyvaron product tiers in the online architecture.
//
// The built-in processor is model-independent: deterministic parsing, retrieval, extractive
// ranking and bounded task workflows run without weights or network access. External provider
// and model selection is a separate feature and is not coupled to a Klyvaron tier.

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

export const KLYVARON_NOTE = 'Klyvaron Lite, Pro and Max are model-independent processing profiles. The built-in deterministic processor requires no AI model, weights, training, download, provider or network call. External provider/model selection is separate and is not tier-bound.'
