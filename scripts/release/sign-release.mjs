#!/usr/bin/env node
// Fail-closed release signing workflow.
//
//   RAGAM_RELEASE_SIGNING_KEY_ID=<key id> \
//   RAGAM_RELEASE_SIGNING_KEY_FILE=/secure/path/authorized-private-key.asc \
//   RAGAM_RELEASE_SIGNING_AUTHORIZED_BY='repository owner' \
//   RAGAM_RELEASE_SIGNING_CONFIRM=YES \
//   node scripts/release/sign-release.mjs --dir build/release/0.2.0
//
// This script NEVER creates a key, NEVER picks an arbitrary key from a default
// keyring, and NEVER signs without all four explicit inputs. It imports the
// authorized key into a throwaway GPG home, produces a detached armor signature
// over SHA256SUMS, then verifies it independently with `gpg --verify`.
//
// With no authorized key configured it exits 2 and names the exact
// requirement. That is a BLOCKED release gate, not a failure to hide.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, writeJson } from './lib.mjs'

const args = process.argv.slice(2)
const i = args.indexOf('--dir')
const out = resolve(i === -1 ? 'build/release' : args[i + 1])
const sumsPath = join(out, 'SHA256SUMS')

const REQUIRED = [
  ['RAGAM_RELEASE_SIGNING_KEY_ID', 'the authorized signing key id / fingerprint'],
  ['RAGAM_RELEASE_SIGNING_KEY_FILE', 'absolute path to the authorized armored private key, outside this repository'],
  ['RAGAM_RELEASE_SIGNING_AUTHORIZED_BY', 'the identity of the repository owner who authorized this signing'],
  ['RAGAM_RELEASE_SIGNING_CONFIRM', 'must be exactly YES to confirm explicit authorization'],
]

const missing = REQUIRED.filter(([name]) => !process.env[name]?.trim())
if (missing.length) {
  console.error('signing refused: no authorized signing key is configured.')
  for (const [name, why] of missing) console.error(`  missing ${name} — ${why}`)
  console.error('  No signature was created. The release gate remains BLOCKED.')
  process.exit(2)
}
if (process.env.RAGAM_RELEASE_SIGNING_CONFIRM !== 'YES') {
  console.error("signing refused: RAGAM_RELEASE_SIGNING_CONFIRM must be exactly 'YES'.")
  process.exit(2)
}
if (!existsSync(sumsPath)) {
  console.error(`signing refused: ${sumsPath} does not exist. Run build-release.mjs first.`)
  process.exit(2)
}
const keyFile = resolve(process.env.RAGAM_RELEASE_SIGNING_KEY_FILE)
if (!existsSync(keyFile)) {
  console.error('signing refused: the authorized key file does not exist.')
  process.exit(2)
}
if (keyFile.startsWith(`${REPO_ROOT}/`)) {
  console.error('signing refused: a private signing key must never be stored inside the repository.')
  process.exit(2)
}

const home = mkdtempSync(join(tmpdir(), 'ragam-gpg-'))
const env = { ...process.env, GNUPGHOME: home }
const gpg = (gpgArgs, label) => {
  const result = spawnSync('gpg', ['--batch', '--no-tty', ...gpgArgs], { env, encoding: 'utf8', cwd: out })
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}: ${(result.stderr || result.stdout || '').trim().slice(0, 600)}`)
  return result
}
try {
  gpg(['--import', keyFile], 'key import')
  const ascPath = join(out, 'SHA256SUMS.asc')
  gpg(['--pinentry-mode', 'loopback', '--local-user', process.env.RAGAM_RELEASE_SIGNING_KEY_ID,
    '--armor', '--detach-sign', '--output', ascPath, '--', basename(sumsPath)], 'detached signature')
  if (!existsSync(ascPath) || !readFileSync(ascPath, 'utf8').includes('BEGIN PGP SIGNATURE')) {
    throw new Error('no armor signature was produced')
  }
  // Independent verification: gpg --verify in the same throwaway keyring.
  gpg(['--verify', ascPath, sumsPath], 'independent signature verification')
  writeJson(join(out, 'signature.json'), {
    schema: 'ragam-release-signature/1',
    status: 'SIGNED',
    keyId: process.env.RAGAM_RELEASE_SIGNING_KEY_ID,
    authorizedBy: process.env.RAGAM_RELEASE_SIGNING_AUTHORIZED_BY,
    signedFile: 'SHA256SUMS',
    signatureFile: 'SHA256SUMS.asc',
    independentVerification: 'gpg --verify SHA256SUMS.asc SHA256SUMS',
    verified: true,
    note: 'manifest.json remains the unsigned build record; signature.json is the signing evidence.',
  })
  console.log(`signed ${sumsPath} with ${process.env.RAGAM_RELEASE_SIGNING_KEY_ID}; gpg --verify PASS`)
} catch (error) {
  console.error(`signing failed: ${error.message}`)
  process.exit(1)
} finally {
  rmSync(home, { recursive: true, force: true })
}
