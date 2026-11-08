#!/usr/bin/env node
// Reproducible real-trainer worker qualification.
//
//   node scripts/release/verify-training-worker-cancellation.mjs
//
// This is NOT a mock or a stub. It starts the production
// `services/fabric/scripts/train_klyvaron.py` through the production
// `LocalTrainingWorkerManager`, observes a real JAX/NumPy parameter update,
// requests cancellation with SIGTERM, verifies the atomic checkpoint, proves
// job-state persistence across a manager restart, and then records a real
// trainer-process failure caused by an invalid corpus record.
//
// The deterministic corpus is synthetic and generated locally. No user data,
// licensed model weights, live provider credentials, external service, paid
// API or GPU is used. The 27,559,946-parameter run is a cancellation smoke
// test, not a production Klyvaron model qualification and not a claim that
// foundation-model training succeeded.
//
// Prerequisite: install services/fabric/requirements.lock into ./.venv (or set
// AETHERIS_PYTHON to an interpreter with NumPy/JAX). The 330 MB checkpoint is
// kept under the ignored build/ directory; only its digest, NPZ metadata,
// worker logs and job states are committed as evidence.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
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

    const started = manager.startJob({ planRequest: request, consent, actor: 'release-qualification' })
    await waitForProgress(manager, started.id, 1, 300_000)
    const cancelRequested = manager.cancelJob(started.id, { actor: 'release-qualification' })
    await waitForTerminal(manager, started.id, 300_000)
    const cancelled = manager.getJob(started.id)
    writeFileSync(evidencePath('training-worker-cancellation.log'), `${cancelled.logs.join('\n')}\n`, 'utf8')

    const checkpointPath = cancelled.checkpointPath
    const checkpointSha256 = existsSync(checkpointPath) ? await sha256File(checkpointPath) : null
    const sumsPath = join(BUILD, 'training-worker-checksums.txt')
    const sumsLine = checkpointSha256 ? `${checkpointSha256}  ${rel(checkpointPath)}\n` : ''
    writeFileSync(sumsPath, sumsLine, 'utf8')
    writeFileSync(evidencePath('training-worker-checksums.txt'), sumsLine, 'utf8')
    const sha256Verify = checkpointSha256
      ? spawnSync('sha256sum', ['-c', rel(sumsPath)], { cwd: REPO_ROOT, encoding: 'utf8' })
      : { status: 1, stdout: '', stderr: 'checkpoint missing' }
    const npzInspect = checkpointSha256
      ? spawnSync(environment.software.pythonBinary, [inspector, checkpointPath], { cwd: REPO_ROOT, encoding: 'utf8' })
      : { status: 1, stdout: '', stderr: 'checkpoint missing' }
    const npz = npzInspect.status === 0 ? JSON.parse(npzInspect.stdout.trim()) : null

    let pidAlive = false
    try { process.kill(started.pid, 0); pidAlive = true } catch {}
    const activeAfterCancel = manager.processes.size
    manager.close()
    manager = null

    reloaded = new LocalTrainingWorkerManager({ root: managerRoot })
    const restored = reloaded.getJob(started.id)
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
    const observedRss = cancelled.logs.map((line) => /rss=(\d+)MB/.exec(line)?.[1]).find(Boolean) ?? 'unrecorded'
    check(results, 'real_training_progress_observed', cancelled.progress.step >= 1 && Number.isFinite(cancelled.progress.lastLoss),
      `step ${cancelled.progress.step}/${cancelled.progress.totalSteps}; loss=${cancelled.progress.lastLoss}; trainer log records rss=${observedRss}MB`)
    check(results, 'sigterm_delivered_and_handled', cancelRequested.cancelRequested === true && cancelled.logs.some((line) => line.includes('received signal 15')),
      'LocalTrainingWorkerManager.cancelJob sent SIGTERM; the real Python trainer logged signal 15 and exited cleanly')
    check(results, 'atomic_checkpoint_written', Boolean(checkpointSha256) && cancelled.checkpointVerified === true && cancelled.logs.some((line) => line.includes('atomic checkpoint saved at step')),
      `checkpoint bytes=${checkpointSha256 ? statSync(checkpointPath).size : 0}; sha256=${checkpointSha256 ?? 'missing'}`)
    check(results, 'checkpoint_sha256_matches_worker_log', Boolean(checkpointSha256) && checkpointSha256.startsWith(cancelled.progress.lastCheckpointSha256 ?? '\u0000'),
      `worker parsed ${cancelled.progress.lastCheckpointSha256}; independently computed ${checkpointSha256?.slice(0, 16)}…`)
    check(results, 'checkpoint_integrity_without_pickle', Boolean(npz) && npz.step >= 1 && npz.configDigest === prepared.plan.architectureDigest && npz.weightArrays > 0 && npz.optimizerArrays > 0 && npz.firstWeightFinite,
      npz ? `step=${npz.step}; arrays=${npz.arrays}; weights=${npz.weightArrays}; optimizer=${npz.optimizerArrays}; configDigest=${npz.configDigest}` : `inspection failed: ${npzInspect.stderr}`)
    check(results, 'independent_sha256sum_verification', sha256Verify.status === 0 && sha256Verify.stdout.includes(': OK'),
      `sha256sum -c ${rel(sumsPath)} → ${sha256Verify.stdout.trim() || sha256Verify.stderr.trim()}`)
    check(results, 'cancelled_job_state_persisted', cancelled.state === 'cancelled_checkpointed' && cancelled.exitCode === 130 && cancelled.cancelRequested === true && Boolean(cancelled.completedAt),
      `state=${cancelled.state}; exitCode=${cancelled.exitCode}; completedAt=${cancelled.completedAt}`)
    check(results, 'no_orphan_worker_process', pidAlive === false && activeAfterCancel === 0,
      `pidAlive=${pidAlive}; manager active processes=${activeAfterCancel}`)
    check(results, 'job_state_survives_manager_restart', restored?.state === 'cancelled_checkpointed' && restored?.checkpointVerified === true,
      `reloaded manager restored state=${restored?.state}; checkpointVerified=${restored?.checkpointVerified}`)
    check(results, 'real_failure_path_recorded', failed.state === 'failed' && failed.exitCode === 1 && failed.checkpointVerified === false && /JSONDecodeError/.test(String(failed.error)),
      `state=${failed.state}; exitCode=${failed.exitCode}; error=${failed.error}; checkpointVerified=${failed.checkpointVerified}`)
    check(results, 'worker_has_no_active_process_after_failure', activeAfterFailure === 0 && reloaded === null,
      `active processes=${activeAfterFailure}; manager closed cleanly`)

    const checkpoint = {
      path: rel(checkpointPath),
      bytes: checkpointSha256 ? statSync(checkpointPath).size : 0,
      sha256: checkpointSha256,
      npz,
      independentVerification: {
        command: `sha256sum -c ${rel(sumsPath)}`,
        status: sha256Verify.status,
        stdout: sha256Verify.stdout.trim(),
        stderr: sha256Verify.stderr.trim(),
      },
      inspector: {
        command: `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(checkpointPath)}`,
        status: npzInspect.status,
        stdout: npzInspect.stdout.trim(),
        stderr: npzInspect.stderr.trim(),
      },
    }
    writeJson('training-worker-checkpoint.json', checkpoint)
    writeJson('training-worker-jobs.json', {
      cancellation: {
        id: cancelled.id,
        pid: started.pid,
        state: cancelled.state,
        cancelRequested: cancelled.cancelRequested,
        exitCode: cancelled.exitCode,
        completedAt: cancelled.completedAt,
        progress: cancelled.progress,
        checkpointPath: rel(checkpointPath),
        checkpointVerified: cancelled.checkpointVerified,
        logLines: cancelled.logs.length,
      },
      restored: restored ? { state: restored.state, checkpointVerified: restored.checkpointVerified } : null,
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
      sourceCommitNote: 'HEAD at generation time; the subsequent evidence-only commit is a descendant and contains no runtime code changes.',
      branch: git('branch', '--show-current'),
      command: 'node scripts/release/verify-training-worker-cancellation.mjs',
      worker: 'services/core/src/klyvaron/training-worker.mjs -> services/fabric/scripts/train_klyvaron.py',
      scope: 'real 27,559,946-parameter JAX/NumPy training process; resource-bounded SIGTERM cancellation and failure-path smoke test; NOT a production Klyvaron model, NOT foundation-model qualification, NOT live provider inference',
      hardware: environment.hardware,
      runtime: environment.software,
      consent: {
        confirmed: true,
        basis: 'Operator-initiated release qualification on a deterministic synthetic corpus generated by this script.',
        datasetOwnership: 'locally generated synthetic text; no user-owned or private dataset',
        purpose: 'verify real worker cancellation, atomic checkpointing, job-state persistence and failure handling',
        limitations: 'This is not consent to train on user data, publish a model, or claim a production Klyvaron model.',
        disclosureDigest: prepared.disclosureDigest,
        authorizedAt: cancelled.authorizedAt,
      },
      commands: [
        'node scripts/release/verify-training-worker-cancellation.mjs',
        `${rel(environment.software.pythonBinary)} ${rel(trainScript)} --preset pro --corpus-dir ${rel(corpusDir)} --corpus-record ${rel(corpusRecord)} --work-dir ${rel(started.workDir)} --install-root ${rel(managerRoot)} --pretrain-steps 2 --joint-steps 2 --batch-size 1 --checkpoint-every 1 --keep-checkpoint --skip-cards`,
        `LocalTrainingWorkerManager.cancelJob(${cancelled.id}) → child.kill('SIGTERM')`,
        `sha256sum -c ${rel(sumsPath)}`,
        `${rel(environment.software.pythonBinary)} ${rel(inspector)} ${rel(checkpointPath)}`,
        `${rel(environment.software.pythonBinary)} ${rel(trainScript)} --preset pro --corpus-dir ${rel(corpusDir)} --corpus-record ${rel(badRecord)} --work-dir ${rel(failedStart.workDir)} --install-root ${rel(managerRoot)} --pretrain-steps 2 --joint-steps 2 --batch-size 1 --checkpoint-every 1 --keep-checkpoint --skip-cards (real failure path)`,
      ],
      logs: [
        'docs/release/evidence/training-worker-cancellation.log',
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
        observedStep: cancelled.progress.step,
        observedLoss: cancelled.progress.lastLoss,
        checkpointBytes: checkpoint.bytes,
        checkpointSha256: checkpoint.sha256,
        cancellationExitCode: cancelled.exitCode,
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
