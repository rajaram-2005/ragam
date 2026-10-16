// The Klyvaron family's OWN model architecture: `aetheris-core-v1`.
//
// This module exists because of a decision, not because of a formula. Pro and Max were going to
// be *composed* at run time from a pinned third-party base -- no training, but also no model of
// this family's own: someone else's weights, under someone else's licence, wearing our tier
// label. That is not what the family is for. Pro and Max are OUR models: weights trained from
// random initialisation in this repository, exactly like Lite, with no base checkpoint anywhere
// in the chain. `validateArchitecture` refuses a preset that names one.
//
// The consequence is stated up front rather than buried: a model whose weights do not exist yet
// cannot be a delivered model. There is no technique that produces new weights without training.
// What needs no training is the WORK SO FAR -- the architecture, the exact configuration, the
// parameter and memory arithmetic, and the recipe -- and all of that is real and checkable here.
// The weights are the part that requires compute, and `recipeReport` says so per tier.
//
// The parameter formula is not re-invented: it mirrors `TransformerConfig.parameter_count` in
// `services/fabric/fabric/lm/model.py`, which is the trainer that actually initialises these
// arrays. `test/architecture.test.mjs` checks the Lite preset against the *released model card*
// in `docs/model-cards/aetheris-lite-lm-0.1.1.json`, so if the two definitions ever drift apart,
// a test fails instead of a document going stale.

import { createHash } from 'node:crypto'

/** The design. One architecture, several sizes; a size is a preset, never a separate design. */
export const ARCHITECTURE = Object.freeze({
  id: 'aetheris-core-v1',
  owner: 'klyvaron',
  kind: 'decoder_only_transformer',
  // The trainer that implements this architecture, in this repository. Pure NumPy, no PyTorch,
  // no CUDA kernels: it is the reason a from-scratch model was buildable here at all (docs/08).
  trainer: 'services/fabric/fabric/lm/train.py',
  implemented: true,
  components: Object.freeze([
    Object.freeze({ name: 'pre-LayerNorm blocks', reason: 'Post-LN needs a warmup schedule to train from a cold start; pre-LN does not.' }),
    Object.freeze({ name: 'learned positional embeddings', reason: 'At this context length there is nothing to extrapolate to, and it is one less function to get wrong.' }),
    Object.freeze({ name: 'GELU MLP (tanh approximation)', reason: 'NumPy has no erf, and SciPy is deliberately not a dependency.' }),
    Object.freeze({ name: 'weight tying between embedding and head', reason: 'At these sizes the embedding is a large share of all parameters; tying is a real improvement, not a shortcut.' }),
    Object.freeze({ name: 'residual outputs scaled by 1/sqrt(2L)', reason: 'Without it the residual stream grows with depth and the final LayerNorm sees a scale that depends on layer count.' }),
    Object.freeze({ name: 'hand-derived backward passes, finite-difference checked', reason: 'A wrong gradient does not crash; it trains a model that quietly learns nothing.' }),
  ]),
  // Named because they are the features a reader would otherwise assume. None of them is
  // implemented, so none of them is claimed: this is a design, not a wish list.
  absent: Object.freeze([
    Object.freeze({ name: 'grouped-query attention', cost: 'The KV cache is n_heads times a grouped design at the same context; Max pays 12x. Named in the memory arithmetic rather than discovered at run time.' }),
    Object.freeze({ name: 'rotary position embeddings', cost: 'Learned positions cannot extrapolate past the trained context; the context is a config value, not a promise.' }),
    Object.freeze({ name: 'mixture-of-experts', cost: 'No routing, no sparse parameters; every parameter is used on every token.' }),
    Object.freeze({ name: 'dropout', cost: 'Not implemented in the trainer, and a config that asks for it is refused rather than silently ignored.' }),
    Object.freeze({ name: 'instruction tuning', cost: 'This architecture describes a pretrained base. An instruction-tuned variant is a separate artifact with its own evaluation, not a config flag.' }),
  ]),
})

/**
 * The sizes, smallest first. A tier is a preset of this architecture -- not a different design,
 * not a wrapper around someone else's.
 *
 * `mini` is a preset and not a tier: it is the size this host can train in a single sitting, so it
 * is the artifact that shows the architecture, the corpus, the tokenizer, the trainer and the
 * release gate working end to end. The tiers are lite, pro and max; `mini` claims no tier label,
 * and its card says what it is in its family field.
 */
export const SIZE_IDS = Object.freeze(['lite', 'mini', 'pro', 'max'])

