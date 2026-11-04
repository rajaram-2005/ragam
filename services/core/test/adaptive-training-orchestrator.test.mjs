import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateAdaptiveTraining, planAdaptiveTraining } from '../src/adaptive/training-orchestrator.mjs'
import { TRAINING_MODES } from '../src/klyvaron/training-controller.mjs'

const plan = (overrides = {}) => planAdaptiveTraining({ validModes: TRAINING_MODES, ...overrides })

test('Adaptive recommends context or retrieval before changing weights for small requests', () => {
  const ephemeral = plan({ ephemeralContext: true })
  assert.equal(ephemeral.skill, 'adaptive')
  assert.equal(ephemeral.selectedMode, 'context_only')
  assert.equal(ephemeral.weightUpdateMethod, null)

  const oneCorrection = plan({ exampleCount: 1 })
  assert.equal(oneCorrection.selectedMode, 'memory_or_retrieval')
  assert.equal(oneCorrection.selection, 'adaptive_auto')
})

test('Adaptive proposes bounded LoRA or separate corpus training from explicit evidence', () => {
  const adapter = plan({ exampleCount: 4, localWorkerConnected: true })
  assert.equal(adapter.selectedMode, 'lightweight_adapter')
  assert.equal(adapter.weightUpdateMethod, 'lightweight_adapter')
  assert.equal(adapter.safeguards.executionEnvironment, 'paired_user_computer_only')
  assert.equal(adapter.safeguards.interactiveAdapterMaxDurationMs, 120_000)
  assert.equal(adapter.foundationScope.licensedOpenFoundationFineTuning, 'not_implemented')

  const corpus = plan({ exampleCount: 20, hasAuthorizedCorpus: true })
  assert.equal(corpus.selectedMode, 'foundation_pretrain')
  assert.equal(corpus.evidence.authorizedCorpusProvided, true)
})

test('Adaptive preserves explicit user mode and records previous evidence without routing to cloud', () => {
  const decision = plan({
    requestedMode: 'full_fine_tune',
    exampleCount: 4,
    localWorkerConnected: false,
    workerCompatible: false,
    priorOutcomes: [{ mode: 'full_fine_tune', passed: false }],
  })
  assert.equal(decision.selectedMode, 'full_fine_tune')
  assert.equal(decision.selection, 'user_explicit')
  assert.equal(decision.evidence.priorFailed, 1)
  assert.equal(decision.safeguards.localToCloudFallback, false)
  assert.equal(decision.safeguards.privateConversationAutoIngestion, false)
})

test('Adaptive evaluation never promotes an artifact that fails an independent gate or was rolled back', () => {
  const passed = evaluateAdaptiveTraining({
    mode: 'lightweight_adapter', artifactValid: true, evaluationPassed: true, nativeInferencePassed: true,
  })
  assert.equal(passed.passed, true)
  assert.equal(passed.canPromote, true)

  const rejected = evaluateAdaptiveTraining({
    mode: 'lightweight_adapter', artifactValid: true, evaluationPassed: true,
    nativeInferencePassed: true, rolledBack: true,
  })
  assert.equal(rejected.passed, false)
  assert.equal(rejected.canPromote, false)
  assert.deepEqual(rejected.failedChecks, ['notRolledBack'])
})
