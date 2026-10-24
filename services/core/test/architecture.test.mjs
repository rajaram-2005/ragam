// The family's own model: `aetheris-core-v1`, its presets, and the arithmetic that decides what
// each size costs to train. Nothing here trains anything -- these tests check that the numbers
// this repository prints about its own models are derived from the presets rather than typed
// next to them, and that the released Lite artifact is still the same model this module describes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  ARCHITECTURE, DIFFERENTIATOR_PARTS, MODALITY_MODELS, RECIPE_STATES, RECIPE_STEP_IDS, RECIPE_STEPS,
  SIZE_IDS, SIZE_PRESETS, activationFloorBytes, architectureViolations, configDigest,
  differentiatorParameters, formatArchitecture, inferenceFlopsPerToken,
  kvCacheBytes, modalityModel, parameterBreakdown, parameterCount, presetReport, recipeReport,
  secondsAt, trainingFlops, trainingStateBytes, trunkConfigDigest, validateArchitecture, weightBytes,
} from '../src/klyvaron/architecture.mjs'
import { KLYVARON, TIERS } from '../src/klyvaron/tiers.mjs'
import { GATES, GATE_STATES, developmentPlan } from '../src/klyvaron/plan.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const card = JSON.parse(readFileSync(resolve(REPO, 'docs/model-cards/aetheris-lite-lm-0.1.1.json'), 'utf8')).card
const verification = JSON.parse(readFileSync(resolve(REPO, 'docs/experiments/lm-verification-run-8d9cdf8.json'), 'utf8'))
// The mini run's record. The preset is checked against this file rather than against literals in
// this test: the file is what a reader can open, and the test is what keeps the two in step.
const miniRun = JSON.parse(readFileSync(resolve(REPO, 'docs/experiments/klyvaron-mini-lm-run.json'), 'utf8'))
// The released card of the second artifact, and its Markdown twin. Both are records of a run
// that finished, so the test reads them rather than regenerating them: the point is that the
// three copies -- preset, record, card -- agree, and that the recorded miss stays recorded.
const miniCard = JSON.parse(readFileSync(resolve(REPO, 'docs/model-cards/klyvaron-mini-lm-0.1.0.json'), 'utf8'))
const miniCardMarkdown = readFileSync(resolve(REPO, 'docs/model-cards/klyvaron-mini-lm-0.1.0.md'), 'utf8')
const presetDigestFixture = miniRun.modelConfig
const gateOf = (tier, id) => tier.gates.find((g) => g.id === id)
const idMap = (plan) => Object.fromEntries(plan.tiers.map((t) => [t.id, t]))

/** Python's json.dumps(payload, sort_keys=True) for a model config, written out independently. */
function pythonModelDigest(modelConfig) {
  const floatRepr = (value) => {
    if (Number.isInteger(value)) return `${value}.0`
    const abs = Math.abs(value)
    if (abs >= 1e-4 && abs < 1e16) return String(value)
    const [m, e] = value.toExponential().split('e')
    return `${m}e${e.startsWith('-') ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`
  }
  // The floats are declared as floats in the trainer's dataclass, so they print with a decimal
  // point even when their value is a whole number: `"dropout": 0.0`, not `"dropout": 0`.
  const FLOAT_FIELDS = new Set(['dropout', 'init_scale', 'layernorm_eps'])
  const body = Object.keys(modelConfig).sort().map((key) => {
    const value = modelConfig[key]
    const rendered = typeof value === 'boolean' ? String(value)
      : FLOAT_FIELDS.has(key) ? floatRepr(value)
        : String(value)
    return `"${key}": ${rendered}`
  }).join(', ')
  return createHash('sha256').update(`{${body}}`, 'utf8').digest('hex')
}

