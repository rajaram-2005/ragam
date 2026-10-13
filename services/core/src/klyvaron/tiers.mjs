// The Klyvaron model family: three tiers, and the rule that keeps them honest.
//
// Directive §5: Klyvaron Lite for phones and constrained devices, Pro for laptops and
// desktops, High for powerful computers and authorised remote inference.
//
// THREE RULES FROM THE DIRECTIVE, ENFORCED RATHER THAN DOCUMENTED
//
//   §5A "Do not present an unchanged third-party model as an independently pretrained
//       Klyvaron foundation model. Identify fine-tuned or derived models accurately."
//
//   §10 "Do not claim quality improvements merely because a model has been assigned the
//       Pro or High label."
//
//   §18 "Each release must have a real model artifact or an accurately documented
//       composition of models, a version, provenance, deployment requirements,
//       benchmarks and known limitations."
//
// Those are all the same failure: a name implying a capability that nothing backs. So a
// capability claim here is a STRUCTURED RECORD, not a sentence, and `validateFamily()`
// refuses any claim in the `available` state whose `backing` is missing or whose
// evidence does not match. A tier cannot be relabelled into having more capability;
// the only way to move a capability to `available` is to attach an artifact and its
// measurements.
//
// THE PROVENANCE FIELD IS WHY THIS CANNOT LIE
//
// Every backing record carries `provenance`: `from_scratch`, `fine_tuned`, `derived`,
// or `third_party`. A `derived` or `third_party` model must name its base and licence.
// That is what makes "this is a Klyvaron model" a checkable statement rather than a
// naming convention.
//
// STATUS OF THE THREE TIERS, AS OF THIS COMMIT
//
//   Lite  — one real artifact, trained from scratch here, and it is SMALLER than the
//           storage target and MUCH weaker than the capability targets. Both facts are
//           recorded. It does not chat.
//   Pro   — no artifact. Every capability is `unavailable`. Not a placeholder: an
//           absent model is recorded as absent.
//   High  — no artifact, same.

export const TIERS = Object.freeze({ LITE: 'lite', PRO: 'pro', HIGH: 'high' })

/**
 * Where a capability claim stands.
 *
 * `available` is the only state that asserts the capability works today, and it is the
 * only state that requires backing. The others exist so that "we have not built this"
 * is a value rather than an omission -- an omitted capability and a capability that
 * does not exist look identical in a listing, which is how overclaiming starts.
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
 * Whether a tier exists yet.
 *
 * The distinction the validator enforces, and the reason a comparative description is
 * allowed on an unbuilt tier: the directive's own language for Pro and High IS
 * comparative ("stronger local intelligence", "the highest practical quality"), and
 * that is a statement of purpose rather than a claim of delivery. The lie would be
 * presenting an unbuilt tier as though it were a product, so an unbuilt tier must
 * declare itself unbuilt and must have nothing marked available.
 */
export const TIER_STATUS = Object.freeze({
  AVAILABLE: 'available',
  PARTIAL: 'partial',
  UNBUILT: 'unbuilt',
})

/** Hardware classes, so an adapter can be matched to a device by measurement. */
export const HARDWARE_CLASS = Object.freeze({
  MOBILE: 'mobile',
  LAPTOP: 'laptop',
  DESKTOP: 'desktop',
  WORKSTATION: 'workstation',
  REMOTE: 'remote',
})

/** Directive §5A mobile storage targets, in bytes. Decimal GB, the stricter reading. */
export const MOBILE_TARGETS = Object.freeze({
  appPackageBytes: 200 * 1000 ** 2,
  primaryModelBytes: 1.5 * 1000 ** 3,
  managedTotalBytes: 5 * 1000 ** 3,
  reserveBytes: 500 * 1000 ** 2,
})

export class ModelFamilyError extends Error {
  constructor(message, violations = []) {
    super(message)
    this.name = 'ModelFamilyError'
    this.code = 'model_family_violation'
    this.violations = violations
  }
}