export const SIZE_PRESETS = Object.freeze({
  lite: Object.freeze({
    size: 'lite',
    modelId: 'aetheris-lite-lm',
    // The released artifact's exact configuration. The digest in the model card is the same
    // numbers hashed in the same order, which is why this preset can be cross-checked.
    config: Object.freeze({
      vocabSize: 148, dModel: 96, nLayers: 3, nHeads: 4, dFf: 384, seqLen: 128, tieEmbeddings: true, baseCheckpoint: null,
      // No differentiator parts: this is the released configuration, and the parts were added
      // afterwards. Its record keeps what it was trained with, which is why the digest below is
      // still the digest of the run that produced the artifact.
      ageBuckets: 0, stateClasses: 0, verdictHead: false, stateHead: false,
    }),
    released: true,
    artifact: 'aetheris-lite-lm-0.1.1',
    training: null,
  }),
  mini: Object.freeze({
    size: 'mini',
    modelId: 'klyvaron-mini-lm',
    // The second artifact of this architecture, and the first trained on the assembled corpus
    // rather than on this repository alone. Every number here is the configuration the run
    // recorded: vocabSize 352 is the tokenizer fitted on that run's training split (the vocabulary
    // is data, so it is part of the config, not an assumption). The differentiator parts are off,
    // because labelling a general corpus with evidence ages and expressed states is a mechanism
    // that does not exist yet -- the parts are implemented and separately prototyped, and a config
    // may not imply a capability its data cannot train.
    config: Object.freeze({
      vocabSize: 352, dModel: 192, nLayers: 3, nHeads: 4, dFf: 768, seqLen: 128, tieEmbeddings: true, baseCheckpoint: null,
      ageBuckets: 0, stateClasses: 0, verdictHead: false, stateHead: false,
    }),
    // Released. These three fields were `released: false`, `artifact: null`,
    // `training: 'klyvaron-mini-lm@0.1.0'` while the run was in flight, and they moved when that
    // run exited 0 and the release gate registered the card -- the state this module reported
    // before then is in this file's history and in `docs/experiments/klyvaron-mini-lm-run.json`,
    // which carried `status: running` until the report existed.
    //
    // The gate passed with 0 hard failures and **1 soft failure**: wallSeconds 8,456.326 against a
    // 3,600 s soft target. The target was written for a smaller run and was not relaxed to make
    // this one pass; the miss is on the card, in its limitation list, and in the run record.
    released: true,
    artifact: 'klyvaron-mini-lm-0.1.0',
    training: null,
  }),
  pro: Object.freeze({
    size: 'pro',
    modelId: 'klyvaron-pro-lm',
    config: Object.freeze({
      vocabSize: 4096, dModel: 512, nLayers: 8, nHeads: 8, dFf: 2048, seqLen: 512, tieEmbeddings: true, baseCheckpoint: null,
      ageBuckets: 16, stateClasses: 8, verdictHead: true, stateHead: true,
    }),
    released: false,
    artifact: null,
    training: null,
  }),
  max: Object.freeze({
    size: 'max',
    modelId: 'klyvaron-max-lm',
    config: Object.freeze({
      vocabSize: 8192, dModel: 768, nLayers: 12, nHeads: 12, dFf: 3072, seqLen: 1024, tieEmbeddings: true, baseCheckpoint: null,
      ageBuckets: 16, stateClasses: 8, verdictHead: true, stateHead: true,
    }),
    released: false,
    artifact: null,
    training: null,
  }),
})

/**
 * The two differentiators, as parts of the model.
 *
 * This is the change that makes Pro and Max *Klyvaron* models rather than a language model with a
 * wrapper around it: the freshness of the evidence and the state the user expressed are inputs the
 * trunk sees at every layer, and the verdict and state heads are trained in the same loss as the
 * next-token objective. A model that was only checked afterwards by a script could be swapped for a
 * different model without changing the script; a model trained with these parts cannot.
 *
 * Which capability each part serves is recorded, not implied, and the plan's gates ask for an
 * artifact measured against the acceptance rules before either capability may be called available.
 */