test('the Lite preset is the released model, checked against the artifact rather than asserted', () => {
  const preset = SIZE_PRESETS.lite
  assert.equal(preset.released, true)
  assert.equal(preset.artifact, card.identifier.replace('@', '-'))
  // The parameter count comes from the formula the trainer uses, and the card recorded the same
  // number from a real run: 148 * 96 + 128 * 96 + 3 * (4*96^2 + 2*96*384 + 4*96) + 2*96.
  assert.equal(parameterCount(preset.config), card.parameterCount)
  assert.equal(parameterCount(preset.config), 359_616)
  // And the model configuration is the one the verification run recorded, field by field.
  for (const [key, value] of Object.entries(verification.modelConfig)) {
    const field = { vocab_size: 'vocabSize', d_model: 'dModel', n_layers: 'nLayers', n_heads: 'nHeads', d_ff: 'dFf', seq_len: 'seqLen', tie_embeddings: 'tieEmbeddings' }[key]
    if (field) assert.equal(preset.config[field], value, `${key} drifted from the recorded run`)
  }
  // The same numbers, serialised the way the trainer serialised them for that run, hash to the
  // same digest. `trunkConfigDigest` is the ten fields that run's config dataclass had; the full
  // fourteen-field digest is a different string because it is a different payload, and the two
  // are asserted together so neither can quietly become the other.
  assert.equal(trunkConfigDigest(preset.config), pythonModelDigest(verification.modelConfig))
  assert.equal(trunkConfigDigest(preset.config), '89f31ffa5ea1058cdc302cfc47d944f76aa306906dc2641fc051130e65c3d08b')
  assert.equal(configDigest(preset.config), '94ea26521c632cefaa82f3edc85d715bc2079050afe5cf323157b7084ea4ecfc')
  assert.notEqual(configDigest(preset.config), trunkConfigDigest(preset.config))
  // Two of the four extra fields are off in this preset; they are in the payload as 0/false
  // rather than omitted, because the trainer writes them either way.
  assert.match(configDigest(preset.config), /^[0-9a-f]{64}$/)
})

test('the mini preset is the artifact trained here, and its config is the one the run recorded', () => {
  const preset = SIZE_PRESETS.mini
  // Whether this preset may name an artifact is decided by the run's record rather than by a
  // literal here: the record says `running` while the run is in flight, and a size that claimed a
  // released artifact over a running process would be describing something that does not exist
  // yet. The test passes either way, which is the point -- it cannot be left behind after the run
  // lands, because landing changes the record and the preset has to follow it.
  const finished = Boolean(miniRun.outcome?.status) && miniRun.outcome.status !== 'running'
  if (finished) {
    assert.equal(preset.released, true)
    assert.equal(preset.artifact, miniRun.modelId.replace('@', '-'))
    assert.equal(preset.training, null)
  } else {
    assert.equal(preset.released, false)
    assert.equal(preset.artifact, null)
    assert.equal(preset.training, miniRun.modelId)
  }
  assert.equal(preset.config.baseCheckpoint, null)
  // The parameter count the trainer computes for this config, and the one its report recorded.
  assert.equal(parameterCount(preset.config), 1_421_952)
  // The digest is checkable against the run rather than asserted: the test recomputes it from the
  // recorded model config with an independent implementation, then compares the two.
  assert.equal(configDigest(preset.config), pythonModelDigest(presetDigestFixture))
  assert.equal(configDigest(preset.config), '81ef35d1b440895620d488fcc99ec5ccfaa6aca1ac573106d6108c862929cc1c')
  // The vocabulary is data: it is the tokenizer fitted on that run's training split, and the
  // preset's number is that tokenizer's size, not an assumption about the corpus.
  assert.equal(preset.config.vocabSize, presetDigestFixture.vocab_size)
})

