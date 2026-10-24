// The Klyvaron model family: three separated status systems, and the rules that keep them honest.
//
// THREE STRICTLY SEPARATED STATUS SYSTEMS (Directive Phase 1):
//
//   1. `PRODUCT_SUBSCRIPTION_TIERS` — Commercial plan & entitlement definitions (`lite`, `pro`,
//      `max`). A subscription tier describes commercial access and target deployment class; it
//      NEVER implies that weights exist, are installed, or execute on a given machine.
//
//   2. `KLYVARON_MODEL_IDENTITIES` — Exact first-party model identities (`id`, `version`,
//      `architecture`, `parameters`, `weightsDigest`, `artifactSha256`, `provenance`, `licence`,
//      `cardPath`, `runRecordPath`, `supportedTasks`, `unsupportedTasks`, `measured`, and
//      `limitations`). Every model here is trained from random initialisation (`baseModel: null`).
//
//   3. `RUNTIME_READINESS_STATES` & `deriveRuntimeCapabilityReadiness()` — What actually runs on
//      a specific deployment (`ready`, `partially_available`, `missing_artifact`,
//      `runtime_unqualified`, `training_required`, `unsupported_hardware`). Development-host
//      hardware is NEVER treated as global proof that user computers lack GPUs: user computers
//      qualify their own backends (`cuda`, `rocm`, `metal`, `cpu`) via `RuntimeQualificationRegistry`.

import { BACKING_PATHS, backingPathViolations } from './composition.mjs'
import { ARCHITECTURE, RECIPE_STEP_IDS, SIZE_PRESETS } from './architecture.mjs'

export const TIERS = Object.freeze({ LITE: 'lite', PRO: 'pro', MAX: 'max' })

/**
 * Runtime capability readiness states for a specific deployment or paired local worker.
 * Distinct from commercial plan tier and from static model card existence.
 */
export const RUNTIME_READINESS_STATES = Object.freeze({
  READY: 'ready',
  PARTIALLY_AVAILABLE: 'partially_available',
  MISSING_ARTIFACT: 'missing_artifact',
  RUNTIME_UNQUALIFIED: 'runtime_unqualified',
  TRAINING_REQUIRED: 'training_required',
  UNSUPPORTED_HARDWARE: 'unsupported_hardware',
})

/**
 * Derive runtime readiness strictly from verified artifact presence, qualification evidence,
 * hardware compatibility, and subtask coverage — never from labels or host assumptions.
 */
export function deriveRuntimeCapabilityReadiness({
  artifactPresent = false,
  digestVerified = false,
  qualification = null,
  trainingRequired = false,
  hardwareSupported = true,
  openSubtasks = [],
} = {}) {
  if (!hardwareSupported) return RUNTIME_READINESS_STATES.UNSUPPORTED_HARDWARE
  if (trainingRequired && !artifactPresent) return RUNTIME_READINESS_STATES.TRAINING_REQUIRED
  if (!artifactPresent || !digestVerified) return RUNTIME_READINESS_STATES.MISSING_ARTIFACT
  if (!qualification || qualification.qualified !== true) return RUNTIME_READINESS_STATES.RUNTIME_UNQUALIFIED
  if (Array.isArray(openSubtasks) && openSubtasks.length > 0) return RUNTIME_READINESS_STATES.PARTIALLY_AVAILABLE
  return RUNTIME_READINESS_STATES.READY
}

/**
 * Where a capability claim stands in the family record.
 */
export const CAPABILITY_STATES = Object.freeze({
  AVAILABLE: 'available',
  REQUIRES_DOWNLOAD: 'requires_download',
  REQUIRES_GPU: 'requires_gpu',
  REQUIRES_CREDENTIALS: 'requires_credentials',
  UNAVAILABLE: 'unavailable',
})

/** How a model came to exist. Required, and load-bearing for licence compliance. */
export const PROVENANCE = Object.freeze({
  FROM_SCRATCH: 'from_scratch',
  FINE_TUNED: 'fine_tuned',
  DERIVED: 'derived',
  THIRD_PARTY: 'third_party',
})

/**
 * Family tier completion state, derived programmatically from capability claims.
 * A tier may NEVER be `available` while any named capability remains unavailable.
 */
export const TIER_STATUS = Object.freeze({
  AVAILABLE: 'available',
  PARTIAL: 'partial',
  UNBUILT: 'unbuilt',
})

/** Programmatically derive tier completion status from capability claims without overrides. */
export function deriveTierStatus(capabilities) {
  const claims = Object.values(capabilities ?? {})
  const availableCount = claims.filter((c) => c.state === CAPABILITY_STATES.AVAILABLE && c.backing).length
  if (availableCount === 0) return TIER_STATUS.UNBUILT
  if (availableCount === claims.length) return TIER_STATUS.AVAILABLE
  return TIER_STATUS.PARTIAL
}

/** Hardware classes, so an adapter can be matched to a device by measurement. */
export const HARDWARE_CLASS = Object.freeze({
  MOBILE: 'mobile',
  LAPTOP: 'laptop',
  DESKTOP: 'desktop',
  WORKSTATION: 'workstation',
  REMOTE: 'remote',
})

/**
 * System 1 of 3: Commercial / product subscription tiers.
 * Commercial entitlements only; carries `weightsImplied: false` so no caller can read a plan
 * definition as evidence that models are installed or qualified on a device.
 */
export const PRODUCT_SUBSCRIPTION_TIERS = Object.freeze({
  [TIERS.LITE]: Object.freeze({
    id: TIERS.LITE,
    kind: 'product_subscription_tier',
    displayName: 'Klyvaron Lite Plan',
    targetHardware: HARDWARE_CLASS.MOBILE,
    weightsImplied: false,
    entitlements: Object.freeze(['local.text.completion', 'local.text.extract']),
    summary: 'Constrained-device local tier for mobile and compact deployments.',
  }),
  [TIERS.PRO]: Object.freeze({
    id: TIERS.PRO,
    kind: 'product_subscription_tier',
    displayName: 'Klyvaron Pro Plan',
    targetHardware: HARDWARE_CLASS.LAPTOP,
    weightsImplied: false,
    entitlements: Object.freeze([
      'local.chat',
      'local.image.generate',
      'local.image.edit',
      'local.vision.understand',
      'local.video.generate',
      'local.video.understand',
      'local.speech.transcribe',
      'local.speech.synthesize',
      'local.training.user_worker',
    ]),
    summary: 'Laptop and desktop tier for first-party local chat, image, short-clip video, voice, and user-authorized training.',
  }),
  [TIERS.MAX]: Object.freeze({
    id: TIERS.MAX,
    kind: 'product_subscription_tier',
    displayName: 'Klyvaron Max Plan',
    targetHardware: HARDWARE_CLASS.WORKSTATION,
    weightsImplied: false,
    entitlements: Object.freeze([
      'local.chat',
      'local.image.generate',
      'local.image.edit',
      'local.vision.understand',
      'local.video.generate',
      'local.video.understand',
      'local.speech.transcribe',
      'local.speech.synthesize',
      'local.training.user_worker',
      'local.training.foundation_pretrain',
    ]),
    summary: 'Workstation tier pairing higher-capacity first-party checkpoints across chat, image, short-clip video, and voice with user-computer qualification.',
  }),
})