/**
 * The artifact this tier is backed by -- and the second artifact that also exists.
 *
 * The released artifact is the one with a committed card, benchmarks and limitations
 * (`docs/model-cards/aetheris-lite-lm-0.1.0.json`, quoted in docs/08 and docs/11): a
 * character-level language model trained from random initialisation on this repository's
 * own text, from a run whose report is the source of every number here.
 *
 * A second, corrected-corpus artifact exists. `artifacts/` used to be visible to corpus
 * discovery, so a run could train on the reports of the runs before it; the exclusion
 * landed in `8d9cdf8`, and a full run of the same configuration afterwards is recorded at
 * `docs/experiments/lm-verification-run-8d9cdf8.json`. It is recorded as **verification
 * evidence, not as a release**, and the difference is measured rather than stylistic:
 *
 *  - its corpus is **1.849x** larger than the release's (2,646,300 bytes against
 *    1,431,417), so its perplexity is not comparable with the release's and is offered as
 *    neither an improvement nor a regression;
 *  - the released figures are the ones published in a committed card, and renumbering a
 *    released artifact to match a differently-corpus'd run would move every published
 *    number for a model nobody measured;
 *  - the release's corpus cannot be rebuilt from any commit (the gitignored files it read
 *    are gone), while the verification run's corpus rebuilds byte-for-byte from its revision.
 *    That asymmetry is why the artifact this repository can rebuild today is the
 *    verification one, and why promoting it to a release is a deliberate step -- a new
 *    card, re-run benchmarks, and a re-run of the install and serve evidence -- rather
 *    than a silent edit.
 */
const LITE_BACKING = Object.freeze({
  artifact: 'aetheris-lite-lm-0.1.0',
  kind: 'language_model',
  parameters: 359_136,
  // The released artifact's digest. Klyvaron Lite refers to this model; the weights
  // themselves are gitignored by policy and referenced by hash, never redistributed.
  weightsDigest: '82392ef8907455e56e1cee56bf4a074cb9337dc38f79775859b67efa5b822e94',
  licence: 'MIT',
  provenance: PROVENANCE.FROM_SCRATCH,
  baseModel: null,
  vocabularySize: 143,
  contextTokens: 128,
  quantization: 'none (float32 NumPy)',
  trainingCorpus: "this repository's own text, whole-file split",
  // Copied from the committed model card, at full precision rather than rounded. The
  // first version of this record carried 4.403318 against the card's 4.40331790103542,
  // and the doc guard caught the disagreement -- which is the argument for one value
  // having one home. docs/model-cards/aetheris-lite-lm-0.1.0.json is that home; this is
  // a reference to it, and a test asserts the two stay identical field by field.
  measured: {
    validationPerplexity: 4.40331790103542,
    bitsPerCharacter: 2.138591004549883,
    // Against the best of three computed baselines (uniform 143.0, unigram 35.2895,
    // bigram 15.91094). A ratio, not a claim about other language models.
    perplexityVsBestBaseline: 0.2767478454588419,
    bestBaselinePerplexity: 15.910938326312225,
    bestBaseline: 'bigram',
    validationTokens: 165_120,
    validationUnknownRate: 0.0004965183166818044,
    lossImprovement: 3.5829291343688965,
    parameterCount: 359_136,
    wallSeconds: 2220.146,
  },
  benchmarks: [
    {
      name: 'held-out next-token perplexity vs computed baselines',
      protocol: 'character-level, whole-file split, 165,120 validation tokens, seeds 0/0/20251012',
      result: '4.4033 against a bigram baseline of 15.9109 (3.61x better)',
    },
  ],
  limitations: [
    'It does not follow instructions. It continues text.',
    'Its output is not fluent and must not be presented as a chat answer.',
    'It is far too small to meet the Klyvaron Lite capability targets below; only the '
      + 'storage target is met, and it is met by being undersized.',
    'Trained on this repository\'s text, so it reproduces that text distribution and nothing else.',
  ],
  // The second artifact. Kept in the same record as the release on purpose: a tier that
  // mentions only the artifact with a card would be describing a repository nobody can
  // rebuild, and a tier that quietly promoted the other one would be renumbering a
  // release. `tierClaimForArtifact` reads both, so either version may carry the label.
  verificationArtifact: Object.freeze({
    artifact: 'aetheris-lite-lm-0.1.1-verify',
    // Two digests, because the artifact has two and they mean different things: the run
    // hashes the weight arrays themselves, and the store hashes the `.npz` file it ships
    // and verifies on install. Recorded separately so neither can be read as the other.
    weightsDigest: '53ae59b2a777be9d22f1f04b6cbc94aee3dad6144ac40e4e25c12f900164b60c',
    artifactSha256: '165e150f6e290fe3a8162673f743037dcf15a3b63199ecd7661bdbc83652b6f7',
    artifactBytes: 1_446_862,
    parameters: 359_616,
    status: 'not_a_release',
    record: 'docs/experiments/lm-verification-run-8d9cdf8.json',
    note: 'A second full run of the released configuration on the corrected corpus. It '
      + 'passed the release gate with no hard and no soft failures and was installed, '
      + 'served and rolled back on this machine, but it is evidence rather than a '
      + 'release: its corpus is 1.849x larger than the released model\'s, so its '
      + 'perplexity is not comparable with it and it is not a successor version.',
  }),
})

