// Independent verification: recompute the answer with something that is not the thing
// that produced it.
//
// "A successful response is not necessarily a verified response" is the rule this module
// exists to enforce. An executor reporting `lines: 41_207` is a claim; the number becomes
// evidence only when a second implementation, which shares no code and no failure mode with
// the first, arrives at the same figure *without being told what to expect*.
//
// Two layers, and the record keeps them apart because they are different strengths of claim:
//
//   1. **Whole-tree cross-check** against the other in-process implementation. Covers every
//      file. Two implementations written to the same specification can still share a
//      misunderstanding of the specification, so this alone is not proof.
//   2. **Sampled check against `/usr/bin/wc -l`** -- an implementation in another language
//      that has never seen this repository's code. It covers a sample, not the tree.
//
// If either disagrees, `agree` is false and the caller must not record success. If the
// external tool is unavailable, the evidence says the external check did not run rather than
// silently downgrading to a single-source claim.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** Files checked against the external tool, taken every `stride`-th file of the sorted list. */
export const DEFAULT_SAMPLE_SIZE = 8

/**
 * @param {object} options
 * @param {object} options.executor      the descriptor whose work is being checked
 * @param {object} options.expected      what it returned
 * @param {object} options.counterpart   a second descriptor providing the same capability
 * @param {object} options.task          `{ root, extensions, excludeDirs }`
 */
export function verifyLineCount({ executor, expected, counterpart, task, sampleSize = DEFAULT_SAMPLE_SIZE, run = null }) {
  const { root, extensions = [], excludeDirs } = task
  const invocation = { root, extensions, ...(excludeDirs ? { excludeDirs } : {}) }

  const second = (run ?? runExecutor)(counterpart, { ...invocation, detail: true })
  const wholeTreeAgrees = second.lines === expected.lines && second.files === expected.files

  const external = checkAgainstWc(root, second.perFile ?? [], { sampleSize })

  const agree = wholeTreeAgrees && external.disagreements.length === 0
  return Object.freeze({
    checked: true,
    agree,
    // What the executor claimed, kept so a later reader can see the number that was checked
    // rather than having to trust that it was.
    claimed: Object.freeze({ lines: expected.lines, files: expected.files, bytes: expected.bytes }),
    methods: Object.freeze([
      Object.freeze({
        name: executor.id,
        role: 'executor under test',
        lines: expected.lines,
        files: expected.files,
        coverage: 'whole tree',
      }),
      Object.freeze({
        name: counterpart.id,
        role: 'independent recomputation, whole tree',
        lines: second.lines,
        files: second.files,
        coverage: 'whole tree',
        agrees: wholeTreeAgrees,
      }),
    ]),
    external,
    reason: agree
      ? `two independent implementations agree on ${expected.lines} lines across ${expected.files} files; ` +
        (external.available
          ? `an external tool agrees on ${external.checked} sampled file(s)`
          : 'no external tool was available, so the external check did not run')
      : `verification failed: ${!wholeTreeAgrees ? `the second implementation computed ${second.lines} lines against ${expected.lines}` : ''}` +
        `${!wholeTreeAgrees && external.disagreements.length ? '; ' : ''}` +
        `${external.disagreements.length ? `${external.disagreements.length} sampled file(s) disagree with wc -l` : ''}`,
  })
}

/**
 * Compare a deterministic sample of files against `wc -l`.
 *
 * The sample is every `stride`-th file of the sorted list rather than a random draw, so two
 * runs verify the same files and a reviewer can reproduce the check by hand from the paths
 * in the evidence.
 */
export function checkAgainstWc(root, perFile, { sampleSize = DEFAULT_SAMPLE_SIZE, spawn = spawnSync } = {}) {
  if (!perFile.length) {
    return Object.freeze({ available: false, tool: 'wc -l', checked: 0, sampled: [], disagreements: [], note: 'no files to sample' })
  }
  const stride = Math.max(1, Math.floor(perFile.length / Math.max(1, sampleSize)))
  const sampled = perFile.filter((_, index) => index % stride === 0).slice(0, sampleSize)
  const paths = sampled.map((entry) => join(root, entry.path))

  let result
  try {
    result = spawn('wc', ['-l', ...paths], { encoding: 'utf8' })
  } catch (error) {
    return Object.freeze({
      available: false, tool: 'wc -l', checked: 0, sampled: sampled.map((s) => s.path),
      disagreements: [], note: `the external tool could not be run: ${error.message}`,
    })
  }
  if (result.error || result.status !== 0) {
    return Object.freeze({
      available: false, tool: 'wc -l', checked: 0, sampled: sampled.map((s) => s.path),
      disagreements: [],
      note: `the external tool is unavailable here (${result.error?.code ?? `exit ${result.status}`}); the whole-tree cross-check still ran`,
    })
  }

  const lines = String(result.stdout).split('\n').filter(Boolean)
  // `wc -l` prints one line per file, in the order given. It prints a total line only with -t.
  const observed = []
  const disagreements = []
  for (let i = 0; i < sampled.length; i += 1) {
    const printed = lines[i]
    if (printed === undefined) {
      disagreements.push({ path: sampled[i].path, ours: sampled[i].lines, external: null, reason: 'no output line' })
      continue
    }
    const value = Number.parseInt(printed.trim().split(/\s+/)[0], 10)
    observed.push({ path: sampled[i].path, ours: sampled[i].lines, external: value })
    if (value !== sampled[i].lines) {
      disagreements.push({ path: sampled[i].path, ours: sampled[i].lines, external: value, reason: 'counts differ' })
    }
  }
  return Object.freeze({
    available: true,
    tool: 'wc -l',
    checked: observed.length,
    sampled: observed,
    disagreements,
    coverage: `sample of ${observed.length} of the tree's files, every ${stride}th in sorted order`,
  })
}

function runExecutor(descriptor, invocation) {
  return descriptor.invoke(invocation)
}