export const DIFFERENTIATOR_PARTS = Object.freeze([
  Object.freeze({
    id: 'age_buckets',
    capability: 'trend.awareness',
    kind: 'conditioning_table',
    label: 'How old the evidence behind each token is',
    parameters: (config) => (config.ageBuckets ?? 0) * config.dModel,
    why: 'Freshness is a property of the evidence, not of the text: if it is not an input, the model can only guess. Added to the input hidden state so every layer sees it.',
  }),
  Object.freeze({
    id: 'state_emb',
    capability: 'affect.history',
    kind: 'conditioning_table',
    label: 'The state the session carries into this turn',
    parameters: (config) => (config.stateClasses ?? 0) * config.dModel,
    why: 'What was expressed earlier is context for this turn. It is a hint and never the label: a model that scored by reading its own input would be reporting the state it was handed.',
  }),
  Object.freeze({
    id: 'verdict_head',
    capability: 'trend.awareness',
    kind: 'head',
    label: 'Grounded or abstain, read at the last position',
    parameters: (config) => (config.verdictHead ? 2 * config.dModel + 2 : 0),
    why: 'Abstention has to be a thing the model can *do*, not a rule applied to its output afterwards. A stale source makes abstain the correct class, so a stale answer is an error the loss sees.',
  }),
  Object.freeze({
    id: 'state_head',
    capability: 'affect.history',
    kind: 'head',
    label: 'Which of the expressed states, including "none"',
    parameters: (config) => (config.stateHead && (config.stateClasses ?? 0) ? config.stateClasses * config.dModel + config.stateClasses : 0),
    why: 'One class is reserved for "nothing was expressed", so the model has somewhere to put an abstention instead of being forced to choose a state for every message.',
  }),
])

/** Parameters the differentiator parts add to a preset, mirroring the trainer exactly. */
export function differentiatorParameters(config) {
  return DIFFERENTIATOR_PARTS.reduce((total, part) => total + part.parameters(config), 0)
}

/**
 * The modalities are different models, not different prompts.
 *
 * `text` is this architecture. `image` and `video` are separate designs with separate trainers, and
 * neither exists yet: the record says so here rather than leaving a reader to assume that a text
 * preset with a different prompt is an image model. The core's family validator independently
 * refuses an artifact that backs a text capability and an image or video capability at once.
 */
export const MODALITY_MODELS = Object.freeze({
  text: Object.freeze({ modelId: 'aetheris-core-v1', kind: ARCHITECTURE.kind, implemented: true, trainer: ARCHITECTURE.trainer, note: 'One architecture, three presets; the differentiator parts above are part of it.' }),
  image: Object.freeze({
    modelId: 'aetheris-image-v1',
    kind: 'latent_denoising_transformer',
    implemented: false,
    trainer: null,
    note: 'An image model is not a text model with a different prompt: pixels need a decoder, a noise schedule, and an evaluation measured in images rather than in characters. None of that exists here yet, so there is no parameter count to give.',
  }),
  video: Object.freeze({
    modelId: 'aetheris-video-v1',
    kind: 'latent_video_transformer',
    implemented: false,
    trainer: null,
    note: 'Video adds time to the same problem: a temporal decoder, a longer context, and an evaluation on motion rather than on a single frame. Nothing here is implemented; the tier record keeps image and video capabilities unavailable and the plan keeps modality separation open.',
  }),
})

/** The model id a modality would be served by. Called by tests and the report, never assumed. */
export function modalityModel(modality) {
  const record = MODALITY_MODELS[modality]
  if (!record) throw new Error(`unknown modality: ${modality}`)
  return record
}

/**
 * The recipe for a model of this family, in order, each step either done or open.
 *
 * `config` is the step that is genuinely finished for Pro and Max: the architecture and the
 * exact configuration exist as data and are digested here. Everything downstream of it needs
 * compute, and `recipeReport` reports those as open rather than pending.
 */
export const RECIPE_STEPS = Object.freeze([
  Object.freeze({ id: 'corpus', label: 'A licence-checked corpus with a recorded manifest digest', needsCompute: false }),
  Object.freeze({ id: 'tokenizer', label: 'A tokenizer fitted on the training split only', needsCompute: false }),
  Object.freeze({ id: 'config', label: 'The architecture and the exact config, recorded and digested', needsCompute: false }),
  Object.freeze({ id: 'backend', label: 'A trainer that runs on the accelerator this tier targets', needsCompute: true }),
  Object.freeze({ id: 'train', label: 'Trained from random initialisation: steps, tokens and loss recorded', needsCompute: true }),
  Object.freeze({ id: 'evaluate', label: 'Evaluated on held-out data against a baseline, with hard requirements', needsCompute: true }),
  Object.freeze({ id: 'release', label: 'Released with a model card; weights referenced by digest, not redistributed', needsCompute: false }),
])

export const RECIPE_STEP_IDS = Object.freeze(RECIPE_STEPS.map((s) => s.id))
export const RECIPE_STATES = Object.freeze({ SATISFIED: 'satisfied', OPEN: 'open' })

