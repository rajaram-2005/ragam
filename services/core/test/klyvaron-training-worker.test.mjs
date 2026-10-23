import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AuditLedger } from '../src/audit/ledger.mjs'
import { LocalTrainingWorkerManager, APPROVED_CORPUS_LICENCES, INTERACTIVE_ADAPTATION_LIMIT_MS } from '../src/klyvaron/training-worker.mjs'

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
    consent: { confirmed: true, disclosureDigest: plan.disclosureDigest },
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
    consent: { confirmed: true, disclosureDigest: plan2.disclosureDigest },
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