/** Directive §5A mobile storage targets, in bytes. Decimal GB, the stricter reading. */
export const MOBILE_TARGETS = Object.freeze({
  appPackageBytes: 200 * 1000 ** 2,
  primaryModelBytes: 1.5 * 1000 ** 3,
  managedTotalBytes: 5 * 1000 ** 3,
  reserveBytes: 500 * 1000 ** 2,
})

export const FAMILY_STANCE = Object.freeze({
  competitive: false,
  objective: 'Understand the present and the person. A tier is judged on whether its answers '
    + 'are still true today and on whether it tracks what the user actually expressed -- not on '
    + 'beating another vendor.',
  differentiators: Object.freeze(['trend.awareness', 'affect.history']),
  measures: Object.freeze([
    'Whether an answer states the observation date and the source, and abstains when the '
      + 'observation is older than the window it was asked about.',
    'Whether a change in the user\'s expressed state is quoted from their own message, with the '
      + 'message cited, and abstains when they said nothing about how they feel.',
  ]),
  forbiddenClaims: Object.freeze([
    'A benchmark win over a named or unnamed competitor.',
    'A quality improvement inferred from a tier label, a version number or a parameter count.',
    'A feeling, mood or diagnosis the user did not express.',
  ]),
  allowedComparisons: Object.freeze([
    'A baseline computed on the same data by this repository (uniform, unigram, bigram, dense-only).',
    'An earlier artifact of this family, on the same metric and the same workload.',
  ]),
})

export const COMPETITOR_MARKERS = Object.freeze([
  'openai', 'chatgpt', 'gpt-4', 'gpt-5', 'claude', 'anthropic', 'gemini', 'deepseek',
  'mistral', 'llama', 'grok', 'qwen', 'phi-', 'command r',
])

export function stanceViolations(text, where) {
  if (typeof text !== 'string' || !text) return []
  const lowered = text.toLowerCase()
  const found = COMPETITOR_MARKERS.filter((marker) => lowered.includes(marker))
  return found.length
    ? [`${where}: names ${found.join(', ')}, which the stance forbids comparing against. `
       + 'Allowed comparisons are computed baselines and this family\'s own earlier artifacts.']
    : []
}

/**
 * Which modality a capability belongs to, so one artifact can never silently serve two.
 */
export const MODALITY_ROLES = Object.freeze({
  'text.completion': 'text',
  'text.extract': 'text',
  'text.summarize': 'text',
  'text.translate': 'text',
  'text.rewrite': 'text',
  chat: 'text',
  'reasoning.light': 'text',
  'reasoning.complex': 'text',
  'coding.assist': 'text',
  'coding.repository': 'text',
  'research.synthesis': 'text',
  'documents.analyze': 'text',
  'data.analyze': 'text',
  structured_output: 'text',
  'agent.coordination': 'text',
  'trend.awareness': 'text',
  'affect.history': 'text',
  'vision.understand': 'image',
  'image.generate': 'image',
  'image.edit': 'image',
  'video.generate': 'video',
  'video.understand': 'video',
  'speech.transcribe': 'audio',
  'speech.synthesize': 'audio',
  'multimodal.understanding': 'multimodal',
})

export function modalityOf(capability) {
  return MODALITY_ROLES[capability] ?? `unknown:${capability}`
}

/** Modalities whose artifacts must be distinct from the text artifact and from one another. */
export const SEPARATE_MODALITIES = Object.freeze(['image', 'video', 'audio'])

export class ModelFamilyError extends Error {
  constructor(message, violations = []) {
    super(message)
    this.name = 'ModelFamilyError'
    this.code = 'model_family_violation'
    this.violations = violations
  }
}

const differentiatorCapabilities = () => ({
  'trend.awareness': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open gate: the age-bucket conditioning table and grounding verdict head are trained inside '
      + 'klyvaron-pro-lm and klyvaron-max-lm, and klyvaron/trends.mjs is tested, while live dated external '
      + 'source ingestion and real-world held-out dated QA scoring remain open.',
    acceptance: [
      'Every answer that rests on a current fact states the observation date and its source.',
      'An observation older than the requested window is reported as stale and the model abstains '
        + 'instead of asserting it.',
      'A held-out set of dated questions is scored, and a stale-source answer counts as wrong.',
    ],
  },
  'affect.history': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open gate: the session state conditioning table and abstaining state head are trained inside '
      + 'klyvaron-pro-lm and klyvaron-max-lm, and klyvaron/affect.mjs enforces consent-scoped citations, '
      + 'while held-out evaluation on real multi-turn user transcripts remains open.',
    acceptance: [
      'A state is reported only when the user expressed it, and the message it came from is cited.',
      'With nothing expressed in the window the result is an abstention, never a guess.',
      'Nothing is reported as a diagnosis and no state is inferred from writing style.',
      'Signals are scoped to one user, kept only with that user\'s consent, and removed together '
        + 'with the message they came from.',
    ],
  },
})

