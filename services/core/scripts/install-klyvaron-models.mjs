#!/usr/bin/env node
// Install the released first-party Klyvaron weights (0.1.0) for a clean checkout.
//
// A fresh clone has no weights: the Core service is zero-dependency and never
// downloads models by itself. This is the one explicit, operator-run step that
// fetches them — the same tarball CI verifies — and proves what landed is the
// release, twice over:
//
//   1. every entry of the tarball's own `SHA256SUMS` must verify, and
//   2. every installed file must match the release pins recorded in source
//      (`src/klyvaron/release-pins.mjs`), which is the check that cannot be
//      forged by replacing the tarball and its sums together.
//
// Usage:
//   node services/core/scripts/install-klyvaron-models.mjs [--data-dir <dir>]
//        [--source <url-or-file>] [--force]
//
// `--source` accepts a local tarball path for air-gapped installs (and for
// the day the pinned commit is garbage-collected upstream — it is an
// unreachable object in the origin repository, so keep a mirror).
// Without `--force` the script never overwrites an existing model directory:
// a locally retrained artifact (`0.1.0-local.<job>`) sitting in a release
// slot is reported and left alone.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { KLYVARON_RELEASE_PINS, releasePinViolation } from '../src/klyvaron/release-pins.mjs'

// The weights live in a dedicated commit whose tree is just the eight model
// directories plus SHA256SUMS. That commit was originally reachable only by its
// raw SHA — an unreachable object GitHub may garbage-collect. It is now also
// tagged `klyvaron-weights-0.1.0`; the tag URL is primary and the pinned-commit
// URL remains as the bootstrap fallback until the tag is pushed. Either way,
// every byte is verified against SHA256SUMS and the release pins below, so the
// source the bytes came from never has to be trusted.
export const WEIGHTS_TAG = 'klyvaron-weights-0.1.0'
export const WEIGHTS_TARBALL_URL = `https://codeload.github.com/rajaram-2005/ragam/tar.gz/refs/tags/${WEIGHTS_TAG}`
export const WEIGHTS_TARBALL_FALLBACK_URL = 'https://codeload.github.com/rajaram-2005/ragam/tar.gz/c9f6aa2f5e31ed462caae1f94395ba46ea808a40'
export const WEIGHTS_SOURCES = [WEIGHTS_TARBALL_URL, WEIGHTS_TARBALL_FALLBACK_URL]

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Parse a `sha256sum`-style sums file into `{ file, sha256 }` rows. */
export function parseSums(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match) rows.push({ sha256: match[1], file: match[2].trim() })
  }
  return rows
}

/**
 * What is already in one model slot, without touching the network:
 * `missing` (nothing there), `pinned` (the release, byte for byte),
 * `local` (an artifact that does not claim the release version), or
 * `mismatch` (claims the release but fails the pin — forgery or corruption).
 */
export function classifyInstalled(modelsDir, id) {
  const pin = KLYVARON_RELEASE_PINS[id]
  const dir = join(modelsDir, id)
  if (!pin || !existsSync(dir)) return { id, state: 'missing' }
  // The version is read from whichever manifest flavour the slot holds.
  let version = null
  for (const name of ['manifest.json', `${id}.klyvaron.json`]) {
    try {
      version = JSON.parse(readFileSync(join(dir, name), 'utf8')).version ?? null
      if (version) break
    } catch { /* try the next manifest flavour */ }
  }
  if (version !== pin.version) return { id, state: 'local', version }
  const weightsPath = join(dir, pin.weightsFile)
  if (!existsSync(weightsPath)) return { id, state: 'mismatch', version, problem: `weights file '${pin.weightsFile}' is absent` }
  const violation = releasePinViolation({
    id,
    version,
    weightsFile: pin.weightsFile,
    weightsSha256: sha256File(weightsPath),
    processorFile: pin.processorFile ?? null,
    processorSha256: pin.processorFile && existsSync(join(dir, pin.processorFile))
      ? sha256File(join(dir, pin.processorFile))
      : null,
  })
  return violation ? { id, state: 'mismatch', version, problem: violation } : { id, state: 'pinned', version }
}

