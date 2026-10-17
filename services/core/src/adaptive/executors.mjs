// Two real implementations of one task, and the boundary both must respect.
//
// The task is `tree.line-count`: count the newline bytes in every file of a tree whose
// extension is on a list. It is a real developer task, it has an exact specification, and --
// which is the point of choosing it -- **it has two independent implementations that must
// agree**, plus a third outside this process (`/usr/bin/wc -l`) to check a sample against.
// A first milestone needs a task whose success cannot be asserted into existence.
//
// The specification, fixed here and checked by tests:
//
//   `lines` is the number of 0x0A bytes in the file.
//
// That is what `wc -l` counts. It means a file with no trailing newline reports one fewer
// than a text editor shows, which is a *limitation worth declaring*, not a bug to paper
// over: it is on both descriptors and in the skill document.
//
// The two implementations differ in how they get there, and the difference is the whole
// reason a stored procedure is worth having: one materialises every file as a string and
// splits it, the other streams fixed-size chunks and never holds a file. Same answer,
// different cost on this machine, and the router chooses between them by measurement.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { assertMayRead, validateCapability } from './capability.mjs'

/** Directories that are never corpus or source: build output, dependencies, virtualenvs. */
export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next', '.vite', 'coverage',
])

export const STREAM_CHUNK_BYTES = 64 * 1024

/**
 * Every file under `root` whose extension is listed, as sorted relative posix paths.
 *
 * Sorted because a report that lists files in directory order is a report whose digest
 * changes when the filesystem reorders a directory, and an unstable digest makes every
 * later comparison meaningless.
 */
export function walkFiles(root, { extensions = [], excludeDirs = DEFAULT_EXCLUDE_DIRS, maxFiles = 200_000 } = {}) {
  const absoluteRoot = resolve(String(root))
  const wanted = new Set(extensions.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)))
  const found = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const dir = rel ? join(absoluteRoot, rel) : absoluteRoot
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      // An unreadable directory is skipped and *counted*, not swallowed: the result carries
      // `skipped` so a caller can see that the walk did not cover everything it looked at.
      found.push({ unreadable: true, path: rel })
      continue
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}${sep}${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue
        stack.push(entryRel)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      if (!wanted.has(entry.name.slice(dot).toLowerCase())) continue
      found.push({ unreadable: false, path: entryRel.split(sep).join('/') })
    }
  }
  const files = found.filter((f) => !f.unreadable).map((f) => f.path).sort()
  const unreadableDirs = found.filter((f) => f.unreadable).map((f) => f.path)
  if (files.length > maxFiles) {
    throw new Error(`the tree holds ${files.length} matching files, above the ${maxFiles} limit`)
  }
  return { files, unreadableDirs, root: absoluteRoot }
}

/**
 * Read a file as a string and split it -- the obvious one-liner, written the way it is
 * normally written.
 *
 * This is the baseline, and it is a *fair* baseline: `split('\n')` is native code and it is
 * correct. It costs what it costs because it materialises the whole file as a string and
 * then builds an array with one entry per line, which on a large file is a large number of
 * small objects -- a cost that is real, and that the measurement below reports rather than
 * argues about.
 */
function countByMaterialising(descriptor, absolutePath) {
  assertMayRead(descriptor, absolutePath)
  const text = readFileSync(absolutePath, 'utf8')
  return { lines: text.split('\n').length - 1, bytes: statSync(absolutePath).size }
}

/**
 * Read fixed-size chunks and count newline bytes -- never holds a whole file.
 *
 * `indexOf` on the buffer is used rather than a byte loop because it lets the runtime scan
 * in native code; the count is the same number either way, which is what makes the two
 * implementations comparable rather than merely different.
 */
function countByStreaming(descriptor, absolutePath, chunkBytes = STREAM_CHUNK_BYTES) {
  assertMayRead(descriptor, absolutePath)
  const fd = openSync(absolutePath, 'r')
  const buffer = Buffer.allocUnsafe(chunkBytes)
  let lines = 0
  let bytes = 0
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, chunkBytes, null)
      if (read <= 0) break
      bytes += read
      let index = buffer.indexOf(10, 0)
      while (index !== -1 && index < read) {
        lines += 1
        index = buffer.indexOf(10, index + 1)
      }
    }
  } finally {
    closeSync(fd)
  }
  return { lines, bytes }
}

/**
 * The two implementations, ready to route. `roots` is the read scope both are granted, and
 * it is deliberately not '/' -- an executor that may read the whole filesystem is an
 * executor whose permission list says nothing.
 */
export function makeLineCountExecutors({ roots }) {
  const scope = roots.map((r) => resolve(String(r)))
  const made = []

  const build = (spec, implementation) => {
    let resolved = null
    const invoke = ({ root, extensions = [], excludeDirs = DEFAULT_EXCLUDE_DIRS, detail = false }) => {
      const walk = walkFiles(root, { extensions, excludeDirs })
      let lines = 0
      let bytes = 0
      const perFile = detail ? [] : null
      for (const relPath of walk.files) {
        const absolute = join(walk.root, relPath)
        const result = implementation(resolved, absolute)
        lines += result.lines
        bytes += result.bytes
        if (perFile) perFile.push({ path: relPath, lines: result.lines, bytes: result.bytes })
      }
      return {
        root: walk.root, files: walk.files.length, lines, bytes, perFile,
        unreadableDirs: walk.unreadableDirs,
      }
    }
    resolved = validateCapability({ ...spec, invoke })
    made.push(resolved)
    return resolved
  }

  const materialise = build(
    {
      id: 'line-count-materialise',
      kind: 'tool',
      provides: ['tree.line-count'],
      permissions: { fsRead: scope, fsWrite: [], network: false },
      privacy: 'local-only',
      determinism: 'deterministic',
      description: 'read every file as a string and count newlines in memory',
      implementation: 'count-newlines-materialise',
      limitations: [
        'Holds each file as a string; peak memory grows with the largest file.',
        'Decodes as UTF-8, so a file that is not valid UTF-8 is counted after replacement -- the newline bytes are unaffected, which is why the count still agrees with the streaming implementation.',
      ],
    },
    countByMaterialising,
  )

  const stream = build(
    {
      id: 'line-count-stream',
      kind: 'tool',
      provides: ['tree.line-count'],
      permissions: { fsRead: scope, fsWrite: [], network: false },
      privacy: 'local-only',
      determinism: 'deterministic',
      description: `scan files in ${STREAM_CHUNK_BYTES / 1024} KiB chunks without materialising them`,
      implementation: 'count-newlines-stream',
      limitations: [
        'Reads every matching file: the count is exact, not sampled.',
        'Counts newline bytes, so a file with no trailing newline reports one fewer line than a text editor shows.',
      ],
    },
    countByStreaming,
  )

  return { materialise, stream }
}

export { countByMaterialising, countByStreaming }