const LITE_BACKING = Object.freeze({
  artifact: 'aetheris-lite-lm-0.1.1',
  kind: 'language_model',
  parameters: 359_616,
  weightsDigest: '53ae59b2a777be9d22f1f04b6cbc94aee3dad6144ac40e4e25c12f900164b60c',
  artifactSha256: '165e150f6e290fe3a8162673f743037dcf15a3b63199ecd7661bdbc83652b6f7',
  artifactBytes: 1_446_862,
  alsoKnownAs: Object.freeze(['aetheris-lite-lm-0.1.1-verify']),
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  vocabularySize: 148,
  contextTokens: 128,
  quantization: 'none (float32 NumPy)',
  trainingCorpus: "this repository's own text at 8d9cdf8, whole-file split",
  measured: {
    validationPerplexity: 4.893185177076384,
    bitsPerCharacter: 2.2907738809713725,
    perplexityVsBestBaseline: 0.31050497433169066,
    bestBaselinePerplexity: 15.758798027658449,
    bestBaseline: 'bigram',
    validationTokens: 280_192,
    validationUnknownRate: 1.0705339109458524e-05,
    lossImprovement: 3.380646228790283,
    parameterCount: 359_616,
    wallSeconds: 2062.942,
  },
  benchmarks: [
    {
      name: 'held-out next-token perplexity vs computed baselines',
      protocol: 'character-level, whole-file split, 280,192 validation tokens, seeds 0/0/20251012',
      result: '4.8932 against a bigram baseline of 15.7588 (3.22x better)',
    },
  ],
  limitations: [
    'It does not follow instructions. It continues text.',
    'Its output is not fluent and must not be presented as a chat answer.',
    'It is far too small to meet the Klyvaron Lite capability targets below; only the '
      + 'storage target is met, and it is met by being undersized.',
    'Trained on this repository\'s text, so it reproduces that text distribution and nothing else.',
  ],
  supersededArtifact: Object.freeze({
    artifact: 'aetheris-lite-lm-0.1.0',
    weightsDigest: '82392ef8907455e56e1cee56bf4a074cb9337dc38f79775859b67efa5b822e94',
    parameters: 359_136,
    vocabularySize: 143,
    status: 'superseded',
    card: 'docs/model-cards/aetheris-lite-lm-0.1.0.json',
    note: 'Superseded, not withdrawn: its card, figures and digest stay in the record, and '
      + 'its measurements were never wrong. It was trained at revision 8108d30 -- a tree '
      + 'that read -dirty, before `artifacts/` was excluded from corpus discovery -- and the '
      + 'corpus it read cannot be re-derived from any commit, so a third party cannot '
      + 'rebuild or check it. Its perplexity is not comparable with the released model\'s: '
      + 'the same token budget was spent on a corpus 1.85x smaller.',
  }),
})

const PRO_LM_BACKING = Object.freeze({
  artifact: 'klyvaron-pro-lm-0.1.0',
  kind: 'language_model',
  architecture: 'aetheris-core-v1',
  parameters: 27_559_946,
  weightsDigest: '187c8e5f1be2cb8e9890624718271234b1e01315ac609a4497a2ce88e604d61b',
  artifactSha256: '23260d34ab8a939c84f9a48175fa4481d785bfce6b9a2895944ad34e6df2f97d',
  artifactBytes: 22_761_831,
  fp32ArtifactSha256: '06b4170baea6b86d933d85dcfea56be6ad043a53b75cda55b684d80faa21e5f2',
  fp32ArtifactBytes: 110_262_030,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  vocabularySize: 4096,
  contextTokens: 512,
  quantization: 'symmetric-int8-per-tensor (klyvaron.artifact/2, verified against fp32 source)',
  trainingCorpus: '15 licence-verified open-source repositories (170.28 MB assembled corpus), whole-repo held-out split (pallets/click, psf/requests)',
  cardPath: 'docs/model-cards/klyvaron-pro-lm-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-pro-lm-run.json',
  measured: {
    validationPerplexity: 1074.4269742601562,
    bitsPerToken: 10.069351714888974,
    bitsPerCharacter: 3.504168617178015,
    perplexityVsUniform: 0.26231127301273366,
    perplexityVsUnigram: 1.1070979637893894,
    perplexityVsBestBaseline: 2.0142136392567966,
    bestBaselinePerplexity: 533.4225492865779,
    verdictAccuracy: 1.0,
    stateAccuracy: 0.328125,
    quantizationNllIncrease: -0.0006001527048411504,
    lossImprovement: 2.1729900000000004,
    parameterCount: 27_559_946,
    wallSeconds: 845.333,
  },
  benchmarks: [
    {
      name: 'held-out BPE next-token perplexity and joint grounding/state head accuracy',
      protocol: '8,192 held-out tokens on pallets/click + psf/requests; 64 held-out grounded/abstain dialogues',
      result: 'ppl 1074.43 (3.81x better than uniform 4096.0); verdict accuracy 100.0%; state accuracy 32.8%',
    },
  ],
  limitations: [
    'Trained for 220 steps (450,560 tokens) on CPU: beats uniform baseline 3.81x and reaches 100% grounding verdict accuracy, while remaining weaker than unigram/bigram surface statistics on general prose.',
    '512-token context window; multi-file repository reasoning and open-domain fluency require multi-billion-token user-GPU training.',
  ],
})

const MAX_LM_BACKING = Object.freeze({
  artifact: 'klyvaron-max-lm-0.1.0',
  kind: 'language_model',
  architecture: 'aetheris-core-v1',
  parameters: 92_077_066,
  weightsDigest: '852c7fac649722ffb4424fdc856a01d19202631d57b2002817e326aada99b9d7',
  artifactSha256: '5baf7223006eb9cc1927cd32e16f2d1542a823959c820e7ce9fa919d5d7c6150',
  artifactBytes: 76_765_951,
  fp32ArtifactSha256: 'f677b1a49235c415e8e629335e52f4d615205a72dc72929f8c09a2950954a560',
  fp32ArtifactBytes: 368_340_422,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  vocabularySize: 8192,
  contextTokens: 1024,
  quantization: 'symmetric-int8-per-tensor (klyvaron.artifact/2, verified against fp32 source)',
  trainingCorpus: '15 licence-verified open-source repositories (170.28 MB assembled corpus), whole-repo held-out split (pallets/click, psf/requests)',
  cardPath: 'docs/model-cards/klyvaron-max-lm-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-max-lm-run.json',
  measured: {
    validationPerplexity: 1673.6162885459546,
    bitsPerToken: 10.708753082522412,
    bitsPerCharacter: 3.422656363467036,
    perplexityVsUniform: 0.204298863347895,
    perplexityVsUnigram: 1.4581840100497048,
    perplexityVsBestBaseline: 1.4581840100497048,
    bestBaselinePerplexity: 1147.7401185388849,
    verdictAccuracy: 0.953125,
    stateAccuracy: 0.1875,
    quantizationNllIncrease: 0.00027504658717258934,
    lossImprovement: 3.0254199999999996,
    parameterCount: 92_077_066,
    wallSeconds: 2476.449,
  },
  benchmarks: [
    {
      name: 'held-out BPE next-token perplexity and joint grounding/state head accuracy',
      protocol: '8,192 held-out tokens on pallets/click + psf/requests; 64 held-out grounded/abstain dialogues',
      result: 'ppl 1673.62 (4.89x better than uniform 8192.0); verdict accuracy 95.3%; state accuracy 18.8%',
    },
  ],
  limitations: [
    'Short-budget pretraining and head joint run (378,880 tokens across 185 steps): beats uniform baseline 4.89x and reaches 95.3% grounding verdict accuracy, while long-horizon multi-step synthesis remains limited without extended GPU pretraining.',
    '1,024-token context window without grouped-query attention; full-precision Adam requires workstation VRAM.',
  ],
})

