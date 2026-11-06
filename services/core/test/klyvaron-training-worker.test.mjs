import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AuditLedger } from '../src/audit/ledger.mjs'
import { LocalTrainingWorkerManager, APPROVED_CORPUS_LICENCES, INTERACTIVE_ADAPTATION_LIMIT_MS } from '../src/klyvaron/training-worker.mjs'
import { defaultPythonBinary, pythonCandidates } from '../src/klyvaron/python-executable.mjs'
import { CONSENT_CLOCK_SKEW_MS, CONSENT_EXPIRY_MS, consentFreshness } from '../src/klyvaron/consent.mjs'

function createApprovedCorpusFixture(dir) {
  const corpusDir = join(dir, 'corpus')
  mkdirSync(join(corpusDir, 'mit_sample'), { recursive: true })
  writeFileSync(join(corpusDir, 'mit_sample', 'sample.txt'), 'Permissive MIT training sample text.\n'.repeat(20))
  const recordPath = join(dir, 'corpus-record.json')
  writeFileSync(recordPath, JSON.stringify({
    clean: true,
    assembled: [{ repo: 'example/mit_sample', sha: '1'.repeat(40), license: 'MIT' }],
    refused: [{ repo: 'example/unlicensed', reason: 'NOASSERTION' }],
  }))
  return { corpusDir, recordPath }
}

test('training worker setup inspects environment, discloses compute/energy/license requirements, and enforces consent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-worker-plan-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)
  const manager = new LocalTrainingWorkerManager({ root, ledger })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const env = manager.inspectEnvironment()
  assert.ok(env.hardware.logicalCpus >= 1)
  assert.ok(env.hardware.totalRamBytes > 0)
  assert.ok(env.hardware.freeDiskBytes > 0)
  assert.equal(typeof env.software.pythonAvailable, 'boolean')

  const foundationPlan = manager.prepareSetupPlan({
    preset: 'pro',
    mode: 'foundation_training',
    pretrainSteps: 20,
    jointSteps: 20,
    corpusDir,
    corpusRecord: recordPath,
  })
  assert.equal(foundationPlan.plan.artifactId, 'klyvaron-pro-lm')
  assert.equal(foundationPlan.plan.parameterCount, 27_559_946)
  assert.equal(foundationPlan.plan.mode, 'foundation_training')
  assert.ok(foundationPlan.plan.resourceLimits.maxDurationMs >= 3_600_000)
  assert.ok(foundationPlan.plan.disclosures.compute.estimatedFlops > 0)
  assert.ok(foundationPlan.plan.disclosures.energyAndThermal.estimatedEnergyWattHours > 0)
  assert.deepEqual(foundationPlan.plan.disclosures.dataAndLicensing.approvedSpdxLicences, APPROVED_CORPUS_LICENCES)
  assert.ok(foundationPlan.externalExecutionNote.externalCommand.includes('--preset pro'))
  assert.match(foundationPlan.disclosureDigest, /^[0-9a-f]{64}$/)

  // Interactive adaptation enforces the strict 2-minute ceiling without applying it to foundation runs.
  const overBudgetAdaptation = manager.prepareSetupPlan({
    preset: 'max',
    mode: 'interactive_adaptation',
    pretrainSteps: 250,
    jointSteps: 250,
    corpusDir,
    corpusRecord: recordPath,
  })
  assert.equal(overBudgetAdaptation.plan.resourceLimits.maxDurationMs, INTERACTIVE_ADAPTATION_LIMIT_MS)
  assert.equal(overBudgetAdaptation.readyToAuthorize, false)
  assert.ok(overBudgetAdaptation.blockers.some((r) => r.includes('120s ceiling')))

  // Missing or mismatched consent is strictly refused before spawning any child process.
  assert.throws(() => manager.startJob({
    planRequest: { preset: 'pro', mode: 'foundation_training', pretrainSteps: 20, jointSteps: 20, corpusDir, corpusRecord: recordPath },
    consent: null,
  }), { code: 'training_consent_required' })

  assert.throws(() => manager.startJob({
    planRequest: { preset: 'pro', mode: 'foundation_training', pretrainSteps: 20, jointSteps: 20, corpusDir, corpusRecord: recordPath },
    consent: {
      confirmed: true,
      disclosureDigest: '0'.repeat(64),
    },
  }), { code: 'training_consent_required' })
})