export function planInstall(modelsDir) {
  return Object.keys(KLYVARON_RELEASE_PINS).map((id) => classifyInstalled(modelsDir, id))
}

/**
 * Extract a gzipped ustar tarball into `destDir`, stripping the first path
 * component (the `<repo>-<commit>/` prefix codeload adds). Written against
 * the standard library only, like everything in services/core. Refuses
 * absolute paths, `..` segments, and link entries outright.
 */
export function extractTarGz(buffer, destDir) {
  const tar = gunzipSync(buffer)
  const written = []
  let offset = 0
  let pendingLongName = null
  const text = (from, to) => tar.toString('utf8', from, to).replace(/\0.*$/s, '')
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break // end-of-archive blocks
    const name = pendingLongName ?? text(offset, offset + 100)
    const prefix = text(offset + 345, offset + 500)
    const fullName = pendingLongName ? name : (prefix ? `${prefix}/${name}` : name)
    pendingLongName = null
    const size = parseInt(text(offset + 124, offset + 136).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const dataStart = offset + 512
    offset = dataStart + Math.ceil(size / 512) * 512

    if (type === 'L') { // GNU longname: applies to the next entry
      pendingLongName = tar.toString('utf8', dataStart, dataStart + size).replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x' || type === 'g') { // pax headers: honour a path override only
      const body = tar.toString('utf8', dataStart, dataStart + size)
      const pathMatch = /(?:^|\n)\d+ path=(.+)/.exec(body)
      if (type === 'x' && pathMatch) pendingLongName = pathMatch[1].trim()
      continue
    }
    const parts = fullName.split('/').filter((part) => part && part !== '.')
    if (parts.length < 2) continue // the prefix directory itself
    const relative = parts.slice(1)
    if (relative.some((part) => part === '..') || fullName.startsWith('/')) {
      throw new Error(`tarball entry '${fullName}' escapes the destination directory`)
    }
    const target = join(destDir, ...relative)
    if (!resolve(target).startsWith(resolve(destDir) + sep)) {
      throw new Error(`tarball entry '${fullName}' escapes the destination directory`)
    }
    if (type === '5') {
      mkdirSync(target, { recursive: true })
    } else if (type === '0' || type === '\0') {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, tar.subarray(dataStart, dataStart + size))
      written.push(relative.join('/'))
    } else {
      throw new Error(`tarball entry '${fullName}' has unsupported type '${type}' (links are never extracted)`)
    }
  }
  return written
}

/** Join `*.npz.part*` fragments the way CI does, then remove the fragments. */
export function joinSplitWeights(modelsDir) {
  const joined = []
  for (const id of Object.keys(KLYVARON_RELEASE_PINS)) {
    const dir = join(modelsDir, id)
    if (!existsSync(dir)) continue
    const fragments = readdirSync(dir).filter((name) => name.includes('.npz.part')).sort()
    if (!fragments.length) continue
    const targetName = fragments[0].replace(/\.part.*$/, '')
    const parts = fragments.map((name) => readFileSync(join(dir, name)))
    writeFileSync(join(dir, targetName), Buffer.concat(parts))
    for (const name of fragments) rmSync(join(dir, name), { force: true })
    joined.push(`${id}/${targetName}`)
  }
  return joined
}

/** Verify every `SHA256SUMS` row against disk. Returns the failures. */
export function verifySums(modelsDir, rows) {
  const failures = []
  for (const row of rows) {
    const path = join(modelsDir, row.file)
    if (!existsSync(path)) failures.push(`${row.file}: missing`)
    else if (sha256File(path) !== row.sha256) failures.push(`${row.file}: sha256 mismatch`)
  }
  return failures
}