/**
 * Klyvaron Lite.
 *
 * Read the states rather than the tier name. `chat` is `unavailable` because the
 * artifact that exists cannot chat, and saying otherwise is exactly the overclaim the
 * directive forbids.
 */
const LITE = Object.freeze({
  id: TIERS.LITE,
  displayName: 'Klyvaron Lite',
  status: 'partial',
  statusNote: 'One small artifact exists and two capabilities are backed by it. Conversation, '
    + 'summarisation, translation, vision and speech do not exist at this tier.',
  targetHardware: HARDWARE_CLASS.MOBILE,
  description: 'Compact intelligence for phones and constrained devices.',
  storageProfile: {
    primaryArtifactBytes: 1_448_014,
    managedStorageTargetBytes: MOBILE_TARGETS.managedTotalBytes,
    reserveBytes: MOBILE_TARGETS.reserveBytes,
    appPackageTargetBytes: MOBILE_TARGETS.appPackageBytes,
    primaryModelTargetBytes: MOBILE_TARGETS.primaryModelBytes,
  },
  capabilities: {
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
    'text.translate': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No multilingual artifact; the tokenizer is a 143-character English-and-code vocabulary.' },
    'text.rewrite': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
    'reasoning.light': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
    'coding.assist': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires an instruction-tuned model.' },
    'structured_output': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'Requires a model trained to emit a schema.' },
    'vision.understand': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No vision adapter is installed; advertising it locally would be false.' },
    'speech.transcribe': { state: CAPABILITY_STATES.UNAVAILABLE, backing: null, reason: 'No speech model is installed.' },
  },
})

/** A tier with no artifact. Recorded as absent rather than omitted. */
const absentTier = (id, displayName, targetHardware, description, required) => Object.freeze({
  id,
  displayName,
  targetHardware,
  description,
  status: 'unbuilt',
  statusNote: "No model artifact exists for this tier. Its description states the tier's "
    + 'intended purpose, which is not a claim that anything has been built.',
  storageProfile: {
    primaryArtifactBytes: null,
    managedStorageTargetBytes: null,
    reserveBytes: null,
    appPackageTargetBytes: null,
    primaryModelTargetBytes: null,
  },
  capabilities: Object.freeze(Object.fromEntries(
    required.map((capability) => [capability, {
      state: CAPABILITY_STATES.UNAVAILABLE,
      backing: null,
      reason: 'No model artifact has been produced at this tier. This host cannot obtain base '
        + 'weights (no route to a model registry) and has no GPU, so the tier is unbuilt rather '
        + 'than pending.',
    }]),
  )),
})