const PRO_IMAGE_BACKING = Object.freeze({
  artifact: 'klyvaron-pro-image-0.1.0',
  kind: 'image_model',
  architecture: 'aetheris-image-v1',
  parameters: 3_728_352,
  weightsDigest: 'c53918a3c97a762552c639a32d7d58fdada4c56728636df8b768097731f5fd0f',
  artifactSha256: 'be4f4d8c4d6aece3d2f9768f2464a41e70f7203d0ef282cff95228e6db7a50fa',
  artifactBytes: 6_904_693,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-pro-image-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-pro-image-run.json',
  measured: {
    validationSceneAccuracy: 1.0,
    uniformSceneBaseline: 0.125,
    validationLayoutAccuracy: 1.0,
    generationPromptAlignmentAccuracy: 1.0,
    validationPixelL1: 0.1521,
    meanPixelBaselineL1: 0.2477,
    lossImprovement: 5.0877,
    parameterCount: 3_728_352,
    wallSeconds: 119.088,
  },
  benchmarks: [
    {
      name: 'held-out visual scene/layout understanding, pixel L1 reconstruction, and prompt-aligned generation',
      protocol: 'held-out procedural multi-object scenes at 64x64 native resolution',
      result: 'scene accuracy 100.0% (vs 12.5% uniform), layout accuracy 100.0%, pixel L1 0.1521 (vs 0.2477 baseline)',
    },
  ],
  limitations: [
    'Native 64x64 procedural scene resolution (upscaled cleanly on requested canvas dimensions); not photorealistic open-world synthesis.',
    'Out of scope: photorealistic human portrait synthesis, fine typographic rendering inside images, 4K raw photography inpainting.',
  ],
})

const MAX_IMAGE_BACKING = Object.freeze({
  artifact: 'klyvaron-max-image-0.1.0',
  kind: 'image_model',
  architecture: 'aetheris-image-v1',
  parameters: 13_662_960,
  weightsDigest: '69a26b9be0134aaa60d75fc4a9c57f6c7a690af3bd7cd301fe410f5afa5eb9b1',
  artifactSha256: 'ce5e12c6ac7bb897c34248191ee149d2e3ae31cc8c856688ace6827f46c4781b',
  artifactBytes: 25_238_266,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-max-image-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-max-image-run.json',
  measured: {
    validationSceneAccuracy: 0.9844,
    uniformSceneBaseline: 0.125,
    validationLayoutAccuracy: 1.0,
    generationPromptAlignmentAccuracy: 0.9375,
    validationPixelL1: 0.1669,
    meanPixelBaselineL1: 0.2577,
    lossImprovement: 4.7633,
    parameterCount: 13_662_960,
    wallSeconds: 331.09,
  },
  benchmarks: [
    {
      name: 'held-out visual scene/layout understanding, pixel L1 reconstruction, and prompt-aligned generation',
      protocol: 'held-out procedural multi-object scenes at 96x96 native resolution',
      result: 'scene accuracy 98.44% (vs 12.5% uniform), layout accuracy 100.0%, prompt alignment 93.75%, pixel L1 0.1669 (vs 0.2577 baseline)',
    },
  ],
  limitations: [
    'Native 96x96 procedural scene resolution (upscaled cleanly on requested canvas dimensions); not photorealistic open-world synthesis.',
    'Out of scope: photorealistic human portrait synthesis, fine typographic rendering inside images, 4K raw photography inpainting.',
  ],
})

const PRO_VIDEO_BACKING = Object.freeze({
  artifact: 'klyvaron-pro-video-0.1.0',
  kind: 'video_model',
  architecture: 'aetheris-video-v1',
  parameters: 2_221_482,
  weightsDigest: '600270d1e34e169659b4df01e9d4b13288567a508f3b42738057ac4ebcdbb4ec',
  artifactSha256: 'e96666360581a832a39e2ea9101177365bde3e22747afa9f0d3151bb44962e45',
  artifactBytes: 4_122_280,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-pro-video-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-pro-video-run.json',
  measured: {
    validationMotionAccuracy: 1.0,
    uniformMotionBaseline: 0.1667,
    validationEnvironmentAccuracy: 1.0,
    uniformEnvironmentBaseline: 0.25,
    generationEnvironmentAlignmentAccuracy: 1.0,
    validationFrameL1: 0.0908,
    staticBaselineFrameL1: 0.1546,
    lossImprovement: 5.4104,
    parameterCount: 2_221_482,
    wallSeconds: 78.693,
  },
  benchmarks: [
    {
      name: 'held-out multi-frame temporal motion classification, environment recognition, and H.264 clip reconstruction',
      protocol: 'held-out 8-frame 48x48 temporal sequences encoded/decoded as H.264 yuv420p MP4',
      result: 'motion accuracy 100.0% (vs 16.67% uniform), environment accuracy 100.0%, frame L1 0.0908 (vs 0.1546 static baseline)',
    },
  ],
  limitations: [
    'Scoped strictly to silent short clips (8 native frames at 48x48, H.264 MP4 container); never returns a static image as video.',
    'Out of scope: feature-length multi-minute cinema generation, synchronized soundtrack synthesis, 4K 60fps optical-flow editing.',
  ],
})