// What is already true for Lite, taken from the released card rather than asserted here. Every
// figure below is in docs/model-cards/aetheris-lite-lm-0.1.1.json; the evidence string names it.
const LITE_EVIDENCE = Object.freeze({
  corpus: 'This repository\'s own text, 2,366,622 bytes, manifest digest 70c5b78c77bce0e122df93fe43504b6b780acf10b865baaa5076307b0883aa02',
  tokenizer: 'Character-level, 148 tokens, fitted on the training split only, vocabulary digest 98228a472eab78caa335205387b0126b87cdf14212375f39b57101f02c4c2605',
  backend: 'Pure NumPy on the CPU: 2 cores, no PyTorch, no GPU. 2,062.9 s for 2,600 steps.',
  train: 'aetheris-lite-lm-0.1.1: from random initialisation, 359,616 parameters, final loss 1.4791, wall 2,062.9 s',
  evaluate: 'Held-out perplexity 4.8932 against a bigram baseline of 15.7588 (0.3105 of it); 5 hard requirements, 0 failures',
  release: 'aetheris-lite-lm@0.1.1, MIT, weights digest 53ae59b2a777be9d22f1f04b6cbc94aee3dad6144ac40e4e25c12f900164b60c; the .npz is gitignored and referenced by digest',
})

/** Reasons the open steps are open, per tier. Absence of evidence is reported as absence. */
const OPEN_REASONS = Object.freeze({
  corpus: 'No corpus has been assembled for this size. This repository\'s own text is 2.4 MB, which is enough for 359,616 parameters and not enough for tens of millions: at that ratio the model would memorise it.',
  tokenizer: 'No tokenizer has been fitted for this size. A 148-character vocabulary is the wrong unit at this parameter count -- it spends the compute on sequence length instead of on text -- so a subword tokenizer has to be trained on the corpus first.',
  config: 'The config exists; nothing has been trained with it.',
  backend: 'The trainer in this repository is pure NumPy and CPU-only: it ran Lite in 34 minutes and it cannot use an accelerator at all. Running this size on the user\'s own GPU or NPU is code that does not exist yet -- it is the step that turns "train it on your machine" from a sentence into a program.',
  train: 'No weights exist. This is the step the whole page is about: a model is its weights, and these have not been trained.',
  evaluate: 'Nothing to evaluate until weights exist.',
  release: 'Nothing to release until weights exist and pass evaluation.',
})

// What is already true for the `mini` run, taken from its own record rather than asserted here.
// `docs/experiments/klyvaron-mini-lm-run.json` holds the command, the config, the corpus digest and
// the tokenizer digest these strings quote, and `test/architecture.test.mjs` checks them against
// that file. The three steps that need the run to finish are *not* here: a step moves when the run
// that satisfies it has an outcome, and this run is still in flight.
const MINI_EVIDENCE = Object.freeze({
  corpus: "This repository's own text plus seven licence-checked public sources, 13.65 MB, manifest digest f8dfef6f; the held-out split is two sources whole (pallets/click, psf/requests), 1,897,673 bytes of validation text the model never trains on",
  tokenizer: 'Character-level, 352 tokens, fitted on the training split only, vocabulary digest a8c0642b24412a9bc3b93c13973c5ced462c2d44883d1949471f36cb393b24a',
  backend: 'Pure NumPy on the CPU: this host, 2 cores, no PyTorch, no accelerator. 1.9-4.0 s per step measured from the run\'s own log, 8,456.3 s of wall clock for the whole run.',
  train: 'klyvaron-mini-lm@0.1.0: from random initialisation, 1,421,952 parameters, 4,000 steps, loss 5.7551 -> 0.8157, wall 8,456.3 s',
  evaluate: 'Held-out perplexity 4.7342 against a bigram baseline of 15.8644 (0.2984 of it) over 1,907,072 characters from two sources the model never trained on; 3 hard requirements, 0 failures',
  release: 'klyvaron-mini-lm@0.1.0, MIT, weights digest eaca87db5700b9ee99d162e650b23478bd9a57715e349dee0fb18a4dc3fda116; 0 hard failures, 1 soft failure (wallSeconds 8,456.3 against 3,600); the .npz is gitignored and referenced by digest',
})

/** Evidence for one size, so a size cannot be credited with another size's run. */
const EVIDENCE = Object.freeze({ lite: LITE_EVIDENCE, mini: MINI_EVIDENCE })