test('training worker supports live progress, SIGTERM atomic checkpoint cancellation, persistence, and resume', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-worker-exec-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const mockTrainer = join(root, 'mock_trainer.py')
  writeFileSync(mockTrainer, [
    'import argparse, os, signal, sys, time',
    'from pathlib import Path',
    'p = argparse.ArgumentParser()',
    'p.add_argument("--preset")',
    'p.add_argument("--work-dir", type=Path)',
    'p.add_argument("--install-root", type=Path)',
    'p.add_argument("--corpus-dir", type=Path)',
    'p.add_argument("--corpus-record", type=Path)',
    'p.add_argument("--pretrain-steps", type=int)',
    'p.add_argument("--joint-steps", type=int)',
    'p.add_argument("--batch-size", type=int)',
    'p.add_argument("--checkpoint-every", type=int)',
    'p.add_argument("--keep-checkpoint", action="store_true")',
    'p.add_argument("--skip-cards", action="store_true")',
    'p.add_argument("--resume", action="store_true")',
    'args = p.parse_args()',
    'aid = "klyvaron-pro-lm" if args.preset == "pro" else "klyvaron-max-lm"',
    'rdir = args.work_dir / f"{aid}-run"',
    'rdir.mkdir(parents=True, exist_ok=True)',
    'ckpt = rdir / f"{aid}.checkpoint.npz"',
    'stop = False',
    'def handler(sig, frm):',
    '    global stop; stop = True',
    'signal.signal(signal.SIGTERM, handler)',
    'total = args.pretrain_steps + args.joint_steps',
    'start = int(ckpt.read_text()) if (args.resume and ckpt.exists()) else 0',
    'for step in range(start + 1, total + 1):',
    '    print(f"[{aid}] step {step:3d}/{total} (pretrain ) | loss=6.1234 (lm=6.1234 v=0.4000 s=1.2000) | gnorm=1.500 | 500 tok/s | rss=256MB", flush=True)',
    '    if stop:',
    '        tmp = rdir / ".tmp.ckpt"',
    '        tmp.write_text(str(step))',
    '        os.replace(tmp, ckpt)',
    '        print(f"[{aid}] atomic checkpoint saved at step {step} (sha256=abcdef0123456789...)", flush=True)',
    '        sys.exit(130)',
    '    time.sleep(0.12)',
    'ckpt.unlink(missing_ok=True)',
    'print(f"[{aid}] COMPLETE", flush=True)',
  ].join('\n'))

  const manager = new LocalTrainingWorkerManager({
    root,
    ledger,
    trainScript: mockTrainer,
  })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const req = { preset: 'pro', mode: 'foundation_training', pretrainSteps: 6, jointSteps: 6, corpusDir, corpusRecord: recordPath }
  const plan = manager.prepareSetupPlan(req)
  const started = manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest, createdAt: Date.now() },
    actor: 'owner-1',
  })
  assert.equal(started.state, 'running')

  for (let i = 0; i < 40 && manager.getJob(started.id).progress.step < 2; i += 1) {
    await delay(50)
  }
  manager.cancelJob(started.id, { actor: 'owner-1' })
  for (let i = 0; i < 40 && manager.getJob(started.id).state === 'running'; i += 1) {
    await delay(50)
  }
  const cancelled = manager.getJob(started.id)
  assert.equal(cancelled.state, 'cancelled_checkpointed')
  assert.equal(cancelled.checkpointVerified, true)
  assert.ok(existsSync(cancelled.checkpointPath))

  // Recreate manager from disk (`jobs.json`) to verify restart persistence, then `--resume` to completion!
  const reloadedManager = new LocalTrainingWorkerManager({
    root,
    ledger,
    trainScript: mockTrainer,
  })
  assert.equal(reloadedManager.getJob(started.id).checkpointVerified, true)

  const plan2 = reloadedManager.prepareSetupPlan(req)
  const resumed = reloadedManager.startJob({
    planRequest: req,
    resumeFromJobId: started.id,
    consent: { confirmed: true, disclosureDigest: plan2.disclosureDigest, createdAt: Date.now() },
    actor: 'owner-1',
  })
  for (let i = 0; i < 60 && reloadedManager.getJob(resumed.id).state === 'running'; i += 1) {
    await delay(60)
  }
  const finished = reloadedManager.getJob(resumed.id)
  assert.equal(finished.state, 'completed')
  assert.equal(finished.progress.step, 12)
  reloadedManager.close()
})