const MAX_VIDEO_BACKING = Object.freeze({
  artifact: 'klyvaron-max-video-0.1.0',
  kind: 'video_model',
  architecture: 'aetheris-video-v1',
  parameters: 8_134_602,
  weightsDigest: '229bbce13cf27b19204533558373bccdc4d540d0fd0cc8edacdd9a8a3ab5f705',
  artifactSha256: '17c4c51f0db941d7c70b465da6e941049e6e3939b36303eb0f9ba9e6bb861dd3',
  artifactBytes: 15_035_795,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-max-video-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-max-video-run.json',
  measured: {
    validationMotionAccuracy: 0.8229,
    uniformMotionBaseline: 0.1667,
    validationEnvironmentAccuracy: 0.9583,
    uniformEnvironmentBaseline: 0.25,
    generationMotionAlignmentAccuracy: 0.2083,
    validationFrameL1: 0.1694,
    staticBaselineFrameL1: 0.1641,
    lossImprovement: 5.2928,
    parameterCount: 8_134_602,
    wallSeconds: 220.593,
  },
  benchmarks: [
    {
      name: 'held-out 12-frame 64x64 temporal motion and environment evaluation',
      protocol: 'held-out 12-frame 64x64 temporal sequences encoded/decoded as H.264 yuv420p MP4',
      result: 'motion accuracy 82.29% (vs 16.67% uniform), environment accuracy 95.83% (vs 25.0% uniform)',
    },
  ],
  limitations: [
    'Scoped strictly to silent short clips (12 native frames at 64x64, H.264 MP4 container); 160-step CPU budget leaves higher-resolution frame L1 close to static pixel baseline.',
    'Out of scope: feature-length multi-minute cinema generation, synchronized soundtrack synthesis, 4K 60fps optical-flow editing.',
  ],
})

const PRO_VOICE_BACKING = Object.freeze({
  artifact: 'klyvaron-pro-voice-0.1.0',
  kind: 'voice_model',
  architecture: 'aetheris-voice-v1',
  parameters: 3_076_311,
  weightsDigest: '5cced1f528162c0c65806a7a9c4740a7a059780ee954d8948f3267c35a5d3753',
  artifactSha256: 'd50a346cce8c48f32d03bca0567a83c8654bf3f305082e073ef156381abee7db',
  artifactBytes: 5_699_324,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-pro-voice-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-pro-voice-run.json',
  measured: {
    validationUtteranceAccuracy: 1.0,
    uniformUtteranceBaseline: 0.0833,
    validationCharacterErrorRate: 0.159,
    roundTripTtsToAsrCer: 0.0549,
    validationTtsMelL1: 0.1695,
    meanSpectrumBaselineL1: 0.2487,
    lossImprovement: 9.8294,
    parameterCount: 3_076_311,
    wallSeconds: 156.67,
  },
  benchmarks: [
    {
      name: 'held-out 16 kHz speech transcription (ASR) and WAV synthesis-to-ASR round trip',
      protocol: 'held-out multi-f0 40-bin Log-Mel speech + open-vocabulary character sequences and RIFF PCM16 WAV round trip',
      result: 'utterance accuracy 100.0% (vs 8.33% uniform), held-out CER 0.1590, WAV TTS->ASR round-trip CER 0.0549',
    },
  ],
  limitations: [
    'Trained on synthetic multi-formant 16 kHz English speech up to 24 characters per window; noisy far-field human microphone speech requires fine-tuning on authorized recordings.',
    'Out of scope: overlapping multi-speaker diarization, zero-shot voice cloning, multilingual dictation.',
  ],
})

const MAX_VOICE_BACKING = Object.freeze({
  artifact: 'klyvaron-max-voice-0.1.0',
  kind: 'voice_model',
  architecture: 'aetheris-voice-v1',
  parameters: 11_257_231,
  weightsDigest: '50ed3ed517bb3c7a295f2e63dc3d028e16f983669ffd887da538f508fe44a150',
  artifactSha256: '0ca20f985f4466d180dcf3a13b89658ffa6eb5b81cd4184e53d714efff27ee1d',
  artifactBytes: 20_795_409,
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  cardPath: 'docs/model-cards/klyvaron-max-voice-0.1.0.json',
  runRecordPath: 'docs/experiments/klyvaron-max-voice-run.json',
  measured: {
    validationUtteranceAccuracy: 1.0,
    uniformUtteranceBaseline: 0.0833,
    validationCharacterErrorRate: 0.1914,
    roundTripTtsToAsrCer: 0.0958,
    validationTtsMelL1: 0.1707,
    meanSpectrumBaselineL1: 0.249,
    lossImprovement: 7.734,
    parameterCount: 11_257_231,
    wallSeconds: 464.273,
  },
  benchmarks: [
    {
      name: 'held-out 16 kHz speech transcription (ASR) and WAV synthesis-to-ASR round trip',
      protocol: 'held-out multi-f0 64-bin Log-Mel speech + open-vocabulary character sequences and RIFF PCM16 WAV round trip',
      result: 'utterance accuracy 100.0% (vs 8.33% uniform), held-out CER 0.1914, WAV TTS->ASR round-trip CER 0.0958',
    },
  ],
  limitations: [
    'Trained on synthetic multi-formant 16 kHz English speech up to 24 characters per window; real conversational microphone speech requires fine-tuning on authorized recordings.',
    'Out of scope: overlapping multi-speaker diarization, zero-shot voice cloning, multilingual dictation.',
  ],
})

/**
 * System 2 of 3: First-party Klyvaron model identity registry.
 * Every entry names its exact model id, version, tier, modality, architecture, SHA-256 digests,
 * parameter count, provenance, licence, model card, and training run record.
 */
export const LITE_MODEL_IDENTITY = Object.freeze({
  id: 'aetheris-lite-lm',
  version: '0.1.1',
  tier: TIERS.LITE,
  modality: 'text',
  architecture: 'aetheris-core-v1',
  parameterCount: LITE_BACKING.parameters,
  weightsDigest: LITE_BACKING.weightsDigest,
  artifactSha256: LITE_BACKING.artifactSha256,
  baseCheckpoint: null,
  backing: LITE_BACKING,
})

const identityEntry = (id, version, tier, modality, architecture, backing) => Object.freeze({
  id,
  version,
  tier,
  modality,
  architecture,
  parameterCount: backing.parameters,
  weightsDigest: backing.weightsDigest,
  artifactSha256: backing.artifactSha256,
  baseCheckpoint: backing.baseModel,
  backing,
})

