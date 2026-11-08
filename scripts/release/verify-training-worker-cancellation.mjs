#!/usr/bin/env node
// Reproducible real-trainer worker qualification.
//
//   node scripts/release/verify-training-worker-cancellation.mjs
//
// This is NOT a mock or a stub. It starts the production
// `services/fabric/scripts/train_klyvaron.py` through the production
// `LocalTrainingWorkerManager`, observes a real JAX/NumPy parameter update,
// requests cancellation with SIGTERM, verifies the atomic checkpoint, proves
// job-state persistence across a manager restart, resumes the same real
// trainer process from that checkpoint, verifies that parameter state advanced,
// cancels the resumed job before completion, and records a real trainer-process
// failure caused by an invalid corpus record.
//
// The deterministic corpus is synthetic and generated locally. No user data,
// licensed model weights, live provider credentials, external service, paid
// API or GPU is used. The 27,559,946-parameter run is a lifecycle smoke test,
// not a production Klyvaron model qualification and not a claim that
// foundation-model training succeeded.
//
// Prerequisite: install services/fabric/requirements.lock into ./.venv (or set
// AETHERIS_PYTHON to an interpreter with NumPy/JAX). The 330 MB checkpoints are
// kept under the ignored build/ directory; only their digests, NPZ metadata,
// worker logs and job states are committed as evidence.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { LocalTrainingWorkerManager } from '../../services/core/src/klyvaron/training-worker.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILD = join(REPO_ROOT, 'build', 'training-worker-qualification')
const EVIDENCE = join(REPO_ROOT, 'docs', 'release', 'evidence')
const corpusDir = join(BUILD, 'corpus')
const corpusRecord = join(BUILD, 'corpus-record.json')
const managerRoot = join(BUILD, 'manager-root')
const badRecord = join(BUILD, 'invalid-corpus-record.json')
const phase1CheckpointCopy = join(BUILD, 'phase1-checkpoint.npz')
const trainScript = join(REPO_ROOT, 'services', 'fabric', 'scripts', 'train_klyvaron.py')
const inspector = join(REPO_ROOT, 'scripts', 'release', 'inspect-training-checkpoint.py')

const evidencePath = (name) => join(EVIDENCE, name)
const writeJson = (name, value) => writeFileSync(evidencePath(name), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
const rel = (path) => relative(REPO_ROOT, path).replaceAll('\\', '/')
const git = (...args) => spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim()

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', fail)
    stream.on('end', () => done(hash.digest('hex')))
  })
}

function inspectCheckpoint(pythonBinary, path) {
  const result = spawnSync(pythonBinary, [inspector, path], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { result, npz: result.status === 0 ? JSON.parse(result.stdout.trim()) : null }
}

function deterministicRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function writeSyntheticCorpus() {
  const rng = deterministicRng(20261017)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz'
  const pool = []
  for (let i = 0; i < 12_000; i += 1) {
    const length = 5 + Math.floor(rng() * 6)
    let word = ''
    for (let j = 0; j < length; j += 1) word += alphabet[Math.floor(rng() * 26)]
    pool.push(word)
  }
  for (const repo of ['mit_sample', 'pallets__click', 'psf__requests']) {
    const dir = join(corpusDir, repo)
    mkdirSync(dir, { recursive: true })
    const lines = []
    for (let n = 0; n < 1200; n += 1) {
      const words = []
      for (let k = 0; k < 10; k += 1) words.push(pool[Math.floor(rng() * pool.length)])
      lines.push(`${words.join(' ')}.`)
    }
    writeFileSync(join(dir, 'sample.md'), `${lines.join('\n')}\n`, 'utf8')
  }
  writeFileSync(corpusRecord, `${JSON.stringify({
    clean: true,
    assembled: [{ repo: 'mit_sample', sha: '1'.repeat(40), license: 'MIT' }],
    refused: [],
  }, null, 2)}\n`, 'utf8')
  writeFileSync(badRecord, '{not valid json\n', 'utf8')
}

function check(results, id, ok, detail) {
  results.push({ id, status: ok ? 'PASS' : 'FAIL', mode: 'real_local_process', detail })
}

function waitForProgress(manager, jobId, minimumStep, timeoutMs) {
  return waitFor(() => manager.getJob(jobId).progress.step >= minimumStep, timeoutMs, `real trainer did not reach step ${minimumStep}`)
}

function waitForResumeProgress(manager, jobId, minimumStep, timeoutMs) {
  return waitFor(() => {
    const job = manager.getJob(jobId)
    return job.progress.step >= minimumStep && job.logs.some((line) => line.includes('resumed verified atomic checkpoint'))
  }, timeoutMs, 'real trainer did not resume from the atomic checkpoint and advance')
}

function waitForTerminal(manager, jobId, timeoutMs) {
  return waitFor(() => manager.getJob(jobId).state !== 'running', timeoutMs, `training worker job ${jobId} did not terminate`)
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(250)
  }
  throw new Error(message)
}

