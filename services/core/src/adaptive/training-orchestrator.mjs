// Adaptive's training-facing role is deliberately limited to planning and evaluation.
// It chooses among explicit training modes from user intent and available evidence; the
// paired local training worker remains the only component that can update model weights.

const FALLBACK_MODE = 'memory_or_retrieval'

/**
 * Plan a user-computer adaptation request. This function never starts a worker or changes
 * weights. In particular, an absent/failed local worker is evidence for a blocked plan,
 * not permission to route training to this server or a hosted provider.
 */
export function planAdaptiveTraining({
  requestedMode = null,
  validModes,
  exampleCount = 0,
  hasAuthorizedCorpus = false,
  ephemeralContext = false,
  allowSingleExampleAdapter = false,
  localWorkerConnected = false,
  workerCompatible = null,
  priorOutcomes = [],
}) {
  if (!Array.isArray(validModes) || !validModes.includes(FALLBACK_MODE)) {
    throw new TypeError(`validModes must include '${FALLBACK_MODE}'`)
  }

  let selectedMode = requestedMode
  let rationale
  let selection = 'user_explicit'
  if (!selectedMode) {
    selection = 'adaptive_auto'
    if (exampleCount === 0 && ephemeralContext) {
      selectedMode = 'context_only'
      rationale = 'Ephemeral session context is sufficient; no stored data or weight changes are needed.'
    } else if (exampleCount <= 1 && !hasAuthorizedCorpus) {
      selectedMode = FALLBACK_MODE
      rationale = 'A single correction is better represented as explicitly authorized memory/retrieval than as a weight update.'
    } else if (hasAuthorizedCorpus) {
      selectedMode = 'foundation_pretrain'
      rationale = 'An explicitly authorized corpus was supplied; a separately budgeted corpus-training mode is proposed.'
    } else {
      selectedMode = 'lightweight_adapter'
      rationale = `${exampleCount} user-supplied example(s) were provided; a bounded LoRA adapter is proposed, subject to explicit consent and local resource checks.`
    }
  } else {
    if (!validModes.includes(selectedMode)) {
      const error = new TypeError(`Unsupported training mode '${selectedMode}'.`)
      error.code = 'invalid_mode'
      throw error
    }
    rationale = selectedMode === 'lightweight_adapter' && exampleCount === 1 && !allowSingleExampleAdapter
      ? 'The user explicitly requested LoRA for one correction; memory/retrieval is normally preferred, but no silent mode change is made.'
      : `The user explicitly requested '${selectedMode}'; Adaptive preserves that choice and evaluates its constraints.`
  }

  const previous = priorOutcomes.filter((outcome) => outcome?.mode === selectedMode)
  const successes = previous.filter((outcome) => outcome.passed === true).length
  const failures = previous.filter((outcome) => outcome.passed === false).length

  return {
    skill: 'adaptive',
    role: 'orchestrate_and_evaluate',
    selection,
    requestedMode,
    selectedMode,
    weightUpdateMethod: ['lightweight_adapter', 'full_fine_tune', 'foundation_pretrain'].includes(selectedMode)
      ? selectedMode
      : null,
    foundationScope: {
      activeBase: 'installed_native_klyvaron_checkpoint_or_native_architecture',
      licensedOpenFoundationFineTuning: 'not_implemented',
    },
    rationale,
    evidence: {
      userExampleCount: exampleCount,
      authorizedCorpusProvided: hasAuthorizedCorpus,
      ephemeralContextProvided: Boolean(ephemeralContext),
      localWorkerConnected: Boolean(localWorkerConnected),
      workerCompatible,
      priorEvaluationsForSelectedMode: previous.length,
      priorPassed: successes,
      priorFailed: failures,
    },
    safeguards: {
      executionEnvironment: 'paired_user_computer_only',
      workerPairingRequiredForWeightUpdates: true,
      explicitConsentRequired: true,
      privateConversationAutoIngestion: false,
      localToCloudFallback: false,
      interactiveAdapterMaxDurationMs: 120_000,
      longerTrainingRequiresSeparateBudget: true,
      validationAndRollbackRequired: true,
    },
  }
}

/** Summarize existing independent worker gates; Adaptive cannot make a failed gate pass. */
export function evaluateAdaptiveTraining({
  mode,
  artifactValid = false,
  evaluationPassed = false,
  nativeInferencePassed = false,
  rolledBack = false,
  measuredWallMs = null,
} = {}) {
  const checks = {
    artifactValid: artifactValid === true,
    evaluationPassed: evaluationPassed === true,
    nativeInferencePassed: nativeInferencePassed === true,
    notRolledBack: rolledBack !== true,
  }
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  return {
    skill: 'adaptive',
    mode,
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    measuredWallMs: Number.isFinite(measuredWallMs) ? Math.max(0, Math.round(measuredWallMs)) : null,
    canPromote: failedChecks.length === 0,
    note: 'Promotion remains controlled by the independent model release gates; this evaluation does not override them.',
  }
}