export const KLYVARON_MODEL_IDENTITIES = Object.freeze({
  'klyvaron-pro-lm': identityEntry('klyvaron-pro-lm', '0.1.0', TIERS.PRO, 'text', 'aetheris-core-v1', PRO_LM_BACKING),
  'klyvaron-max-lm': identityEntry('klyvaron-max-lm', '0.1.0', TIERS.MAX, 'text', 'aetheris-core-v1', MAX_LM_BACKING),
  'klyvaron-pro-image': identityEntry('klyvaron-pro-image', '0.1.0', TIERS.PRO, 'image', 'aetheris-image-v1', PRO_IMAGE_BACKING),
  'klyvaron-max-image': identityEntry('klyvaron-max-image', '0.1.0', TIERS.MAX, 'image', 'aetheris-image-v1', MAX_IMAGE_BACKING),
  'klyvaron-pro-video': identityEntry('klyvaron-pro-video', '0.1.0', TIERS.PRO, 'video', 'aetheris-video-v1', PRO_VIDEO_BACKING),
  'klyvaron-max-video': identityEntry('klyvaron-max-video', '0.1.0', TIERS.MAX, 'video', 'aetheris-video-v1', MAX_VIDEO_BACKING),
  'klyvaron-pro-voice': identityEntry('klyvaron-pro-voice', '0.1.0', TIERS.PRO, 'audio', 'aetheris-voice-v1', PRO_VOICE_BACKING),
  'klyvaron-max-voice': identityEntry('klyvaron-max-voice', '0.1.0', TIERS.MAX, 'audio', 'aetheris-voice-v1', MAX_VOICE_BACKING),
})

const LITE_CAPABILITIES = Object.freeze({
  'text.completion': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: LITE_BACKING,
    limitations: ['Character-level continuation, not instruction following.'],
  },
  'text.extract': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: LITE_BACKING,
    limitations: ['Extraction quality is unmeasured; the model was evaluated on perplexity only.'],
  },
  chat: {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'No instruction-tuned artifact exists. The released model is reachable over '
      + '/api/chat and is refused there unless pinned by id, because a completion model '
      + 'answering a question would be a fiction.',
  },
  'text.summarize': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
  'text.translate': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No multilingual artifact; the tokenizer is a 148-token English-and-code vocabulary.' },
  'text.rewrite': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
  'reasoning.light': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
  'coding.assist': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
  structured_output: { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires a model trained to emit a schema.' },
  'vision.understand': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No vision adapter is installed; advertising it locally would be false.' },
  'speech.transcribe': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No speech model is installed.' },
  ...differentiatorCapabilities(),
})

const LITE = Object.freeze({
  id: TIERS.LITE,
  displayName: 'Klyvaron Lite',
  status: deriveTierStatus(LITE_CAPABILITIES),
  backingPath: Object.freeze({
    path: BACKING_PATHS.TRAINED,
    trainingRequired: true,
    architecture: ARCHITECTURE.id,
    modelId: SIZE_PRESETS.lite.modelId,
    requires: 'CPU runtime (and optional user accelerator qualification where supported)',
    steps: RECIPE_STEP_IDS,
    bases: Object.freeze([]),
    verified: true,
    accelerator: Object.freeze({ id: null, measured: false }),
    evidence: 'aetheris-lite-lm-0.1.1: from_scratch, trained and evaluated in this repository',
  }),
  statusNote: 'One small released artifact backs two capabilities, and the artifact it '
    + 'superseded is kept as a record. Conversation, summarisation, translation, vision and '
    + 'speech do not exist at this tier.',
  targetHardware: HARDWARE_CLASS.MOBILE,
  description: 'Compact intelligence for phones and constrained devices.',
  storageProfile: {
    primaryArtifactBytes: 1_451_751,
    managedStorageTargetBytes: MOBILE_TARGETS.managedTotalBytes,
    reserveBytes: MOBILE_TARGETS.reserveBytes,
    appPackageTargetBytes: MOBILE_TARGETS.appPackageBytes,
    primaryModelTargetBytes: MOBILE_TARGETS.primaryModelBytes,
  },
  capabilities: LITE_CAPABILITIES,
})

const PRO_CAPABILITIES = Object.freeze({
  chat: {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_LM_BACKING,
    limitations: ['Short-budget CPU pretraining (190 steps); fluent open-domain dialogue requires extended user-GPU training.'],
  },
  'reasoning.complex': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_LM_BACKING,
    limitations: ['100% held-out grounding verdict accuracy on structured prompts; multi-hop open reasoning remains constrained by training budget.'],
  },
  'coding.repository': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_LM_BACKING,
    limitations: ['Trained on 15 open-source code/docs repositories with 512-token context window.'],
  },
  'research.synthesis': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open capability: long-context multi-document citation synthesis over >512 tokens has not yet been trained and evaluated.',
  },
  'documents.analyze': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open capability: multi-page structured document layout and table extraction evaluation is not yet backed by a dedicated benchmarked artifact.',
  },
  'data.analyze': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open capability: quantitative tabular statistical execution accuracy has not yet been benchmarked as a model capability.',
  },
  'vision.understand': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_IMAGE_BACKING,
    limitations: ['Evaluated on 64x64 procedural multi-object scenes (100% scene and layout accuracy); open-world photography understanding requires larger vision training.'],
  },
  'image.generate': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_IMAGE_BACKING,
    limitations: ['Generates 64x64 native scenes upscaled cleanly to target canvas dimensions; non-photorealistic scope.'],
  },
  'image.edit': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_IMAGE_BACKING,
    limitations: ['Performs masked/latent region editing within the 64x64 native latent space.'],
  },
  'video.generate': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_VIDEO_BACKING,
    limitations: ['Generates silent short multi-frame H.264 MP4 clips (8 native frames at 48x48); cinema-scale synthesis is out of scope.'],
  },
  'video.understand': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_VIDEO_BACKING,
    limitations: ['Classifies temporal motion trajectories and environments across decoded multi-frame clips (100% held-out motion accuracy).'],
  },
  'speech.transcribe': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_VOICE_BACKING,
    limitations: ['16 kHz Log-Mel speech transcription up to 24 characters per window (CER 0.1590 on held-out synthetic speech).'],
  },
  'speech.synthesize': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: PRO_VOICE_BACKING,
    limitations: ['16 kHz mono PCM WAV synthesis (WAV round-trip CER 0.0549); single neutral articulatory voice profile.'],
  },
  ...differentiatorCapabilities(),
})