const PRO = absentTier(TIERS.PRO, 'Klyvaron Pro', HARDWARE_CLASS.LAPTOP,
  'Stronger local intelligence and creative workflows for laptops and desktops.',
  ['chat', 'reasoning.complex', 'coding.repository', 'research.synthesis', 'documents.analyze',
    'data.analyze', 'vision.understand', 'image.generate', 'image.edit', 'video.generate', 'video.understand'])

const HIGH = absentTier(TIERS.HIGH, 'Klyvaron High', HARDWARE_CLASS.WORKSTATION,
  'The highest practical quality on powerful computers and authorised remote inference.',
  ['chat', 'reasoning.complex', 'coding.repository', 'agent.coordination', 'multimodal.understanding',
    'image.generate', 'image.edit', 'video.generate', 'video.understand'])

export const KLYVARON = Object.freeze({ [TIERS.LITE]: LITE, [TIERS.PRO]: PRO, [TIERS.HIGH]: HIGH })

/** Capabilities the directive names for each tier, so the matrix can be reported whole. */
export const REQUIRED_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.values(KLYVARON).map((tier) => [tier.id, Object.keys(tier.capabilities)]),
))

/**
 * The artifact ids a tier may legitimately claim, taken from the backings of its
 * AVAILABLE capabilities. A tier with nothing available owns nothing.
 */
export function ownedArtifacts(tierId) {
  const tier = getTier(tierId)
  const ids = new Set()
  for (const claim of Object.values(tier.capabilities)) {
    if (claim.state === CAPABILITY_STATES.AVAILABLE && claim.backing?.artifact) ids.add(claim.backing.artifact)
  }
  return [...ids]
}

/**
 * Which Klyvaron tier, if any, may this model id carry as a label?
 *
 * This is the mechanism that makes directive §5A structural instead of aspirational.
 * A tier label is a lookup: it appears only if the model id IS the artifact named in a
 * backing record for a capability the tier actually provides. So rebranding an unchanged
 * third-party model as Klyvaron Pro is not a rule to be broken; it is a string that does
 * not match anything, and the label simply does not appear.
 */
export function tierClaimFor(modelId) {
  for (const tier of Object.values(KLYVARON)) {
    if (ownedArtifacts(tier.id).includes(modelId)) return tier.id
  }
  return null
}

/**
 * The same lookup for a specific artifact version, which is the form the core uses.
 *
 * An artifact manifest carries a `tier` field, and that field is the artifact's own
 * statement about itself -- useful metadata, and not evidence. `app.mjs` therefore emits
 * a `tier:<name>` tag only when this function corroborates the declaration by finding
 * `<id>-<version>` named in a backing record. A hand-built artifact that declares
 * `tier: 'pro'` gets no tier label, no tier tag, and no place in the tier table: the
 * declaration has nothing behind it.
 */
export function tierClaimForArtifact(id, version) {
  const named = `${id}-${version}`
  for (const tier of Object.values(KLYVARON)) {
    for (const claim of Object.values(tier.capabilities)) {
      if (claim.state !== CAPABILITY_STATES.AVAILABLE || !claim.backing) continue
      const { backing } = claim
      if (backing.artifact === named) return tier.id
      if (backing.verificationArtifact?.artifact === named) return tier.id
    }
  }
  return null
}

/**
 * Validate the family.
 *
 * Returns violations rather than throwing, so a report can list every problem instead of
 * stopping at the first. The caller decides whether to throw.
 */