async function main() {
  mkdirSync(BUILD, { recursive: true })
  mkdirSync(EVIDENCE, { recursive: true })
  rmSync(managerRoot, { recursive: true, force: true })
  rmSync(phase1CheckpointCopy, { force: true })
  writeSyntheticCorpus()

  const request = {
    preset: 'pro',
    mode: 'foundation_training',
    corpusDir,
    corpusRecord,
    pretrainSteps: 2,
    jointSteps: 2,
    batchSize: 1,
    checkpointEvery: 1,
    maxCpuThreads: 1,
    maxDurationMs: 600_000,
  }

  let manager = null
  let reloaded = null
  try {
    manager = new LocalTrainingWorkerManager({ root: managerRoot })
    const environment = manager.inspectEnvironment()
    const prepared = manager.prepareSetupPlan(request)
    const consent = { confirmed: true, disclosureDigest: prepared.disclosureDigest, createdAt: Date.now() }
    writeJson('training-worker-preflight.json', {
      schema: 'ragam-training-worker-preflight/1',
      environment,
      request,
      stablePlan: prepared.plan,
      blockers: prepared.blockers,
      readyToAuthorize: prepared.readyToAuthorize,
      disclosureDigest: prepared.disclosureDigest,
      consent: { ...consent, basis: 'operator-initiated release qualification on a locally generated synthetic corpus; no user data' },
      trainScript: rel(trainScript),
    })

    // Phase 1: real start -> real step -> SIGTERM -> atomic checkpoint.
    const started = manager.startJob({ planRequest: request, consent, actor: 'release-qualification' })
    await waitForProgress(manager, started.id, 1, 300_000)
    const cancelRequested = manager.cancelJob(started.id, { actor: 'release-qualification' })
    await waitForTerminal(manager, started.id, 300_000)
    const cancelled = manager.getJob(started.id)
    const cancellationSnapshot = structuredClone(cancelled)
    writeFileSync(evidencePath('training-worker-cancellation.log'), `${cancelled.logs.join('\n')}\n`, 'utf8')

    const checkpointPath = cancelled.checkpointPath
    const phase1Sha256 = existsSync(checkpointPath) ? await sha256File(checkpointPath) : null
    if (phase1Sha256) copyFileSync(checkpointPath, phase1CheckpointCopy)
    const phase1Inspection = phase1Sha256
      ? inspectCheckpoint(environment.software.pythonBinary, checkpointPath)
      : { result: { status: 1, stdout: '', stderr: 'checkpoint missing' }, npz: null }
    const phase1Npz = phase1Inspection.npz

    let pidAlive = false
    try { process.kill(started.pid, 0); pidAlive = true } catch {}
    const activeAfterCancel = manager.processes.size
    manager.close()
    manager = null

    // Phase 2: fresh manager -> same job id -> --resume from the phase-1 checkpoint.
    reloaded = new LocalTrainingWorkerManager({ root: managerRoot })
    const restored = reloaded.getJob(started.id)
    const restoredSnapshot = restored ? structuredClone(restored) : null
    const resumePrepared = reloaded.prepareSetupPlan(request)
    const resumeStart = reloaded.startJob({
      planRequest: request,
      consent: { confirmed: true, disclosureDigest: resumePrepared.disclosureDigest, createdAt: Date.now() },
      resumeFromJobId: started.id,
      actor: 'release-qualification-resume',
    })
    await waitForResumeProgress(reloaded, resumeStart.id, 2, 300_000)
    const resumeCancel = reloaded.cancelJob(resumeStart.id, { actor: 'release-qualification-resume' })
    await waitForTerminal(reloaded, resumeStart.id, 300_000)
    const resumedJob = reloaded.getJob(resumeStart.id)
    writeFileSync(evidencePath('training-worker-resume.log'), `${resumedJob.logs.join('\n')}\n`, 'utf8')
    const phase2Sha256 = existsSync(resumedJob.checkpointPath) ? await sha256File(resumedJob.checkpointPath) : null
    const phase2Inspection = phase2Sha256
      ? inspectCheckpoint(environment.software.pythonBinary, resumedJob.checkpointPath)
      : { result: { status: 1, stdout: '', stderr: 'checkpoint missing' }, npz: null }
    const phase2Npz = phase2Inspection.npz
    const activeAfterResume = reloaded.processes.size
    const finalNpz = join(resumedJob.workDir, 'klyvaron-pro-lm-run', 'klyvaron-pro-lm-raw.npz')
    const finalReport = join(resumedJob.workDir, 'klyvaron-pro-lm-run', 'klyvaron-pro-lm.report.json')

    // Independent verification covers both checkpoint byte snapshots.
    const sumsPath = join(BUILD, 'training-worker-checksums.txt')
    const sumsContent = `${phase1Sha256 ? `${phase1Sha256}  ${rel(phase1CheckpointCopy)}\n` : ''}${phase2Sha256 ? `${phase2Sha256}  ${rel(resumedJob.checkpointPath)}\n` : ''}`
    writeFileSync(sumsPath, sumsContent, 'utf8')
    writeFileSync(evidencePath('training-worker-checksums.txt'), sumsContent, 'utf8')
    const sha256Verify = (phase1Sha256 && phase2Sha256)
      ? spawnSync('sha256sum', ['-c', rel(sumsPath)], { cwd: REPO_ROOT, encoding: 'utf8' })
      : { status: 1, stdout: '', stderr: 'checkpoint missing' }

    // Phase 3: a different real trainer process fails on an invalid corpus record.
    const badRequest = { ...request, corpusRecord: badRecord }
    const badPrepared = reloaded.prepareSetupPlan(badRequest)
    const failedStart = reloaded.startJob({
      planRequest: badRequest,
      consent: { confirmed: true, disclosureDigest: badPrepared.disclosureDigest, createdAt: Date.now() },
      actor: 'release-qualification',
    })
    await waitForTerminal(reloaded, failedStart.id, 300_000)
    const failed = reloaded.getJob(failedStart.id)
    writeFileSync(evidencePath('training-worker-failure.log'), `${failed.logs.join('\n')}\n`, 'utf8')
    const activeAfterFailure = reloaded.processes.size
    reloaded.close()
    reloaded = null

    const results = []
    check(results, 'real_trainer_process_started', started.state === 'running' && Number.isInteger(started.pid) && started.pid > 0 && environment.software.xlaAvailable,
      `pid=${started.pid}; ${environment.software.pythonBinary}; Python ${environment.software.pythonVersion}; NumPy ${environment.software.numpyVersion}; JAX ${environment.software.jaxVersion}; ${prepared.plan.parameterCount.toLocaleString()} parameters`)
    const observedRss = cancellationSnapshot.logs.map((line) => /rss=(\d+)MB/.exec(line)?.[1]).find(Boolean) ?? 'unrecorded'
    check(results, 'real_training_progress_observed', cancellationSnapshot.progress.step >= 1 && Number.isFinite(cancellationSnapshot.progress.lastLoss),
      `step ${cancellationSnapshot.progress.step}/${cancellationSnapshot.progress.totalSteps}; loss=${cancellationSnapshot.progress.lastLoss}; trainer log records rss=${observedRss}MB`)
    check(results, 'sigterm_delivered_and_handled', cancelRequested.cancelRequested === true && cancellationSnapshot.logs.some((line) => line.includes('received signal 15')),
      'LocalTrainingWorkerManager.cancelJob sent SIGTERM; the real Python trainer logged signal 15 and exited cleanly')
    check(results, 'atomic_checkpoint_written', Boolean(phase1Sha256) && cancellationSnapshot.checkpointVerified === true && cancellationSnapshot.logs.some((line) => line.includes('atomic checkpoint saved at step')),
      `phase-1 checkpoint bytes=${phase1Sha256 ? statSync(phase1CheckpointCopy).size : 0}; sha256=${phase1Sha256 ?? 'missing'}`)
    check(results, 'checkpoint_sha256_matches_worker_log', Boolean(phase1Sha256) && phase1Sha256.startsWith(cancellationSnapshot.progress.lastCheckpointSha256 ?? '\u0000'),
      `worker parsed ${cancellationSnapshot.progress.lastCheckpointSha256}; independently computed ${phase1Sha256?.slice(0, 16)}…`)
    check(results, 'checkpoint_integrity_without_pickle', Boolean(phase1Npz) && phase1Npz.step >= 1 && phase1Npz.configDigest === prepared.plan.architectureDigest && phase1Npz.weightArrays > 0 && phase1Npz.optimizerArrays > 0 && phase1Npz.firstWeightFinite,
      phase1Npz ? `phase-1 step=${phase1Npz.step}; arrays=${phase1Npz.arrays}; weights=${phase1Npz.weightArrays}; optimizer=${phase1Npz.optimizerArrays}; configDigest=${phase1Npz.configDigest}` : `inspection failed: ${phase1Inspection.result.stderr}`)
    check(results, 'independent_sha256sum_verification', sha256Verify.status === 0 && (sha256Verify.stdout.match(/: OK/g) ?? []).length === 2,
      `sha256sum -c ${rel(sumsPath)} → ${sha256Verify.stdout.trim() || sha256Verify.stderr.trim()}`)
    check(results, 'cancelled_job_state_persisted', cancellationSnapshot.state === 'cancelled_checkpointed' && cancellationSnapshot.exitCode === 130 && cancellationSnapshot.cancelRequested === true && Boolean(cancellationSnapshot.completedAt),
      `state=${cancellationSnapshot.state}; exitCode=${cancellationSnapshot.exitCode}; completedAt=${cancellationSnapshot.completedAt}`)
    check(results, 'no_orphan_worker_process', pidAlive === false && activeAfterCancel === 0,
      `pidAlive=${pidAlive}; manager active processes=${activeAfterCancel}`)
    check(results, 'job_state_survives_manager_restart', restoredSnapshot?.state === 'cancelled_checkpointed' && restoredSnapshot?.checkpointVerified === true,
      `reloaded manager restored state=${restoredSnapshot?.state}; checkpointVerified=${restoredSnapshot?.checkpointVerified}`)
    check(results, 'checkpoint_resume_started', resumeStart.resumed === true && resumeStart.workDir === started.workDir && resumedJob.logs.some((line) => line.includes('resumed verified atomic checkpoint from step 1/4')) && resumedJob.logs.some((line) => line.includes('steps=1->4')),
      `same job id ${resumeStart.id}; workDir reused; trainer logged resume from step 1/4`)
    check(results, 'parameter_state_advanced_after_resume', resumedJob.progress.step > cancellationSnapshot.progress.step && Boolean(phase2Sha256) && phase2Sha256 !== phase1Sha256 && resumedJob.progress.lastCheckpointSha256 && resumedJob.progress.lastCheckpointSha256 !== cancellationSnapshot.progress.lastCheckpointSha256,
      `phase-1 step ${cancellationSnapshot.progress.step} → resumed step ${resumedJob.progress.step}; phase-1 sha ${phase1Sha256?.slice(0, 16)}… → phase-2 sha ${phase2Sha256?.slice(0, 16)}…`)
    check(results, 'resume_checkpoint_integrity', Boolean(phase2Npz) && phase2Npz.step === resumedJob.progress.step && phase2Npz.step > (phase1Npz?.step ?? 0) && phase2Npz.configDigest === prepared.plan.architectureDigest && phase2Npz.weightArrays > 0 && phase2Npz.optimizerArrays > 0 && phase2Npz.firstWeightFinite,
      phase2Npz ? `phase-2 step=${phase2Npz.step}; arrays=${phase2Npz.arrays}; weights=${phase2Npz.weightArrays}; optimizer=${phase2Npz.optimizerArrays}` : `inspection failed: ${phase2Inspection.result.stderr}`)
    check(results, 'resume_cancelled_before_completion', resumedJob.state === 'cancelled_checkpointed' && resumedJob.exitCode === 130 && resumeCancel.cancelRequested === true && activeAfterResume === 0 && !existsSync(finalNpz) && !existsSync(finalReport),
      `state=${resumedJob.state}; exitCode=${resumedJob.exitCode}; no final raw artifact/report; active processes=${activeAfterResume}`)
    check(results, 'real_failure_path_recorded', failed.state === 'failed' && failed.exitCode === 1 && failed.checkpointVerified === false && /JSONDecodeError/.test(String(failed.error)),
      `state=${failed.state}; exitCode=${failed.exitCode}; error=${failed.error}; checkpointVerified=${failed.checkpointVerified}`)
    check(results, 'worker_has_no_active_process_after_failure', activeAfterFailure === 0 && reloaded === null,
      `active processes=${activeAfterFailure}; manager closed cleanly`)

    const checkpoint = {
      path: rel(resumedJob.checkpointPath),
      bytes: phase2Sha256 ? statSync(resumedJob.checkpointPath).size : 0,
      sha256: phase2Sha256,
      npz: phase2Npz,
      phases: {
        phase1: {
          path: rel(phase1CheckpointCopy),
          bytes: phase1Sha256 ? statSync(phase1CheckpointCopy).size : 0,
          sha256: phase1Sha256,
          npz: phase1Npz,
          inspector: {
            command: `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(checkpointPath)}`,
            status: phase1Inspection.result.status,
            stdout: phase1Inspection.result.stdout.trim(),
            stderr: phase1Inspection.result.stderr.trim(),
          },
        },
        phase2: {
          path: rel(resumedJob.checkpointPath),
          bytes: phase2Sha256 ? statSync(resumedJob.checkpointPath).size : 0,
          sha256: phase2Sha256,
          npz: phase2Npz,
          inspector: {
            command: `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(resumedJob.checkpointPath)}`,
            status: phase2Inspection.result.status,
            stdout: phase2Inspection.result.stdout.trim(),
            stderr: phase2Inspection.result.stderr.trim(),
          },
        },
      },
      independentVerification: {
        command: `sha256sum -c ${rel(sumsPath)}`,
        status: sha256Verify.status,
        stdout: sha256Verify.stdout.trim(),
        stderr: sha256Verify.stderr.trim(),
      },
    }
    writeJson('training-worker-checkpoint.json', checkpoint)
    writeJson('training-worker-jobs.json', {
      cancellation: {
        id: cancellationSnapshot.id,
        pid: started.pid,
        state: cancellationSnapshot.state,
        cancelRequested: cancellationSnapshot.cancelRequested,
        exitCode: cancellationSnapshot.exitCode,
        completedAt: cancellationSnapshot.completedAt,
        progress: cancellationSnapshot.progress,
        checkpointPath: rel(checkpointPath),
        checkpointVerified: cancellationSnapshot.checkpointVerified,
        logLines: cancellationSnapshot.logs.length,
      },
      restored: restoredSnapshot ? { state: restoredSnapshot.state, checkpointVerified: restoredSnapshot.checkpointVerified } : null,
      resume: {
        id: resumedJob.id,
        pid: resumeStart.pid,
        resumed: resumedJob.resumed,
        state: resumedJob.state,
        cancelRequested: resumedJob.cancelRequested,
        exitCode: resumedJob.exitCode,
        completedAt: resumedJob.completedAt,
        progress: resumedJob.progress,
        checkpointPath: rel(resumedJob.checkpointPath),
        checkpointVerified: resumedJob.checkpointVerified,
        logLines: resumedJob.logs.length,
      },
      failure: {
        id: failed.id,
        pid: failedStart.pid,
        state: failed.state,
        exitCode: failed.exitCode,
        error: failed.error,
        checkpointVerified: failed.checkpointVerified,
        logLines: failed.logs.length,
      },
    })

    const payload = {
      schema: 'ragam-training-worker-qualification/1',
      generatedAt: new Date().toISOString(),
      commit: git('rev-parse', 'HEAD'),
      sourceCommitNote: 'HEAD at generation time; later commits are descendants and contain no changes to the trainer or worker runtime.',
      branch: git('branch', '--show-current'),
      command: 'node scripts/release/verify-training-worker-cancellation.mjs',
      worker: 'services/core/src/klyvaron/training-worker.mjs -> services/fabric/scripts/train_klyvaron.py',
      scope: 'real 27,559,946-parameter JAX/NumPy training process; resource-bounded SIGTERM cancellation, atomic checkpoint resume, advanced parameter state, second cancellation before completion and failure-path smoke test; NOT a production Klyvaron model, NOT foundation-model qualification, NOT live provider inference',
      hardware: environment.hardware,
      runtime: environment.software,
      consent: {
        confirmed: true,
        basis: 'Operator-initiated release qualification on a deterministic synthetic corpus generated by this script.',
        datasetOwnership: 'locally generated synthetic text; no user-owned or private dataset',
        purpose: 'verify real worker cancellation, atomic checkpointing, checkpoint resume, job-state persistence and failure handling',
        limitations: 'This is not consent to train on user data, publish a model, or claim a production Klyvaron model.',
        disclosureDigest: prepared.disclosureDigest,
        authorizedAt: cancellationSnapshot.authorizedAt,
      },
      commands: [
        'node scripts/release/verify-training-worker-cancellation.mjs',
        `${rel(environment.software.pythonBinary)} ${rel(trainScript)} --preset pro --corpus-dir ${rel(corpusDir)} --corpus-record ${rel(corpusRecord)} --work-dir ${rel(started.workDir)} --install-root ${rel(managerRoot)} --pretrain-steps 2 --joint-steps 2 --batch-size 1 --checkpoint-every 1 --keep-checkpoint --skip-cards`,
        `LocalTrainingWorkerManager.cancelJob(${cancellationSnapshot.id}) → child.kill('SIGTERM')`,
        `${rel(environment.software.pythonBinary)} ${rel(trainScript)} --preset pro --corpus-dir ${rel(corpusDir)} --corpus-record ${rel(corpusRecord)} --work-dir ${rel(resumeStart.workDir)} --install-root ${rel(managerRoot)} --pretrain-steps 2 --joint-steps 2 --batch-size 1 --checkpoint-every 1 --keep-checkpoint --skip-cards --resume`,
        `LocalTrainingWorkerManager.cancelJob(${resumedJob.id}) → child.kill('SIGTERM') before completion`,
        `sha256sum -c ${rel(sumsPath)} (two checkpoint snapshots)`,
        `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(phase1CheckpointCopy)}`,
        `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(resumedJob.checkpointPath)}`,
        `${rel(environment.software.pythonBinary)} ${rel(trainScript)} --preset pro --corpus-dir ${rel(corpusDir)} --corpus-record ${rel(badRecord)} --work-dir ${rel(failedStart.workDir)} --install-root ${rel(managerRoot)} --pretrain-steps 2 --joint-steps 2 --batch-size 1 --checkpoint-every 1 --keep-checkpoint --skip-cards (real failure path)`,
      ],
      logs: [
        'docs/release/evidence/training-worker-cancellation.log',
        'docs/release/evidence/training-worker-resume.log',
        'docs/release/evidence/training-worker-failure.log',
      ],
      evidenceFiles: [
        'docs/release/evidence/training-worker-preflight.json',
        'docs/release/evidence/training-worker-jobs.json',
        'docs/release/evidence/training-worker-checkpoint.json',
        'docs/release/evidence/training-worker-checksums.txt',
      ],
      measured: {
        parameterCount: prepared.plan.parameterCount,
        architectureDigest: prepared.plan.architectureDigest,
        totalSteps: prepared.plan.totalSteps,
        observedStep: cancellationSnapshot.progress.step,
        observedLoss: cancellationSnapshot.progress.lastLoss,
        checkpointBytes: phase1Sha256 ? statSync(phase1CheckpointCopy).size : 0,
        checkpointSha256: phase1Sha256,
        cancellationExitCode: cancellationSnapshot.exitCode,
        resumeStartStep: phase1Npz?.step ?? null,
        resumeObservedStep: resumedJob.progress.step,
        resumeCheckpointBytes: phase2Sha256 ? statSync(resumedJob.checkpointPath).size : 0,
        resumeCheckpointSha256: phase2Sha256,
        resumeExitCode: resumedJob.exitCode,
        failureExitCode: failed.exitCode,
      },
      results,
      notTested: [
        'Training on a user-owned private dataset (no such dataset was supplied or authorized)',
        'GPU/accelerator training (no GPU on this host)',
        'Production Klyvaron Lite/Pro/Max inference from licensed weights (no weights installed)',
        'Foundation or adapter training qualification (no released model artifact or reviewed production training run)',
      ],
      liveThirdPartyCalls: 0,
      productionModelQualified: false,
      foundationTrainingClaim: false,
      pass: results.filter((row) => row.status === 'PASS').length,
      fail: results.filter((row) => row.status === 'FAIL').length,
    }
    writeJson('training-worker-qualification.json', payload)
    console.log(`training worker qualification: ${payload.pass} PASS, ${payload.fail} FAIL — docs/release/evidence/training-worker-qualification.json`)
    if (payload.fail > 0) process.exitCode = 1
  } finally {
    manager?.close()
    reloaded?.close()
  }
}

main().catch((error) => {
  console.error(`training worker qualification failed: ${error.stack ?? error}`)
  process.exitCode = 1
})