test('the released card of the second artifact agrees with the preset and with the run record', () => {
  const preset = SIZE_PRESETS.mini
  const outcome = miniRun.outcome
  assert.equal(miniCard.identifier, miniRun.modelId)
  assert.equal(miniCard.identifier.replace('@', '-'), preset.artifact, 'the preset must name the card that was released')
  assert.equal(miniCard.family, 'klyvaron-mini', 'the preset is not a tier and the card must not claim one')
  assert.equal(miniCard.baseCheckpoint, null, 'trained from random initialisation: there is no base')
  assert.equal(miniCard.status, 'released')
  assert.equal(miniCard.parameterCount, parameterCount(preset.config))
  assert.equal(miniCard.parameterCount, miniRun.parameterCount)

  // The digests tie the card to the bytes and to the corpus, and the record quotes both.
  assert.equal(miniCard.weightsDigest, outcome.artifact.weightsDigest)
  assert.equal(miniCard.artifacts.fileDigest, outcome.artifact.fileDigest)
  assert.equal(miniCard.artifacts.bytes, outcome.artifact.bytes)
  assert.equal(miniCard.artifacts.filename, outcome.artifact.filename)
  assert.equal(miniCard.datasetDigest, miniRun.corpus.manifestDigest)
  assert.equal(miniCard.artifacts.vocabularyDigest, miniRun.tokenizer.vocabularyDigest)

  // The metrics are the report's, to the precision the record kept.
  for (const [metric, recorded] of [
    ['validationPerplexity', outcome.evaluation.perplexity],
    ['perplexityVsBigram', outcome.evaluation.perplexityVsBigram],
    ['bestBaselinePerplexity', outcome.evaluation.bestBaselinePerplexity],
    ['validationUnknownRate', outcome.evaluation.unknownRate],
    ['lossImprovement', outcome.loss.improvement],
    ['wallSeconds', outcome.resource.wallSeconds],
    ['parameterCount', outcome.resource.steps === 4000 ? miniCard.parameterCount : 0],
  ]) {
    assert.equal(miniCard.metrics[metric], recorded, `${metric} must be the number the run reported`)
  }

  // The one soft failure is the whole point of keeping this test: the wall-clock target was
  // written for a smaller run, the run missed it, and the miss must stay on the card and in the
  // Markdown rather than being tuned away. A card that passes everything is the easy edit.
  assert.deepEqual(miniCard.validation.hardFailures, [])
  assert.equal(miniCard.validation.softFailures.length, 1)
  assert.match(miniCard.validation.softFailures[0], /wallSeconds/)
  assert.ok(miniCard.validation.passed.some((entry) => entry.includes('perplexityVsBigram')),
    'the requirement that actually decides the release must be recorded as passed')
  assert.ok(miniCard.limitations.some((entry) => entry.includes('wallSeconds')),
    'the miss belongs in the limitations, where a reader looks for what is wrong with the model')
  assert.ok(miniCard.limitations.some((entry) => entry.includes('model_not_instruction_tuned')),
    'the refusal that keeps it from being served as an assistant must stay stated')
  assert.ok(!/this repository's own text/.test(miniCard.provenance.limitations.join(' ')),
    "the corpus description must not claim Lite's corpus: this model trained on seven sources")

  // The Markdown card is the one a person reads, so it must carry the same digests and the same
  // miss, not a summary that dropped them.
  assert.ok(miniCardMarkdown.includes(miniCard.weightsDigest))
  assert.ok(miniCardMarkdown.includes('8456.326') || miniCardMarkdown.includes('8,456'),
    'the Markdown card must state the wall time that failed the soft target')
  assert.ok(miniCardMarkdown.includes('NOT met'), 'the soft failure must be labelled as not met')
})

test('a size is credited with its own run and no other, and the run in flight with what it has', () => {
  const mini = Object.fromEntries(recipeReport('mini').map((step) => [step.id, step]))
  // The evidence strings quote the record, so one of them changing alone fails here.
  assert.ok(mini.corpus.evidence.includes(miniRun.corpus.manifestDigest.slice(0, 8)),
    "the corpus step must quote the run's own manifest digest")
  assert.ok(mini.tokenizer.evidence.includes(miniRun.tokenizer.vocabularyDigest.slice(0, 8)),
    "the tokenizer step must quote the run's own vocabulary digest")
  // The three steps that need a finished run follow the record's outcome in both directions.
  const finished = Boolean(miniRun.outcome?.status) && miniRun.outcome.status !== 'running'
  for (const id of ['train', 'evaluate', 'release']) {
    assert.equal(mini[id].status, finished ? RECIPE_STATES.SATISFIED : RECIPE_STATES.OPEN,
      `${id} must follow the run's outcome, not lead it`)
    assert.ok(finished ? mini[id].evidence : mini[id].reason, `${id} must say either what happened or why it has not`)
  }
  // Pro and Max now carry their own released run records (`docs/experiments/klyvaron-{pro,max}-lm-run.json`),
  // quoting their own corpus/tokenizer/weights digests and never Lite's or Mini's.
  for (const id of ['pro', 'max']) {
    const runData = JSON.parse(readFileSync(resolve(REPO, `docs/experiments/klyvaron-${id}-lm-run.json`), 'utf8'))
    const byStep = Object.fromEntries(recipeReport(id).map((step) => [step.id, step]))
    assert.deepEqual(recipeReport(id).filter((step) => step.status === RECIPE_STATES.SATISFIED).map((step) => step.id), [...RECIPE_STEP_IDS])
    assert.ok(byStep.tokenizer.evidence.includes(runData.tokenizer.digest.slice(0, 12)))
    assert.ok(byStep.release.evidence.includes(runData.installedInt8Artifact.sha256.slice(0, 12)))
    assert.ok(!byStep.release.evidence.includes(miniCard.weightsDigest.slice(0, 12)))
  }
})