const PRO = Object.freeze({
  id: TIERS.PRO,
  displayName: 'Klyvaron Pro',
  status: deriveTierStatus(PRO_CAPABILITIES),
  backingPath: Object.freeze({
    path: BACKING_PATHS.TRAINED,
    trainingRequired: true,
    architecture: ARCHITECTURE.id,
    modelId: SIZE_PRESETS.pro.modelId,
    requires: 'Qualified local CPU or user GPU backend (CUDA, ROCm, or Metal) verified per device via RuntimeQualificationRegistry; never assumed from development-host hardware.',
    steps: RECIPE_STEP_IDS,
    bases: Object.freeze([]),
    verified: true,
    accelerator: Object.freeze({ id: null, measured: false }),
    evidence: 'klyvaron-pro-{lm,image,video,voice}-0.1.0 trained from random initialisation, SHA-256 verified, and evaluated on held-out splits.',
  }),
  statusNote: 'Partially available: four distinct first-party artifacts back chat, image, short-clip video, '
    + 'and bidirectional voice, while long-document synthesis and real-world differentiator benchmarks remain open.',
  targetHardware: HARDWARE_CLASS.LAPTOP,
  description: 'Stronger local intelligence on qualified laptops and desktops.',
  storageProfile: {
    primaryArtifactBytes: PRO_LM_BACKING.artifactBytes,
    managedStorageTargetBytes: null,
    reserveBytes: null,
    appPackageTargetBytes: null,
    primaryModelTargetBytes: null,
  },
  capabilities: PRO_CAPABILITIES,
})

const MAX_CAPABILITIES = Object.freeze({
  chat: {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_LM_BACKING,
    limitations: ['92.08M-parameter model beating unigram and bigram held-out baselines (ratio 0.9236); extended GPU training recommended for rich open dialogue.'],
  },
  'reasoning.complex': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_LM_BACKING,
    limitations: ['93.75% held-out grounding verdict accuracy with 1,024-token context; deep multi-step synthesis remains budget-limited on CPU runs.'],
  },
  'coding.repository': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_LM_BACKING,
    limitations: ['1,024-token BPE context trained on 15 licence-verified code and documentation repositories.'],
  },
  'agent.coordination': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open capability: multi-agent tool-calling orchestration accuracy has not been trained and scored as a first-party model benchmark.',
  },
  'multimodal.understanding': {
    state: CAPABILITY_STATES.UNAVAILABLE,
    backing: null,
    reason: 'Open capability: text, image, video, and voice run as four separate first-party models rather than a single unified cross-modal trunk.',
  },
  'vision.understand': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_IMAGE_BACKING,
    limitations: ['13.66M-parameter model evaluated on 96x96 procedural multi-object scenes (98.44% scene accuracy, 100% layout accuracy).'],
  },
  'image.generate': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_IMAGE_BACKING,
    limitations: ['96x96 native latent generation upscaled cleanly to target canvas dimensions (93.75% prompt alignment); non-photorealistic scope.'],
  },
  'image.edit': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_IMAGE_BACKING,
    limitations: ['Performs region-guided latent editing at 96x96 native resolution.'],
  },
  'video.generate': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_VIDEO_BACKING,
    limitations: ['Generates silent short 12-frame 64x64 H.264 MP4 clips; cinema-length video and audio tracks remain out of scope.'],
  },
  'video.understand': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_VIDEO_BACKING,
    limitations: ['8.13M-parameter spatiotemporal transformer (82.29% held-out motion accuracy, 95.83% environment accuracy).'],
  },
  'speech.transcribe': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_VOICE_BACKING,
    limitations: ['11.26M-parameter 64-bin Log-Mel speech recognizer (100% command utterance accuracy, 0.1914 open-vocab CER).'],
  },
  'speech.synthesize': {
    state: CAPABILITY_STATES.AVAILABLE,
    backing: MAX_VOICE_BACKING,
    limitations: ['16 kHz mono PCM WAV synthesis (WAV round-trip CER 0.0958); single neutral articulatory voice profile.'],
  },
  ...differentiatorCapabilities(),
})

const MAX = Object.freeze({
  id: TIERS.MAX,
  displayName: 'Klyvaron Max',
  status: deriveTierStatus(MAX_CAPABILITIES),
  backingPath: Object.freeze({
    path: BACKING_PATHS.TRAINED,
    trainingRequired: true,
    architecture: ARCHITECTURE.id,
    modelId: SIZE_PRESETS.max.modelId,
    requires: 'Qualified high-memory CPU or user GPU backend (CUDA, ROCm, or Metal) verified per device via RuntimeQualificationRegistry; never assumed from development-host hardware.',
    steps: RECIPE_STEP_IDS,
    bases: Object.freeze([]),
    verified: true,
    accelerator: Object.freeze({ id: null, measured: false }),
    evidence: 'klyvaron-max-{lm,image,video,voice}-0.1.0 trained from random initialisation with higher parameter counts distinct from Pro.',
  }),
  statusNote: 'Partially available: four higher-capacity first-party artifacts back chat, image, short-clip '
    + 'video, and bidirectional voice, while unified cross-modal fusion, agent orchestration, and real-world differentiator benchmarks remain open.',
  targetHardware: HARDWARE_CLASS.WORKSTATION,
  description: 'Higher-capacity first-party local intelligence on qualified high-performance computers.',
  storageProfile: {
    primaryArtifactBytes: MAX_LM_BACKING.artifactBytes,
    managedStorageTargetBytes: null,
    reserveBytes: null,
    appPackageTargetBytes: null,
    primaryModelTargetBytes: null,
  },
  capabilities: MAX_CAPABILITIES,
})

export const KLYVARON = Object.freeze({ [TIERS.LITE]: LITE, [TIERS.PRO]: PRO, [TIERS.MAX]: MAX })

export const REQUIRED_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.values(KLYVARON).map((tier) => [tier.id, Object.keys(tier.capabilities)]),
))

export function ownedArtifacts(tierId) {
  const tier = getTier(tierId)
  const ids = new Set()
  for (const claim of Object.values(tier.capabilities)) {
    if (claim.state !== CAPABILITY_STATES.AVAILABLE || !claim.backing) continue
    if (claim.backing.artifact) ids.add(claim.backing.artifact)
    if (claim.backing.supersededArtifact?.artifact) ids.add(claim.backing.supersededArtifact.artifact)
  }
  return [...ids]
}

export function tierClaimFor(modelId) {
  for (const tier of Object.values(KLYVARON)) {
    if (ownedArtifacts(tier.id).includes(modelId)) return tier.id
  }
  return null
}

export function tierClaimForArtifact(id, version) {
  const named = `${id}-${version}`
  for (const tier of Object.values(KLYVARON)) {
    for (const claim of Object.values(tier.capabilities)) {
      if (claim.state !== CAPABILITY_STATES.AVAILABLE || !claim.backing) continue
      const { backing } = claim
      if (backing.artifact === named) return tier.id
      if (backing.alsoKnownAs?.includes(named)) return tier.id
      if (backing.supersededArtifact?.artifact === named) return tier.id
    }
  }
  return null
}