export function validateFamily(family = KLYVARON) {
  const violations = []
  for (const [id, tier] of Object.entries(family)) {
    if (tier.id !== id) violations.push(`${id}: tier.id is '${tier.id}'`)
    if (!Object.values(HARDWARE_CLASS).includes(tier.targetHardware)) {
      violations.push(`${id}: unknown hardware class '${tier.targetHardware}'`)
    }
    for (const [name, claim] of Object.entries(tier.capabilities)) {
      if (!Object.values(CAPABILITY_STATES).includes(claim.state)) {
        violations.push(`${id}.${name}: unknown state '${claim.state}'`)
        continue
      }
      if (claim.state === CAPABILITY_STATES.AVAILABLE) {
        // The rule that stops a tier name from implying a capability.
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
        // EVERYTHING except from_scratch descends from something. The original version of
        // this rule only covered 'derived' and 'third_party', which let 'fine_tuned' pass
        // with no base model named -- and a fine-tuned model is precisely the case the
        // directive is worried about, since relabelling one as a first-party foundation
        // model is the easiest way to overclaim. Caught by the test, not by reading.
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
    // The status rule, which is the one that prevents a listing from showing an unbuilt
    // tier as a product. A comparative description is allowed on an unbuilt tier because
    // it states purpose; what is not allowed is an unbuilt tier without saying so, or a
    // tier claiming availability with nothing to back it.
    const anyAvailable = Object.values(tier.capabilities).some((c) => c.state === CAPABILITY_STATES.AVAILABLE)
    if (!Object.values(TIER_STATUS).includes(tier.status)) {
      violations.push(`${id}: status must be one of ${Object.values(TIER_STATUS).join(', ')}`)
    }
    if (tier.status === TIER_STATUS.UNBUILT) {
      if (anyAvailable) {
        violations.push(`${id}: status is 'unbuilt' but ${Object.values(tier.capabilities)
          .filter((c) => c.state === CAPABILITY_STATES.AVAILABLE).length} capability claims to be available`)
      }
      if (!tier.statusNote) {
        violations.push(`${id}: an unbuilt tier must say so in statusNote; otherwise a listing presents it as a product`)
      }
    }
    if (tier.status === TIER_STATUS.AVAILABLE && !anyAvailable) {
      violations.push(`${id}: status is 'available' with no available capability`)
    }
    if (tier.status === TIER_STATUS.PARTIAL && !anyAvailable) {
      violations.push(`${id}: status is 'partial' with no available capability; that is 'unbuilt'`)
    }
  }
  return { valid: violations.length === 0, violations }
}

export function getTier(id) {
  const tier = KLYVARON[id]
  if (!tier) throw new ModelFamilyError(`unknown tier '${id}'; known tiers are ${Object.keys(KLYVARON).join(', ')}`)
  return tier
}

/**
 * A machine-readable family report: what each tier claims, and what backs it.
 *
 * This is the artefact the model cards and the model list are generated from, so the
 * interface cannot show a capability the validator would reject.
 */
export function familyReport() {
  const { valid, violations } = validateFamily()
  return {
    valid,
    violations,
    tiers: Object.values(KLYVARON).map((tier) => ({
      id: tier.id,
      displayName: tier.displayName,
      targetHardware: tier.targetHardware,
      description: tier.description,
      status: tier.status,
      statusNote: tier.statusNote ?? null,
      storage: tier.storageProfile,
      capabilityCount: Object.keys(tier.capabilities).length,
      availableCapabilities: Object.entries(tier.capabilities)
        .filter(([, c]) => c.state === CAPABILITY_STATES.AVAILABLE).map(([name]) => name),
      capabilities: tier.capabilities,
    })),
  }
}

/** Can this tier run on a device of the given class, per its declared target? */
export function tierFitsHardware(id, hardwareClass) {
  const tier = getTier(id)
  const order = [HARDWARE_CLASS.MOBILE, HARDWARE_CLASS.LAPTOP, HARDWARE_CLASS.DESKTOP,
    HARDWARE_CLASS.WORKSTATION, HARDWARE_CLASS.REMOTE]
  return order.indexOf(hardwareClass) >= order.indexOf(tier.targetHardware)
}