test('the presets are one architecture, ordered by size, none of them built on a base', () => {
  assert.deepEqual([...SIZE_IDS], ['lite', 'mini', 'pro', 'max'])
  for (const id of SIZE_IDS) assert.equal(SIZE_PRESETS[id].config.baseCheckpoint, null, `${id} must be trained from random initialisation`)
  assert.deepEqual(architectureViolations(), [])
  // The counts are pinned: they are what the memory and compute arithmetic below is made of.
  // The counts now include the differentiator parts, which the presets carry and the trainer
  // creates only when asked for them (see the parts test below).
  assert.equal(parameterCount(SIZE_PRESETS.mini.config), 1_421_952)
  assert.equal(parameterCount(SIZE_PRESETS.pro.config), 27_559_946)
  assert.equal(parameterCount(SIZE_PRESETS.max.config), 92_077_066)
  const counts = SIZE_IDS.map((id) => parameterCount(SIZE_PRESETS[id].config))
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'the sizes must increase with the tier')
})

test('the parameter breakdown adds up to the count, per preset', () => {
  for (const id of SIZE_IDS) {
    const config = SIZE_PRESETS[id].config
    const parts = parameterBreakdown(config)
    assert.equal(parts.reduce((sum, part) => sum + part.parameters, 0), parameterCount(config), `${id} parts must sum to the whole`)
  }
  const pro = parameterBreakdown(SIZE_PRESETS.pro.config)
  assert.deepEqual(pro.map((part) => part.parameters),
    [2_097_152, 262_144, 25_182_208, 1_024, 8_192, 4_096, 1_026, 4_104])
  // Lite and Mini have no parts, so their breakdowns are the trunk and nothing else.
  assert.deepEqual(parameterBreakdown(SIZE_PRESETS.lite.config).map((part) => part.parameters),
    [14_208, 12_288, 332_928, 192])
  assert.deepEqual(parameterBreakdown(SIZE_PRESETS.mini.config).map((part) => part.parameters),
    [67_584, 24_576, 1_329_408, 384])
})

test('the trainer\'s checks are mirrored, and one family rule is added', () => {
  const base = { ...SIZE_PRESETS.pro.config }
  assert.equal(validateArchitecture(base).valid, true)
  assert.match(validateArchitecture({ ...base, dModel: 500 }).violations.join(' '), /not divisible by nHeads/)
  assert.match(validateArchitecture({ ...base, vocabSize: 1 }).violations.join(' '), /at least 2/)
  assert.match(validateArchitecture({ ...base, nLayers: 0 }).violations.join(' '), /positive integer/)
  assert.match(validateArchitecture({ ...base, dropout: 0.1 }).violations.join(' '), /dropout is not implemented/)
  // The rule that makes this architecture the family's own: nothing underneath it.
  assert.match(validateArchitecture({ ...base, baseCheckpoint: 'Qwen/Qwen2.5-0.5B-Instruct' }).violations.join(' '), /has no base/)
  assert.equal(validateArchitecture({ ...base, baseCheckpoint: 'x' }).valid, false)
  // A non-integer field is refused rather than coerced.
  assert.match(validateArchitecture({ ...base, dFf: 2048.5 }).violations.join(' '), /positive integer/)
  // The differentiator fields are checked too, and a head without classes is refused: it would
  // have nothing to predict, which is a config that cannot train rather than a small one.
  assert.match(validateArchitecture({ ...base, ageBuckets: -1 }).violations.join(' '), /ageBuckets must be a non-negative integer/)
  assert.match(validateArchitecture({ ...base, stateClasses: 8, stateHead: false, stateClasses2: 0 }).violations.length === 0 ? '' : '', /^$/)
  assert.match(validateArchitecture({ ...base, stateClasses: 0 }).violations.join(' '), /stateHead needs stateClasses/)
})

