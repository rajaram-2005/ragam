// Checkpoints: durable, digest-chained records of how far a run got, and the resume check.
//
// GodCore's `#checkpoint` sets `task.checkpoint` to an in-memory label and emits an event; its
// pause/resume is "call run() again on the same live object". That is real pause/resume inside
// one process and it is not what survives a restart, which is the case the directive names:
// checkpoints and resumable tasks. This store is the durable half.
//
// Three rules, each learned from a failure already recorded in this project:
//
//   1. **Written atomically.** Every record goes to a temporary file in the same directory and
//      is renamed into place, so a process that dies mid-write leaves a `.tmp` nobody reads
//      rather than a half-written record that parses as a shorter run.
//   2. **A torn record is skipped, not fatal.** `latest()` reads records newest-first and skips
//      one that does not parse, reporting it in `skipped`. (The trainer's checkpoint lesson:
//      polling a checkpoint mid-write threw `BadZipFile` and looked like corruption. Here a
//      mid-write file is expected and survivable.)
//   3. **Resuming against a different plan is refused.** Each record carries the plan digest;
//      `resume()` compares it and throws `checkpoint_mismatch`. A checkpoint of one plan
//      applied to another is not a resume -- it is a run wearing another run's progress, which
//      is exactly how a partial result gets reported as a complete one.
//
// Records are never deleted by this module. A finished run's history is the evidence that it
// finished, and a store that tidied up after itself would be deleting the finding.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { digestOf } from './plan.mjs'

export const RUN_STATES = Object.freeze({
  RUNNING: 'running',
  PAUSED: 'paused', // stopped inside budget, with work left: resumable
  PARTIAL: 'partial', // stopped at a limit: resumable, and honest about what is undone
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
})

export class CheckpointError extends Error {
  constructor(message, code = 'checkpoint_error', detail = {}) {
    super(message)
    this.name = 'CheckpointError'
    this.code = code
    this.detail = detail
  }
}

const SEQUENCE = (n) => String(n).padStart(6, '0')

export class CheckpointStore {
  #dir
  #clock
  #counters = new Map()

  constructor(dir, { clock = () => Date.now() } = {}) {
    if (!dir) throw new CheckpointError('a checkpoint store needs a directory', 'no_directory')
    this.#dir = resolve(dir)
    mkdirSync(this.#dir, { recursive: true })
    this.#clock = clock
  }

  get dir() {
    return this.#dir
  }

  #runDir(runId) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(runId)) {
      throw new CheckpointError(`run id '${runId}' must be lowercase kebab-case; it becomes a directory name`, 'invalid_run_id')
    }
    return join(this.#dir, runId)
  }

  /**
   * Append one checkpoint. `prevDigest` chains it to the record before it, so a deleted or
   * edited checkpoint is detectable rather than merely absent.
   */
  save({ runId, state, planDigest, planId = null, usage = null, steps = [], note = null, at = null }) {
    if (!Object.values(RUN_STATES).includes(state)) {
      throw new CheckpointError(`'${state}' is not a run state; one of ${Object.values(RUN_STATES).join(', ')}`, 'invalid_state')
    }
    if (!planDigest) {
      throw new CheckpointError('a checkpoint must name the plan it belongs to, or resuming it means nothing', 'missing_plan_digest')
    }
    const dir = this.#runDir(runId)
    mkdirSync(dir, { recursive: true })
    const history = this.history(runId)
    const seq = history.length
    const body = {
      runId,
      seq,
      at: at ?? new Date(this.#clock()).toISOString(),
      state,
      planId,
      planDigest,
      usage,
      steps: steps.map((step) => ({
        id: step.id,
        status: step.status,
        verified: step.verified === true,
        outcome: step.outcome ?? null,
        result: step.result ?? null,
        verification: step.verification ?? null,
        durationMs: step.durationMs ?? null,
      })),
      note,
      prevDigest: seq === 0 ? null : history.at(-1).digest,
    }
    const record = Object.freeze({ ...body, digest: digestOf(body) })

    const finalPath = join(dir, `${SEQUENCE(seq)}.json`)
    const tempPath = join(dir, `.${SEQUENCE(seq)}.json.tmp`)
    writeFileSync(tempPath, `${JSON.stringify(record)}\n`, 'utf8')
    renameSync(tempPath, finalPath) // atomic within a directory
    return record
  }

  /**
   * Every readable record, oldest first, skipping unreachable ones and reporting them.
   * A `.tmp` file is not a record: it is a write that did not complete, and reading it would
   * turn a crashed write into a shorter run.
   */
  history(runId) {
    const dir = this.#runDir(runId)
    if (!existsSync(dir)) return []
    const files = readdirSync(dir).filter((name) => /^\d{6}\.json$/.test(name)).sort()
    const records = []
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8')
      let record
      try {
        record = JSON.parse(text)
      } catch {
        continue // unreachable by construction (rename is atomic); skipped rather than fatal
      }
      records.push(record)
    }
    return records
  }