// ── Regression: stable preflight snapshot & live-resource separation ──────

test('regression: valid consented preflight starts despite harmless free-disk variation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-reg-disk-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const mockTrainer = join(root, 'mock_trainer.py')
  writeFileSync(mockTrainer, [
    'import argparse, os, signal, sys, time',
    'from pathlib import Path',
    'p = argparse.ArgumentParser()',
    'p.add_argument("--preset")',
    'p.add_argument("--work-dir", type=Path)',
    'p.add_argument("--install-root", type=Path)',
    'p.add_argument("--corpus-dir", type=Path)',
    'p.add_argument("--corpus-record", type=Path)',
    'p.add_argument("--pretrain-steps", type=int)',
    'p.add_argument("--joint-steps", type=int)',
    'p.add_argument("--batch-size", type=int)',
    'p.add_argument("--checkpoint-every", type=int)',
    'p.add_argument("--keep-checkpoint", action="store_true")',
    'p.add_argument("--skip-cards", action="store_true")',
    'p.add_argument("--resume", action="store_true")',
    'args = p.parse_args()',
    'aid = "klyvaron-pro-lm" if args.preset == "pro" else "klyvaron-max-lm"',
    'rdir = args.work_dir / f"{aid}-run"',
    'rdir.mkdir(parents=True, exist_ok=True)',
    'ckpt = rdir / f"{aid}.checkpoint.npz"',
    'stop = False',
    'def handler(sig, frm):',
    '    global stop; stop = True',
    'signal.signal(signal.SIGTERM, handler)',
    'total = args.pretrain_steps + args.joint_steps',
    'start = int(ckpt.read_text()) if (args.resume and ckpt.exists()) else 0',
    'for step in range(start + 1, total + 1):',
    '    print(f"[{aid}] step {step:3d}/{total} (pretrain ) | loss=6.1234 | gnorm=1.500 | 500 tok/s | rss=256MB", flush=True)',
    '    if stop:',
    '        tmp = rdir / ".tmp.ckpt"',
    '        tmp.write_text(str(step))',
    '        os.replace(tmp, ckpt)',
    '        print(f"[{aid}] atomic checkpoint saved at step {step}", flush=True)',
    '        sys.exit(130)',
    '    time.sleep(0.05)',
    'ckpt.unlink(missing_ok=True)',
    'print(f"[{aid}] COMPLETE", flush=True)',
  ].join('\n'))

  const manager = new LocalTrainingWorkerManager({ root, ledger, trainScript: mockTrainer })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const req = { preset: 'pro', mode: 'foundation_training', pretrainSteps: 3, jointSteps: 3, corpusDir, corpusRecord: recordPath }

  // Two prepareSetupPlan calls with the same params must produce the same disclosureDigest
  const plan1 = manager.prepareSetupPlan(req)
  const plan2 = manager.prepareSetupPlan(req)
  assert.equal(plan1.disclosureDigest, plan2.disclosureDigest, 'disclosureDigest must be stable across calls with identical plan parameters')

  // Consent from plan1 must start the job even though liveFreeDiskBytes may differ
  const started = manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan1.disclosureDigest, createdAt: Date.now() },
    actor: 'owner-1',
  })
  assert.equal(started.state, 'running')

  // Wait for completion
  for (let i = 0; i < 60 && manager.getJob(started.id).state === 'running'; i += 1) {
    await delay(50)
  }
  const finished = manager.getJob(started.id)
  assert.equal(finished.state, 'completed')
})