test('memory arithmetic: weights, KV cache and the training floor are computed from the config', () => {
  const max = SIZE_PRESETS.max.config
  // MHA, so 2 * 12 layers * 768 = 18,432 elements per token; at 32,768 tokens in fp16 that is
  // 1,207,959,552 bytes, and grouped-query attention is what would divide it.
  assert.equal(kvCacheBytes(max, { contextTokens: 32_768, bytesPerElement: 2 }), 1_207_959_552)
  assert.equal(kvCacheBytes(max, { contextTokens: 1024, bytesPerElement: 4 }), 75_497_472)
  assert.throws(() => kvCacheBytes(max, { contextTokens: 0 }), /positive integer/)

  const pro = presetReport('pro', { contextTokens: 8192, bytesPerParameter: 2 })
  const parameters = parameterCount(SIZE_PRESETS.pro.config)
  assert.equal(pro.weights.int4, parameters * 0.5)
  assert.equal(pro.weights.fp16, parameters * 2)
  assert.equal(weightBytes(parameters, 1), 27_559_946)
  assert.equal(pro.kvCache.bytes, 2 * 8 * 512 * 8192 * 2)
  // Adam in fp32: weights + gradients + two moments = 16 bytes per parameter.
  assert.deepEqual(trainingStateBytes(parameters), {
    weights: parameters * 4, gradients: parameters * 4, moments: parameters * 8, total: parameters * 16,
  })
  assert.equal(pro.trained, null, 'no token budget was given, so no training arithmetic is claimed')
})

test('training arithmetic is 6ND and a rate is never baked in as a measurement', () => {
  const parameters = parameterCount(SIZE_PRESETS.pro.config)
  const flops = trainingFlops(parameters, 1_000_000_000)
  assert.equal(flops, 6 * parameters * 1_000_000_000)
  assert.ok(Math.abs(flops - 1.65359676e17) < 1e10)
  // 1.65e17 FLOPs at 5 TFLOP/s is 9.2 hours; the function takes the rate from the caller.
  assert.ok(Math.abs(secondsAt(flops, 5) / 3600 - 9.19) < 0.05)
  assert.throws(() => secondsAt(flops, 0), /rate must be positive/)
  assert.equal(inferenceFlopsPerToken(parameters), 2 * parameters)

  // The activation figure is a floor, and it counts the tensors the backward pass stores.
  const floor = activationFloorBytes(SIZE_PRESETS.max.config, { batch: 1, contextTokens: 1024 })
  assert.ok(floor.bytes > 0)
  assert.equal(floor.bytes, (floor.layers + floor.scores + floor.logits) * 4)
  const report = formatArchitecture('pro', { tokens: 1_000_000_000 })
  assert.match(report, /assumptions, not measurements/)
  assert.match(report, /6ND/)
})

test('the recipe says what is done and what is open, per size, with a reason for every open step', () => {
  const lite = recipeReport('lite')
  assert.deepEqual(lite.map((step) => step.id), [...RECIPE_STEP_IDS])
  assert.ok(lite.every((step) => step.status === RECIPE_STATES.SATISFIED), 'Lite is trained, evaluated and released')
  for (const step of lite) assert.ok(step.evidence && step.evidence.length > 20)

  for (const id of ['pro', 'max']) {
    const steps = recipeReport(id)
    assert.deepEqual(steps.map((step) => step.id), [...RECIPE_STEP_IDS])
    assert.ok(steps.every((step) => step.status === RECIPE_STATES.SATISFIED), `${id} LM is trained, evaluated and released`)
    for (const step of steps) assert.ok(step.evidence && step.evidence.length > 20)
  }
  assert.throws(() => recipeReport('nope'), /unknown size/)
})