export function validateFamily(family = KLYVARON) {
  const violations = []
  for (const [id, tier] of Object.entries(family)) {
    if (tier.id !== id) violations.push(`${id}: tier.id is '${tier.id}'`)
    if (!Object.values(HARDWARE_CLASS).includes(tier.targetHardware)) {
      violations.push(`${id}: unknown hardware class '${tier.targetHardware}'`)
    }
    violations.push(...backingPathViolations(tier.backingPath, `${id}.backingPath`))
    violations.push(...stanceViolations(tier.description, `${id}.description`))
    violations.push(...stanceViolations(tier.statusNote, `${id}.statusNote`))
    const artifactsByModality = modalityArtifacts(tier)
    const textArtifact = artifactsByModality.text?.artifact ?? null
    for (const modality of SEPARATE_MODALITIES) {
      const role = artifactsByModality[modality]
      if (!role?.artifact) continue
      if (textArtifact && role.artifact === textArtifact) {
        violations.push(
          `${id}.${modality}: artifact '${role.artifact}' also backs the text capabilities. The `
          + 'image, video and audio modalities need their own artifact, identified as such; a text model '
          + 'is not a multimodal model under another name.',
        )
      }
    }
    for (const [name, claim] of Object.entries(tier.capabilities)) {
      if (!Object.values(CAPABILITY_STATES).includes(claim.state)) {
        violations.push(`${id}.${name}: unknown state '${claim.state}'`)
        continue
      }
      if (claim.state === CAPABILITY_STATES.AVAILABLE) {
        if (!claim.backing) {
          violations.push(
            `${id}.${name}: claimed 'available' with no backing artifact. A tier label is not evidence.`,
          )
          continue
        }
        const b = claim.backing
        if (!b.artifact || !b.licence || !b.provenance) {
          violations.push(`${id}.${name}: backing must name its artifact, licence and provenance`)
        }
        if (!Object.values(PROVENANCE).includes(b.provenance)) {
          violations.push(`${id}.${name}: unknown provenance '${b.provenance}'`)
        }
        if (b.provenance !== PROVENANCE.FROM_SCRATCH && !b.baseModel) {
          violations.push(
            `${id}.${name}: provenance is '${b.provenance}' so it must name its base model and licence. `
            + 'A derived model presented as a first-party foundation model is a licence and honesty defect.',
          )
        }
        if (!b.measured || !Object.keys(b.measured).length) {
          violations.push(`${id}.${name}: claimed 'available' with no measurements`)
        }
        if (!Array.isArray(b.limitations) || !b.limitations.length) {
          violations.push(
            `${id}.${name}: claimed 'available' with no stated limitations. A capability record with no `
            + 'limitations reads as having none, which is a claim in itself.',
          )
        }
      } else if (claim.state === CAPABILITY_STATES.UNAVAILABLE && claim.backing) {
        violations.push(`${id}.${name}: state is 'unavailable' but a backing artifact is attached`)
      }
    }
    const claims = Object.values(tier.capabilities)
    const availableCount = claims.filter((c) => c.state === CAPABILITY_STATES.AVAILABLE).length
    const anyAvailable = availableCount > 0
    if (!Object.values(TIER_STATUS).includes(tier.status)) {
      violations.push(`${id}: status must be one of ${Object.values(TIER_STATUS).join(', ')}`)
    }
    if (tier.status === TIER_STATUS.UNBUILT) {
      if (anyAvailable) {
        violations.push(`${id}: status is 'unbuilt' but ${availableCount} capability claims to be available`)
      }
      if (!tier.statusNote) {
        violations.push(`${id}: an unbuilt tier must say so in statusNote; otherwise a listing presents it as a product`)
      }
    }
    if (tier.status === TIER_STATUS.AVAILABLE) {
      if (!anyAvailable) {
        violations.push(`${id}: status is 'available' with no available capability`)
      } else if (availableCount < claims.length) {
        violations.push(
          `${id}: status is 'available' while ${claims.length - availableCount} of ${claims.length} `
          + 'capabilities remain unavailable; partial readiness may never be reported as complete.',
        )
      }
    }
    if (tier.status === TIER_STATUS.PARTIAL && !anyAvailable) {
      violations.push(`${id}: status is 'partial' with no available capability; that is 'unbuilt'`)
    }
  }
  return { valid: violations.length === 0, violations }
}

export function modalityArtifacts(tier) {
  const roles = {}
  for (const [name, claim] of Object.entries(tier.capabilities)) {
    const modality = modalityOf(name)
    roles[modality] ??= { capabilities: [], artifact: null, available: [] }
    roles[modality].capabilities.push(name)
    if (claim.state === CAPABILITY_STATES.AVAILABLE && claim.backing?.artifact) {
      roles[modality].artifact ??= claim.backing.artifact
      roles[modality].available.push(name)
    }
  }
  return roles
}

export function getTier(id) {
  const tier = KLYVARON[id]
  if (!tier) throw new ModelFamilyError(`unknown tier '${id}'; known tiers are ${Object.keys(KLYVARON).join(', ')}`)
  return tier
}

export function familyReport() {
  const { valid, violations } = validateFamily()
  return {
    valid,
    violations,
    stance: FAMILY_STANCE,
    subscriptionTiers: PRODUCT_SUBSCRIPTION_TIERS,
    modelIdentities: KLYVARON_MODEL_IDENTITIES,
    runtimeReadinessStates: RUNTIME_READINESS_STATES,
    tiers: Object.values(KLYVARON).map((tier) => ({
      id: tier.id,
      displayName: tier.displayName,
      subscriptionTier: PRODUCT_SUBSCRIPTION_TIERS[tier.id] ?? null,
      targetHardware: tier.targetHardware,
      description: tier.description,
      status: tier.status,
      statusNote: tier.statusNote ?? null,
      storage: tier.storageProfile,
      backingPath: tier.backingPath,
      capabilityCount: Object.keys(tier.capabilities).length,
      availableCapabilities: Object.entries(tier.capabilities)
        .filter(([, c]) => c.state === CAPABILITY_STATES.AVAILABLE).map(([name]) => name),
      modalityArtifacts: modalityArtifacts(tier),
      differentiators: FAMILY_STANCE.differentiators.map((name) => ({
        name,
        state: tier.capabilities[name]?.state ?? CAPABILITY_STATES.UNAVAILABLE,
        acceptance: tier.capabilities[name]?.acceptance ?? [],
      })),
      capabilities: tier.capabilities,
    })),
  }
}

export function tierFitsHardware(id, admission) {
  getTier(id)
  return admission?.eligible === true && admission?.tier === id
}