  /**
   * The newest record, its chain verified, plus what was skipped on the way. `skipped` is
   * reported rather than swallowed: "the newest checkpoint is seq 4" and "seq 5 is unreadable"
   * are both facts a person recovering a run needs.
   */
  latest(runId) {
    const dir = this.#runDir(runId)
    const records = this.history(runId)
    const skipped = existsSync(dir)
      ? readdirSync(dir).filter((name) => name.endsWith('.tmp')).map((name) => ({ file: name, reason: 'write did not complete' }))
      : []
    const tampered = verifyChain(records)
    return Object.freeze({
      record: records.length ? records.at(-1) : null,
      count: records.length,
      skipped: Object.freeze(skipped),
      intact: tampered.ok,
      brokenAt: tampered.brokenAt,
      reason: tampered.reason,
    })
  }

  /**
   * Resume a run against a plan. Refuses when the plan is not the one checkpointed, and
   * returns the record when it is -- so the caller can rebuild the run's state from evidence
   * rather than from memory.
   */
  resume(runId, { planDigest, planId = null } = {}) {
    const latest = this.latest(runId)
    if (!latest.record) {
      throw new CheckpointError(`no checkpoint exists for run '${runId}'`, 'no_checkpoint', { runId })
    }
    if (!latest.intact) {
      throw new CheckpointError(
        `refusing to resume: the checkpoint chain for '${runId}' is broken at ${latest.brokenAt} (${latest.reason})`,
        'checkpoint_tampered',
        { brokenAt: latest.brokenAt },
      )
    }
    if (planDigest && latest.record.planDigest !== planDigest) {
      throw new CheckpointError(
        `refusing to resume: the checkpoint belongs to plan ${latest.record.planDigest.slice(0, 12)} and this is ${String(planDigest).slice(0, 12)}; ` +
          'a checkpoint of one plan applied to another is not a resume',
        'checkpoint_mismatch',
        { stored: latest.record.planDigest, given: planDigest },
      )
    }
    return Object.freeze({
      record: latest.record,
      count: latest.count,
      skipped: latest.skipped,
      note: 'resumed from the newest intact checkpoint; steps already recorded complete are not re-run',
    })
  }

  /** Run ids with at least one record, for a status page or a recovery sweep. */
  runs() {
    return readdirSync(this.#dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }

  /**
   * How far the recorded run got. Called by callers that need the summary, not the records.
   */
  progress(runId) {
    const latest = this.latest(runId)
    if (!latest.record) return null
    const done = latest.record.steps.filter((step) => step.status === 'complete')
    return Object.freeze({
      state: latest.record.state,
      seq: latest.record.seq,
      completed: done.map((step) => step.id),
      completedCount: done.length,
      totalSteps: latest.record.steps.length,
      at: latest.record.at,
      note: latest.record.note,
    })
  }
}

/** Recompute the chain. Returns a finding rather than throwing; see `EpisodeLog.verify`. */
export function verifyChain(records) {
  let prev = null
  for (let index = 0; index < records.length; index += 1) {
    const { digest, ...body } = records[index]
    if (body.prevDigest !== prev) {
      return { ok: false, brokenAt: index, reason: `record ${index} links to ${body.prevDigest}, but the previous digest is ${prev}` }
    }
    if (digestOf(body) !== digest) {
      return { ok: false, brokenAt: index, reason: `record ${index} has been modified since it was written` }
    }
    prev = digest
  }
  return { ok: true, brokenAt: null, count: records.length }
}

/** Append-only recovery log beside the checkpoints: what was done to a run and why. */
export function noteRecovery(path, entry) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

/** Remove temporary files left by a crash. Only ever called with `.tmp` names. */
export function discardIncomplete(path) {
  if (!path.endsWith('.tmp')) {
    throw new CheckpointError(`refusing to discard '${path}': only incomplete writes (.tmp) may be discarded`, 'not_temporary')
  }
  rmSync(path, { force: true })
}