test('regression: consent rejected when material plan parameters change', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-reg-change-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const manager = new LocalTrainingWorkerManager({ root, ledger })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  // Base plan
  const basePlan = manager.prepareSetupPlan({
    preset: 'pro', mode: 'foundation_training', pretrainSteps: 10, jointSteps: 10, corpusDir, corpusRecord: recordPath,
  })

  // Each material change must produce a different disclosureDigest
  // All variants use parameters that pass preflight (no ceiling violation, corpus exists)
  const variantCorpusDir = join(root, 'corpus-variant')
  mkdirSync(join(variantCorpusDir, 'mit_sample'), { recursive: true })
  writeFileSync(join(variantCorpusDir, 'mit_sample', 'sample.txt'), 'Permissive MIT training sample text.\n'.repeat(20))
  const variantRecord = join(root, 'corpus-record-variant.json')
  writeFileSync(variantRecord, JSON.stringify({
    clean: true,
    assembled: [{ repo: 'example/mit_sample', sha: '2'.repeat(40), license: 'MIT' }],
    refused: [],
  }))

  const variants = [
    { preset: 'max', mode: 'foundation_training', pretrainSteps: 10, jointSteps: 10, corpusDir, corpusRecord: recordPath },
    { preset: 'pro', mode: 'interactive_adaptation', pretrainSteps: 2, jointSteps: 2, corpusDir, corpusRecord: recordPath },
    { preset: 'pro', mode: 'foundation_training', pretrainSteps: 11, jointSteps: 10, corpusDir, corpusRecord: recordPath },
    { preset: 'pro', mode: 'foundation_training', pretrainSteps: 10, jointSteps: 11, corpusDir, corpusRecord: recordPath },
    { preset: 'pro', mode: 'foundation_training', pretrainSteps: 10, jointSteps: 10, corpusDir: variantCorpusDir, corpusRecord: variantRecord },
  ]

  for (const variant of variants) {
    const variantPlan = manager.prepareSetupPlan(variant)
    assert.notEqual(variantPlan.disclosureDigest, basePlan.disclosureDigest,
      `Changing material parameters must change the disclosureDigest`)

    // Consent from base plan must be rejected for the variant
    assert.throws(() => manager.startJob({
      planRequest: variant,
      consent: { confirmed: true, disclosureDigest: basePlan.disclosureDigest, createdAt: Date.now() },
    }), { code: 'training_consent_required' })
  }
})

test('regression: missing, false, expired, and invalid consent are all rejected', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-reg-consent-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const manager = new LocalTrainingWorkerManager({ root, ledger })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const req = { preset: 'pro', mode: 'foundation_training', pretrainSteps: 5, jointSteps: 5, corpusDir, corpusRecord: recordPath }
  const plan = manager.prepareSetupPlan(req)

  // Missing consent
  assert.throws(() => manager.startJob({ planRequest: req, consent: null }), { code: 'training_consent_required' })

  // False consent
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: false, disclosureDigest: plan.disclosureDigest, createdAt: Date.now() },
  }), { code: 'training_consent_required' })

  // Expired consent (createdAt in the past beyond PREFLIGHT_EXPIRY_MS)
  const expiredAt = Date.now() - 31 * 60 * 1000 // 31 minutes ago
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest, createdAt: expiredAt },
  }), { code: 'consent_expired' })

  // Far-future consent is not a never-expiring consent; the clock-skew bound
  // refuses it with the same code.
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest, createdAt: Date.now() + 3_600_000 },
  }), { code: 'consent_expired' })

  // Invalid digest (wrong hash)
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: 'f'.repeat(64), createdAt: Date.now() },
  }), { code: 'training_consent_required' })

  // Missing createdAt timestamp
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest },
  }), { code: 'consent_expired' })
})