async function readSource(source) {
  if (!/^https?:\/\//.test(source)) return readFileSync(source)
  const response = await fetch(source, { signal: AbortSignal.timeout(600_000) })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} from ${source}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function installKlyvaronModels({ dataDir, source = null, force = false, log = console.log } = {}) {
  const modelsDir = join(dataDir, 'klyvaron', 'models')
  mkdirSync(modelsDir, { recursive: true })
  const before = planInstall(modelsDir)
  for (const entry of before) {
    if (entry.state === 'local' && !force) {
      log(`${entry.id}: keeping local artifact (version ${entry.version}); use --force to replace it with the release`)
    } else if (entry.state === 'mismatch') {
      log(`${entry.id}: WARNING installed artifact claims the release but fails its pin (${entry.problem})`)
    }
  }
  const keepLocal = new Set(before.filter((entry) => entry.state === 'local' && !force).map((entry) => entry.id))
  if (before.every((entry) => entry.state === 'pinned' || keepLocal.has(entry.id)) && !force) {
    log('All first-party Klyvaron models are already installed and match their release pins.')
    return { modelsDir, installed: [], kept: [...keepLocal] }
  }

  // An explicit --source is used exactly as given; the default tries the tag
  // first and the pinned commit second. Verification below is identical for
  // every candidate, so a fallback can never substitute different bytes.
  const candidates = source ? [].concat(source) : WEIGHTS_SOURCES
  let tarball = null
  const failures = []
  for (const candidate of candidates) {
    try {
      log(`Fetching Klyvaron weights from ${candidate}`)
      tarball = await readSource(candidate)
      break
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`)
      log(`  unavailable (${error.message})${candidates.length > 1 ? '; trying next source' : ''}`)
    }
  }
  if (!tarball) throw new Error(`could not fetch Klyvaron weights from any source:\n  ${failures.join('\n  ')}`)
  log(`Downloaded ${(tarball.length / 1e6).toFixed(1)} MB; extracting to ${modelsDir}`)
  // Extract beside the live directory, verify there, then move model dirs in:
  // a bad tarball must never leave a half-replaced installation behind.
  const staging = join(dataDir, 'klyvaron', `.install-staging-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    extractTarGz(tarball, staging)
    joinSplitWeights(staging)
    const sumsPath = join(staging, 'SHA256SUMS')
    if (!existsSync(sumsPath)) throw new Error('tarball contains no SHA256SUMS; refusing to install unverifiable weights')
    const failures = verifySums(staging, parseSums(readFileSync(sumsPath, 'utf8')))
    if (failures.length) throw new Error(`tarball failed its own SHA256SUMS:\n  ${failures.join('\n  ')}`)

    const installed = []
    for (const id of Object.keys(KLYVARON_RELEASE_PINS)) {
      if (keepLocal.has(id)) continue
      const staged = classifyInstalled(staging, id)
      if (staged.state !== 'pinned') {
        throw new Error(`${id} from this tarball does not match its release pin (${staged.problem ?? staged.state}); refusing to install`)
      }
      rmSync(join(modelsDir, id), { recursive: true, force: true })
      cpSync(join(staging, id), join(modelsDir, id), { recursive: true })
      installed.push(id)
      log(`${id}: installed and pin-verified`)
    }
    return { modelsDir, installed, kept: [...keepLocal] }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function readArg(args, flag, fallback = null) {
  const idx = args.indexOf(flag)
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : fallback
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write([
      'Usage: node services/core/scripts/install-klyvaron-models.mjs [options]',
      '  --data-dir <dir>   Online data dir (default: $AETHERIS_ONLINE_DATA_DIR or ./.aetheris-data/online)',
      '  --source <src>     Tarball URL or local file (default: the klyvaron-weights-0.1.0 tag tarball, pinned-commit fallback)',
      '  --force            Replace existing model directories, including local retrains',
    ].join('\n') + '\n')
    return
  }
  const dataDir = resolve(readArg(args, '--data-dir', process.env.AETHERIS_ONLINE_DATA_DIR || '.aetheris-data/online'))
  const source = readArg(args, '--source', null)
  const { installed, kept } = await installKlyvaronModels({ dataDir, source, force: args.includes('--force') })
  const after = planInstall(join(dataDir, 'klyvaron', 'models'))
  for (const entry of after) console.log(`${entry.id}: ${entry.state}${entry.version ? ` (${entry.version})` : ''}`)
  console.log(`Done. Installed: ${installed.length ? installed.join(', ') : 'none'}; kept local: ${kept.length ? kept.join(', ') : 'none'}.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`install-klyvaron-models: ${error.message}`)
    process.exit(1)
  })
}