/**
 * The recipe for one size.
 *
 * Lite's steps come from its released card, `mini`'s from the record of the run producing it, and
 * Pro's and Max's are open. The evidence is looked up *per size*: a released size used to fall
 * through to Lite's evidence, which would have credited another run's corpus and weights to
 * whatever preset happened to be released next.
 */
export function recipeReport(sizeId) {
  const preset = SIZE_PRESETS[sizeId]
  if (!preset) throw new Error(`unknown size: ${sizeId}`)
  const evidence = EVIDENCE[sizeId] ?? {}
  return RECIPE_STEPS.map((step) => {
    if (step.id === 'config') {
      return {
        id: step.id,
        label: step.label,
        status: RECIPE_STATES.SATISFIED,
        evidence: `${ARCHITECTURE.id} preset ${preset.modelId} is recorded in this module; config digest ${configDigest(preset.config)}`,
        reason: null,
      }
    }
    if (evidence[step.id]) {
      return { id: step.id, label: step.label, status: RECIPE_STATES.SATISFIED, evidence: evidence[step.id], reason: null }
    }
    return {
      id: step.id,
      label: step.label,
      status: RECIPE_STATES.OPEN,
      evidence: null,
      reason: OPEN_REASONS[step.id],
    }
  })
}

/**
 * Python's `repr` for the floats a config holds: `0.0`, `0.02`, `1e-05`.
 *
 * Needed because this digest has to be comparable with one a Python process wrote, and
 * `JSON.stringify(1e-5)` is `1e-5` where Python writes `1e-05`.
 */
function pythonFloat(value) {
  if (Number.isInteger(value)) return `${value}.0`
  const abs = Math.abs(value)
  if (abs >= 1e-4 && abs < 1e16) return String(value)
  const [mantissa, exponent] = value.toExponential().split('e')
  const sign = exponent.startsWith('-') ? '-' : '+'
  return `${mantissa}e${sign}${exponent.replace(/^[+-]/, '').padStart(2, '0')}`
}

/**
 * The digest of a preset's MODEL configuration, serialised exactly as the trainer does it:
 * `json.dumps(asdict(config), sort_keys=True)`, i.e. sorted keys, `", "` and `": "` separators,
 * integers as integers and floats in Python's repr.
 *
 * Covers the fourteen fields today's `TransformerConfig` has, including the four differentiator
 * fields, which default to off. That is what makes it checkable: train the preset, read
 * `model_config` out of the run's report, hash it the same way, and the two digests are the same
 * string -- which `test/architecture.test.mjs` does for the artifact whose run is recorded in this
 * repository.
 *
 * The released Lite run predates the four fields, so its recorded `model_config` has ten keys and
 * hashes differently. That is not a discrepancy to paper over: its digest is the digest of the
 * file that run wrote, and `trunkConfigDigest` below reproduces it. Two runs serialised by two
 * versions of a dataclass are two different payloads, and saying so is the point.
 */
export function configDigest(config) {
  return digestOfConfigFields(config, [
    ['age_buckets', config.ageBuckets ?? 0, 'int'],
    ['d_ff', config.dFf, 'int'],
    ['d_model', config.dModel, 'int'],
    ['dropout', 0, 'float'],
    ['init_scale', 0.02, 'float'],
    ['layernorm_eps', 1e-5, 'float'],
    ['n_heads', config.nHeads, 'int'],
    ['n_layers', config.nLayers, 'int'],
    ['seq_len', config.seqLen, 'int'],
    ['state_classes', config.stateClasses ?? 0, 'int'],
    ['state_head', config.stateHead === true, 'bool'],
    ['tie_embeddings', config.tieEmbeddings !== false, 'bool'],
    ['verdict_head', config.verdictHead === true, 'bool'],
    ['vocab_size', config.vocabSize, 'int'],
  ])
}

/** The ten fields every version of this trainer has written: the payload the released run hashed. */
export function trunkConfigDigest(config) {
  return digestOfConfigFields(config, [
    ['d_ff', config.dFf, 'int'],
    ['d_model', config.dModel, 'int'],
    ['dropout', 0, 'float'],
    ['init_scale', 0.02, 'float'],
    ['layernorm_eps', 1e-5, 'float'],
    ['n_heads', config.nHeads, 'int'],
    ['n_layers', config.nLayers, 'int'],
    ['seq_len', config.seqLen, 'int'],
    ['tie_embeddings', config.tieEmbeddings !== false, 'bool'],
    ['vocab_size', config.vocabSize, 'int'],
  ])
}