test('regression: insufficient current resources block job even with valid prior consent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-reg-resource-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const manager = new LocalTrainingWorkerManager({ root, ledger })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const req = { preset: 'pro', mode: 'foundation_training', pretrainSteps: 5, jointSteps: 5, corpusDir, corpusRecord: recordPath }

  // prepareSetupPlan succeeds with a valid corpus
  const plan = manager.prepareSetupPlan(req)
  assert.equal(plan.readyToAuthorize, true)

  // Delete the corpus directory to simulate it disappearing between plan and job start
  rmSync(corpusDir, { recursive: true, force: true })

  // startJob should fail the live recheck because the corpus directory no longer exists
  assert.throws(() => manager.startJob({
    planRequest: req,
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest, createdAt: Date.now() },
  }), { code: 'preflight_failed' })
})

test('regression: resume requires valid authorization and verified checkpoint', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-reg-resume-'))
  const ledger = new AuditLedger(join(root, 'audit.sqlite'))
  const { corpusDir, recordPath } = createApprovedCorpusFixture(root)

  const manager = new LocalTrainingWorkerManager({ root, ledger })
  t.after(() => { manager.close(); ledger.close(); rmSync(root, { recursive: true, force: true }) })

  const req = { preset: 'pro', mode: 'foundation_training', pretrainSteps: 5, jointSteps: 5, corpusDir, corpusRecord: recordPath }
  const plan = manager.prepareSetupPlan(req)

  // Resume without a valid consent is rejected
  assert.throws(() => manager.startJob({
    planRequest: req,
    resumeFromJobId: 'nonexistent-job-id',
    consent: null,
  }), { code: 'training_consent_required' })

  // Resume with valid consent but no checkpoint file is rejected
  assert.throws(() => manager.startJob({
    planRequest: req,
    resumeFromJobId: 'nonexistent-job-id',
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest, createdAt: Date.now() },
  }), { code: 'checkpoint_missing' })
})

test('AETHERIS_PYTHON is authoritative on the training-worker interpreter path', (t) => {
  // Regression: a virtualenv with NumPy was ignored because the worker only
  // probed conventional /tmp venvs and python3. An explicit configured value
  // must win, and must not silently execute a different interpreter.
  const root = mkdtempSync(join(tmpdir(), 'klyvaron-python-config-'))
  const fakePython = join(root, 'configured-python')
  writeFileSync(fakePython, '#!/bin/sh\nprintf %s \'{"python":"3.11.9","numpy":"2.4.6","jax":null}\'\n')
  chmodSync(fakePython, 0o755)
  const previous = process.env.AETHERIS_PYTHON
  process.env.AETHERIS_PYTHON = fakePython
  const manager = new LocalTrainingWorkerManager({ root: join(root, 'worker') })
  t.after(() => {
    manager.close()
    if (previous === undefined) delete process.env.AETHERIS_PYTHON
    else process.env.AETHERIS_PYTHON = previous
    rmSync(root, { recursive: true, force: true })
  })

  assert.deepEqual(pythonCandidates(['fallback'], { AETHERIS_PYTHON: '/configured/python' }), ['/configured/python'])
  assert.equal(defaultPythonBinary({}), 'python3')
  const environment = manager.inspectEnvironment()
  assert.equal(environment.software.pythonBinary, fakePython)
  assert.equal(environment.software.pythonVersion, '3.11.9')
  assert.equal(environment.software.numpyVersion, '2.4.6')
})

test('shared consent freshness refuses missing, stale and future-dated timestamps', () => {
  const now = 1_800_000_000_000
  assert.equal(consentFreshness({ createdAt: now }, { now }).valid, true)
  assert.equal(consentFreshness({}, { now }).reason, 'missing_timestamp')
  assert.equal(consentFreshness({ createdAt: now - CONSENT_EXPIRY_MS - 1 }, { now }).reason, 'expired')
  assert.equal(consentFreshness({ createdAt: now + CONSENT_CLOCK_SKEW_MS + 1 }, { now }).reason, 'future_dated')
  assert.equal(consentFreshness({ createdAt: now + CONSENT_CLOCK_SKEW_MS - 1 }, { now }).valid, true,
    'ordinary browser/host clock drift remains tolerated')
})