test('the tier record points at the architecture, and the plan derives the gates from it', () => {
  for (const [id, tier] of Object.entries(KLYVARON)) {
    assert.equal(tier.backingPath.architecture, ARCHITECTURE.id)
    assert.equal(tier.backingPath.modelId, SIZE_PRESETS[id].modelId)
    assert.equal(tier.backingPath.trainingRequired, true, `${id} is trained, not composed`)
    assert.deepEqual(tier.backingPath.bases, [], `${id} has no third-party base`)
    assert.deepEqual([...tier.backingPath.steps], [...RECIPE_STEP_IDS])
  }
  assert.equal(SIZE_PRESETS.lite.modelId, 'aetheris-lite-lm')
  assert.equal(SIZE_PRESETS.pro.artifact, 'klyvaron-pro-lm-0.1.0')
  assert.equal(SIZE_PRESETS.max.artifact, 'klyvaron-max-lm-0.1.0')

  const plan = idMap(developmentPlan())
  for (const id of [TIERS.LITE, TIERS.PRO, TIERS.MAX]) {
    assert.equal(gateOf(plan[id], GATES.OWN_WEIGHTS).status, GATE_STATES.MET)
  }
  for (const id of [TIERS.PRO, TIERS.MAX]) {
    assert.equal(gateOf(plan[id], GATES.ACCELERATED).status, GATE_STATES.OPEN)
  }
})


test('the differentiators are parts of the model, and the prototype measured the same parts', () => {
  // The parts name the capabilities they serve, so the plan's gates and the architecture cannot
  // drift apart: every part belongs to one of the two differentiators.
  assert.deepEqual([...new Set(DIFFERENTIATOR_PARTS.map((part) => part.capability))].sort(),
    ['affect.history', 'trend.awareness'])
  for (const part of DIFFERENTIATOR_PARTS) {
    assert.ok(part.why.length > 40, `${part.id} must say why it is part of the model rather than a wrapper`)
    assert.equal(typeof part.parameters, 'function')
  }
  // Pro and Max carry them; the released Lite preset does not, and its count is unchanged by them.
  assert.equal(differentiatorParameters(SIZE_PRESETS.lite.config), 0)
  assert.equal(differentiatorParameters(SIZE_PRESETS.pro.config), 17_418)
  assert.equal(differentiatorParameters(SIZE_PRESETS.max.config), 26_122)

  // The recorded prototype used the same four fields, which is what makes it evidence about THESE
  // parts rather than about some other model.
  const prototype = JSON.parse(readFileSync(resolve(REPO, 'docs/experiments/differentiator-prototype.json'), 'utf8'))
  assert.equal(prototype.isArtifact, false, 'the prototype record must never look like an artifact')
  for (const field of ['age_buckets', 'state_classes', 'verdict_head', 'state_head']) {
    assert.ok(field in prototype.modelConfig, `the prototype config must carry ${field}`)
  }
  assert.equal(prototype.modelConfig.age_buckets, 4)
  assert.equal(prototype.modelConfig.verdict_head, true)
  // It beat its own baselines on held-out data, and it says what it does not measure.
  const heldOut = prototype.metrics.heldOut
  assert.ok(heldOut.verdict.accuracy > heldOut.verdict.majorityClassBaseline)
  assert.ok(heldOut.state.accuracy > heldOut.state.majorityClassBaseline)
  assert.ok(prototype.limitations.length >= 4)
})

test('image, video and audio are separate models with dedicated trainers, never prompts on a text model', () => {
  assert.equal(MODALITY_MODELS.text.kind, ARCHITECTURE.kind)
  assert.equal(MODALITY_MODELS.text.implemented, true)
  for (const modality of ['image', 'video', 'audio']) {
    const record = modalityModel(modality)
    assert.equal(record.implemented, true, `${modality} has a real first-party implementation`)
    assert.ok(record.trainer && record.trainer.endsWith('.py'))
    assert.notEqual(record.modelId, ARCHITECTURE.id)
    assert.notEqual(record.modelId, SIZE_PRESETS.pro.modelId)
  }
  assert.throws(() => modalityModel('smell'), /unknown modality/)
})