function digestOfConfigFields(config, fields) {
  const body = fields.map(([key, value, kind]) => {
    const rendered = kind === 'float' ? pythonFloat(value) : String(value)
    return `"${key}": ${rendered}`
  }).join(', ')
  return createHash('sha256').update(`{${body}}`, 'utf8').digest('hex')
}

/**
 * The checks the trainer's own config performs, plus the one this family adds.
 *
 * The last rule is the point of the module: this architecture is trained from random
 * initialisation, so a preset that names a base checkpoint is not a preset of it. A composed
 * tier is a different thing and belongs to `composition.mjs`, where the base is recorded as
 * third-party provenance.
 */
export function validateArchitecture(config) {
  const violations = []
  if (!config || typeof config !== 'object') return { valid: false, violations: ['a config must be an object'] }
  const { vocabSize, dModel, nLayers, nHeads, dFf, seqLen } = config
  const positive = { vocabSize, dModel, nLayers, nHeads, dFf, seqLen }
  for (const [name, value] of Object.entries(positive)) {
    if (!Number.isInteger(value) || value <= 0) violations.push(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  if (Number.isInteger(vocabSize) && vocabSize < 2) violations.push(`vocabSize must be at least 2, got ${vocabSize}`)
  if (Number.isInteger(dModel) && Number.isInteger(nHeads) && nHeads > 0 && dModel % nHeads !== 0) {
    violations.push(`dModel ${dModel} is not divisible by nHeads ${nHeads}`)
  }
  if (config.dropout) violations.push('dropout is not implemented in this trainer; a config that asks for it is refused rather than silently ignored')
  for (const name of ['ageBuckets', 'stateClasses']) {
    const value = config[name] ?? 0
    if (!Number.isInteger(value) || value < 0) violations.push(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  if (config.stateHead && !(config.stateClasses > 0)) {
    violations.push('stateHead needs stateClasses > 0: a head with no classes has nothing to predict')
  }
  if (config.baseCheckpoint !== null && config.baseCheckpoint !== undefined) {
    violations.push('baseCheckpoint is set: this architecture is trained from random initialisation and has no base. A model built on someone else\'s weights is a composed tier, not one of ours.')
  }
  return { valid: violations.length === 0, violations }
}

/**
 * Parameter count, mirroring `TransformerConfig.parameter_count` in the trainer.
 *
 * per layer = 4*d^2 (q, k, v, o) + 2*d*ff (the MLP pair) + 4*d (two LayerNorms, gain and bias).
 * Attention and MLP have no biases, so adding one here would predict parameters the trainer
 * never creates.
 */
export function parameterCount(config) {
  const { dModel: d, dFf: ff, vocabSize: v, nLayers: L, seqLen: T } = config
  const perLayer = 4 * d * d + 2 * d * ff + 4 * d
  const embedding = v * d
  const positions = T * d
  const finalLayerNorm = 2 * d
  const head = config.tieEmbeddings === false ? v * d : 0
  return embedding + positions + L * perLayer + finalLayerNorm + head + differentiatorParameters(config)
}

/** The same count, split into the parts a reader would otherwise have to guess. */
export function parameterBreakdown(config) {
  const { dModel: d, dFf: ff, vocabSize: v, nLayers: L, seqLen: T } = config
  const perLayer = 4 * d * d + 2 * d * ff + 4 * d
  const parts = [
    { part: 'token embedding', parameters: v * d, note: config.tieEmbeddings === false ? 'untied, so the head is counted separately' : 'tied to the output head' },
    { part: 'position embedding', parameters: T * d, note: `learned, ${T} positions` },
    { part: `transformer blocks (${L} x ${perLayer})`, parameters: L * perLayer, note: '4d^2 attention + 2*d*ff MLP + 4d for two LayerNorms, no biases' },
    { part: 'final LayerNorm', parameters: 2 * d, note: 'gain and bias' },
  ]
  if (config.tieEmbeddings === false) parts.push({ part: 'output head', parameters: v * d, note: 'untied' })
  for (const part of DIFFERENTIATOR_PARTS) {
    const parameters = part.parameters(config)
    if (parameters) parts.push({ part: part.label, parameters, note: `${part.kind} for ${part.capability}` })
  }
  return parts
}

/**
 * KV cache for one sequence, in bytes.
 *
 * MHA, so the key and value tensors are n_heads * head_dim = d_model wide each: the cache is
 * 2 * L * d_model per token. Grouped-query attention would divide that by the group factor, and
 * this architecture does not have it, which is why this number is printed rather than assumed.
 */
export function kvCacheBytes(config, { contextTokens, bytesPerElement = 2 } = {}) {
  if (!Number.isInteger(contextTokens) || contextTokens <= 0) throw new Error('contextTokens must be a positive integer')
  return 2 * config.nLayers * config.dModel * contextTokens * bytesPerElement
}

/** Weight bytes at a given precision. 4 = fp32, 2 = fp16/bf16, 1 = int8, 0.5 = int4. */
export function weightBytes(parameters, bytesPerParameter) {
  return parameters * bytesPerParameter
}

/**
 * Optimiser state for Adam in fp32: the weights, their gradients, and two moments.
 *
 * This is the number that decides whether a size can be trained on a given accelerator at all,
 * before activations are counted, and it is why the Pro preset is 28 M parameters rather than
 * the hundreds of millions a GPU-qualified desktop could *serve*.
 */
export function trainingStateBytes(parameters, { bytesPerParameter = 4 } = {}) {
  const perTensor = parameters * bytesPerParameter
  return { weights: perTensor, gradients: perTensor, moments: 2 * perTensor, total: 4 * perTensor }
}

/**
 * A FLOOR on the activation memory for one step, not a peak.
 *
 * It counts the per-layer tensors the backward pass stores and the two largest temporaries
 * (attention scores, logits). Matmul workspace is not counted, so a real run needs more than
 * this. A floor is the honest direction for a number used to decide whether something fits.
 */
export function activationFloorBytes(config, { batch = 1, contextTokens, bytesPerElement = 4 } = {}) {
  if (!Number.isInteger(contextTokens) || contextTokens <= 0) throw new Error('contextTokens must be a positive integer')
  const { dModel: d, dFf: ff, nLayers: L, nHeads: h } = config
  const tokens = batch * contextTokens
  const perLayerStored = 2 * tokens * d + 2 * tokens * d + 2 * tokens * ff // ln1 out, q, k, v / attn out, ln2 out / fc out, gelu out -- counting the two dominant pairs
  const layers = L * perLayerStored
  const scores = batch * h * contextTokens * contextTokens
  const logits = tokens * config.vocabSize
  const bytes = (layers + scores + logits) * bytesPerElement
  return { bytes, layers, scores, logits }
}

/** Training compute: 6 * N * D, the standard dense-transformer estimate, embeddings included. */
export function trainingFlops(parameters, tokens) {
  return 6 * parameters * tokens
}

/**
 * Seconds for a given compute, at a rate the CALLER supplies.
 *
 * Deliberately not a lookup table of hardware: this repository does not own a GPU, so any
 * TFLOP/s figure here would be a number read off a spec sheet and presented as throughput. The
 * CLI prints this arithmetic at explicitly assumed rates and labels them as assumptions.
 */
export function secondsAt(flops, teraflops) {
  if (!(teraflops > 0)) throw new Error('a rate must be positive')
  return flops / (teraflops * 1e12)
}

/** Inference compute per generated token, for the same reason: a count, not a rate. */
export function inferenceFlopsPerToken(parameters) {
  return 2 * parameters
}

/** Everything the CLI and the docs need about one size, with no rate claimed anywhere. */
export function presetReport(sizeId, { tokens = null, contextTokens = null, bytesPerParameter = 2 } = {}) {
  const preset = SIZE_PRESETS[sizeId]
  if (!preset) throw new Error(`unknown size: ${sizeId}`)
  const config = preset.config
  const { valid, violations } = validateArchitecture(config)
  const parameters = parameterCount(config)
  const context = contextTokens ?? config.seqLen
  const trained = tokens === null ? null : {
    tokens,
    tokensPerParameter: tokens / parameters,
    flops: trainingFlops(parameters, tokens),
    stateBytes: trainingStateBytes(parameters),
  }
  return {
    architecture: ARCHITECTURE.id,
    modelId: preset.modelId,
    size: sizeId,
    released: preset.released,
    artifact: preset.artifact,
    training: preset.training ?? null,
    config,
    configDigest: configDigest(config),
    valid,
    violations,
    parameters,
    breakdown: parameterBreakdown(config),
    inferenceFlopsPerToken: inferenceFlopsPerToken(parameters),
    weights: { fp32: weightBytes(parameters, 4), fp16: weightBytes(parameters, 2), int8: weightBytes(parameters, 1), int4: weightBytes(parameters, 0.5) },
    kvCache: { contextTokens: context, bytesPerElement: bytesPerParameter, bytes: kvCacheBytes(config, { contextTokens: context, bytesPerElement: bytesPerParameter }) },
    activationFloor: activationFloorBytes(config, { contextTokens: context }),
    trained,
    recipe: recipeReport(sizeId),
  }
}

/**
 * Problems with the family of presets as a whole, rather than with one config.
 *
 * The ordering rule is what makes the three sizes a family: a "Pro" that is smaller than Lite
 * would be a label with nothing behind it.
 */
export function architectureViolations() {
  const violations = []
  for (const id of SIZE_IDS) {
    const preset = SIZE_PRESETS[id]
    for (const violation of validateArchitecture(preset.config).violations) violations.push(`${id}: ${violation}`)
    if (preset.released && !preset.artifact) violations.push(`${id}: released without a named artifact`)
    if (!preset.released && preset.artifact) violations.push(`${id}: names an artifact ${preset.artifact} but no release has been recorded`)
    if (preset.released && preset.training) violations.push(`${id}: released as ${preset.artifact} and still claims to be training ${preset.training}; a release is not a run in flight`)
    if (preset.training && preset.artifact) violations.push(`${id}: is training ${preset.training} and already names an artifact ${preset.artifact}`)
  }
  for (let i = 1; i < SIZE_IDS.length; i += 1) {
    const previous = SIZE_IDS[i - 1]
    const current = SIZE_IDS[i]
    if (parameterCount(SIZE_PRESETS[current].config) <= parameterCount(SIZE_PRESETS[previous].config)) {
      violations.push(`${current} is not larger than ${previous}; the sizes are not a family`)
    }
  }
  return violations
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`
const giB = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`

/** A human-readable report for the CLI. No throughput is stated; only counts and digests are. */
export function formatArchitecture(sizeId, { tokens = null, contextTokens = null } = {}) {
  const report = presetReport(sizeId, { tokens, contextTokens })
  const lines = []
  lines.push(`${report.modelId} — ${report.architecture}${report.released ? ` (released as ${report.artifact})` : report.training ? ` (training as ${report.training})` : ' (no weights)'}`)
  lines.push(`  config: vocab ${report.config.vocabSize}, d_model ${report.config.dModel}, ${report.config.nLayers} layers, ${report.config.nHeads} heads, d_ff ${report.config.dFf}, context ${report.config.seqLen}${report.config.tieEmbeddings ? ', tied embeddings' : ''}`)
  lines.push(`  digest: ${report.configDigest}`)
  lines.push(`  parameters: ${report.parameters.toLocaleString('en-US')}${report.valid ? '' : ' INVALID — ' + report.violations.join('; ')}`)
  for (const part of report.breakdown) lines.push(`    ${part.parameters.toLocaleString('en-US').padStart(12)}  ${part.part}`)
  lines.push(`  weights:  fp32 ${mb(report.weights.fp32)}, fp16 ${mb(report.weights.fp16)}, int8 ${mb(report.weights.int8)}, int4 ${mb(report.weights.int4)}`)
  lines.push(`  KV cache @ ${report.kvCache.contextTokens} tokens: ${giB(report.kvCache.bytes)} (MHA, no grouped-query attention)`)
  lines.push(`  training floor @ ${report.kvCache.contextTokens} tokens, batch 1, fp32: activations ${giB(report.activationFloor.bytes)}, optimiser ${giB(report.trained ? report.trained.stateBytes.total : trainingStateBytes(report.parameters).total)}`)
  if (report.trained) {
    lines.push(`  if trained on ${report.trained.tokens.toLocaleString('en-US')} tokens (${report.trained.tokensPerParameter.toFixed(1)} per parameter):`)
    lines.push(`    ${report.trained.flops.toExponential(3)} FLOPs (6ND) — at an assumed rate:`)
    for (const rate of [0.25, 2, 5, 20, 100]) {
      const seconds = secondsAt(report.trained.flops, rate)
      lines.push(`      ${String(rate).padStart(5)} TFLOP/s -> ${(seconds / 3600).toFixed(1)} h`)
    }
    lines.push('    the rates above are assumptions, not measurements: this host has no accelerator to measure.')
  }
  lines.push(`  recipe: ${report.recipe.filter((s) => s.status === RECIPE_STATES.SATISFIED).length} of ${report.recipe.length} steps satisfied`)
  for (const step of report.recipe) {
    lines.push(`    ${step.status === RECIPE_STATES.SATISFIED ? '[x]' : '[ ]'} ${step.label}`)
    lines.push(`        ${step.status === RECIPE_STATES.SATISFIED ? 'evidence' : 'open'}: ${step.status === RECIPE_STATES.SATISFIED ? step.evidence : step.reason}`)
  }
  return lines.join('\n')
}
