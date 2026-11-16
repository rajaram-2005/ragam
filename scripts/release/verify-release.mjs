#!/usr/bin/env node
// Independently verify a staged release bundle.
//
//   node scripts/release/verify-release.mjs --dir build/release/0.2.0
//   node scripts/release/verify-release.mjs --dir docs/release/artifacts
//
// Checksums are checked with the system `sha256sum -c` (a different
// implementation from the writer), then every manifest digest is recomputed,
// provenance is checked against the git object database, and the machine-
// readable qualification report is validated for status/evidence integrity.
// Signed bundles also require an explicit public key and pinned full fingerprint;
// `--require-signature` turns an unsigned staging bundle into a blocked release.

import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT, atRoot, readJson, sha256OfFile, verifyChecksumsWithSha256sum, validateQualificationReport } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const out = resolve(flag('dir', 'build/release'))
const safeBundleName = (name) => typeof name === 'string'
  && name.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name)
  && name !== '.' && name !== '..' && basename(name) === name
const bundlePath = (name) => safeBundleName(name) ? resolve(out, name) : null
const bundleEntryExists = (name) => {
  const path = bundlePath(name)
  if (!path || dirname(path) !== out) return false
  try { lstatSync(path); return true } catch { return false }
}
const bundleFile = (name) => {
  const path = bundlePath(name)
  if (!path || dirname(path) !== out) return null
  try {
    return lstatSync(path).isFile() ? path : null
  } catch {
    return null
  }
}
const requireSignature = args.includes('--require-signature')
const publicKeyFile = flag('public-key', process.env.RAGAM_RELEASE_VERIFY_PUBLIC_KEY_FILE)
const expectedFingerprint = flag('fingerprint', process.env.RAGAM_RELEASE_VERIFY_FINGERPRINT)
const problems = []
const checks = []

function check(name, ok, detail = '', status = ok ? 'PASS' : 'FAIL') {
  checks.push({ name, ok, status, detail })
  if (status !== 'PASS' && status !== 'NOT TESTED') problems.push(`${name}: ${detail}`)
}

function verifyDetachedSignature({ publicKeyPath, fingerprint }) {
  const signaturePath = bundleFile('SHA256SUMS.asc')
  const sumsPath = bundleFile('SHA256SUMS')
  const metadataPath = bundleFile('signature.json')
  if (!signaturePath) return bundleEntryExists('SHA256SUMS.asc')
    ? { status: 'FAIL', detail: 'SHA256SUMS.asc must be a regular file inside the release directory' }
    : { status: 'BLOCKED', detail: 'SHA256SUMS.asc is missing' }
  if (!sumsPath) return { status: 'FAIL', detail: 'SHA256SUMS must be a regular file inside the release directory' }
  if (!publicKeyPath?.trim()) return { status: 'BLOCKED', detail: 'supply an owner-authorized public key with --public-key' }
  if (!fingerprint?.trim()) return { status: 'BLOCKED', detail: 'supply the trusted full fingerprint with --fingerprint' }
  const expected = fingerprint.replace(/\s+/g, '').toUpperCase()
  if (!/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(expected)) {
    return { status: 'FAIL', detail: 'expected fingerprint must be a full 40- or 64-hex-character OpenPGP fingerprint' }
  }
  const keyPath = resolve(publicKeyPath)
  if (!existsSync(keyPath)) return { status: 'BLOCKED', detail: 'configured public key file does not exist' }
  const keyText = readFileSync(keyPath, 'utf8')
  if (/-----BEGIN PGP (?:PRIVATE|SECRET) KEY BLOCK-----/.test(keyText)) {
    return { status: 'FAIL', detail: 'verification accepts public-key material only; private key input is refused' }
  }
  if (!keyText.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) {
    return { status: 'FAIL', detail: 'public key must be an armored OpenPGP public-key export' }
  }
  if (!metadataPath) return { status: 'FAIL', detail: bundleEntryExists('signature.json')
    ? 'signature.json must be a regular file inside the release directory'
    : 'signature.json is missing' }
  let metadata
  try { metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) } catch {
    return { status: 'FAIL', detail: 'signature.json is invalid JSON' }
  }
  if (metadata?.schema !== 'ragam-release-signature/1' || metadata?.status !== 'SIGNED'
    || metadata?.signedFile !== 'SHA256SUMS' || metadata?.signatureFile !== 'SHA256SUMS.asc'
    || metadata?.verified !== true) {
    return { status: 'FAIL', detail: 'signature.json does not describe the expected signed SHA256SUMS bundle' }
  }

  const home = mkdtempSync(join(tmpdir(), 'ragam-gpg-verify-'))
  const env = { ...process.env, GNUPGHOME: home }
  const runGpg = (gpgArgs) => spawnSync('gpg', ['--batch', '--no-tty', ...gpgArgs], {
    env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  })
  try {
    const imported = runGpg(['--import', keyPath])
    if (imported.error?.code === 'ENOENT') return { status: 'BLOCKED', detail: 'gpg is not installed; detached signature was not verified' }
    if (imported.error || imported.status !== 0) {
      return { status: 'FAIL', detail: (imported.stderr || imported.error?.message || 'public-key import failed').trim().slice(0, 600) }
    }
    const listed = runGpg(['--with-colons', '--fingerprint', '--list-keys'])
    if (listed.error || listed.status !== 0) {
      return { status: 'FAIL', detail: (listed.stderr || listed.error?.message || 'could not inspect imported public key').trim().slice(0, 600) }
    }
    const primaryFingerprints = []
    let expectingPrimaryFingerprint = false
    for (const line of listed.stdout.split(/\r?\n/)) {
      const fields = line.split(':')
      if (fields[0] === 'pub') expectingPrimaryFingerprint = true
      else if (fields[0] === 'sub' || fields[0] === 'ssb') expectingPrimaryFingerprint = false
      else if (fields[0] === 'fpr' && expectingPrimaryFingerprint) {
        primaryFingerprints.push((fields[9] ?? '').toUpperCase())
        expectingPrimaryFingerprint = false
      }
    }
    if (primaryFingerprints.length !== 1 || primaryFingerprints[0] !== expected) {
      return { status: 'FAIL', detail: `imported public key fingerprint did not match the pinned fingerprint ${expected}` }
    }
    const verified = runGpg(['--status-fd=1', '--verify', signaturePath, sumsPath])
    if (verified.error?.code === 'ENOENT') return { status: 'BLOCKED', detail: 'gpg is not installed; detached signature was not verified' }
    if (verified.error || verified.status !== 0) {
      return { status: 'FAIL', detail: (verified.stderr || verified.error?.message || 'gpg signature verification failed').trim().slice(0, 600) }
    }
    const validSignatures = `${verified.stdout}\n${verified.stderr}`.split(/\r?\n/)
      .filter((line) => line.startsWith('[GNUPG:] VALIDSIG '))
    if (validSignatures.length !== 1) return { status: 'FAIL', detail: 'gpg did not report exactly one cryptographically valid detached signature' }
    const fields = validSignatures[0].split(/\s+/)
    const signerFingerprint = (fields[2] ?? '').toUpperCase()
    const signingPrimaryFingerprint = (fields.length >= 12 ? fields[11] : signerFingerprint).toUpperCase()
    if (signingPrimaryFingerprint !== expected) {
      return { status: 'FAIL', detail: `signature was not made by the pinned fingerprint ${expected}` }
    }
    return { status: 'PASS', detail: `gpg verified SHA256SUMS with pinned fingerprint ${expected}` }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

try {
  if (!lstatSync(out).isDirectory()) throw new Error('not a directory')
} catch {
  console.error(`release directory is missing or not a real directory: ${out}`)
  process.exit(2)
}

// 1. Independent checksum verification and optional/required detached signature.
const sums = verifyChecksumsWithSha256sum(out)
check('sha256sum -c SHA256SUMS', sums.ok, sums.output.split('\n').slice(-3).join(' | '))
const signaturePath = bundleFile('SHA256SUMS.asc')
if (!signaturePath) {
  if (bundleEntryExists('SHA256SUMS.asc')) {
    check('detached signature verification', false, 'SHA256SUMS.asc must be a regular file inside the release directory')
  } else if (bundleEntryExists('signature.json')) {
    check('detached signature verification', false, 'signature.json exists without SHA256SUMS.asc')
  } else if (requireSignature) {
    check('detached signature verification', false, 'required but SHA256SUMS.asc is missing', 'BLOCKED')
  } else {
    check('detached signature verification', false, 'NOT TESTED: bundle is unsigned; pass --require-signature for release acceptance', 'NOT TESTED')
  }
} else {
  const signature = verifyDetachedSignature({ publicKeyPath: publicKeyFile, fingerprint: expectedFingerprint })
  check('detached signature verification', signature.status === 'PASS', signature.detail, signature.status)
}

// 2. Manifest digests recomputed with node:crypto. Filenames in this external
// input are untrusted: only regular basename-only files inside the bundle may be
// opened, and the artifact set must be the release's exact expected set.
const manifestPath = bundleFile('manifest.json')
if (!manifestPath) {
  check('manifest.json exists', false, bundleEntryExists('manifest.json')
    ? 'manifest.json must be a regular file inside the release directory' : 'missing or unsafe')
} else {
  let manifest
  let manifestParsed = true
  try { manifest = readJson(manifestPath) } catch {
    manifestParsed = false
    check('manifest.json is valid JSON', false, 'invalid JSON')
  }
  if (manifestParsed && manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    check('manifest declares UNSIGNED', manifest.signed === false && manifest.unsigned === true, `signed=${manifest.signed}`)
    check('manifest declares no publication', manifest.published === false, `published=${manifest.published}`)
    const versionSafe = typeof manifest.version === 'string' && /^[A-Za-z0-9.-]{1,80}$/.test(manifest.version)
    const expectedNames = versionSafe
      ? [`ragam-source-${manifest.version}.tar.gz`, `ragam-web-${manifest.version}.tar.gz`, 'sbom.cdx.json', 'provenance.json']
      : []
    const artifactEntries = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
    const artifactNames = artifactEntries.map((entry) => entry?.name)
    const artifactSetMatches = versionSafe && artifactEntries.length === expectedNames.length
      && artifactNames.every(safeBundleName)
      && new Set(artifactNames).size === expectedNames.length
      && JSON.stringify([...artifactNames].sort()) === JSON.stringify([...expectedNames].sort())
    check('manifest artifact set is exact', artifactSetMatches, artifactSetMatches
      ? expectedNames.join(', ') : 'expected exactly the versioned source/web archives, SBOM, and provenance')

    for (const entry of artifactEntries) {
      const safeName = safeBundleName(entry?.name)
      const path = safeName ? bundleFile(entry.name) : null
      const digestValid = /^[a-f0-9]{64}$/.test(entry?.sha256 ?? '')
      const ok = Boolean(path && digestValid && sha256OfFile(path) === entry.sha256)
      const label = safeName ? entry.name : '[unsafe manifest filename]'
      check(`artifact ${label}`, ok, ok ? `${entry.bytes} bytes` : 'unsafe path, missing, or digest mismatch')
    }

    const checksumPath = manifest.checksumFile?.name === 'SHA256SUMS' ? bundleFile('SHA256SUMS') : null
    const checksumDigestValid = /^[a-f0-9]{64}$/.test(manifest.checksumFile?.sha256 ?? '')
    const checksumOk = Boolean(checksumPath && checksumDigestValid
      && sha256OfFile(checksumPath) === manifest.checksumFile.sha256)
    check('SHA256SUMS digest', checksumOk, checksumOk ? 'digest matches manifest'
      : 'unsafe filename, missing file, or digest mismatch')

    const sbomPath = manifest.sbom?.name === 'sbom.cdx.json' ? bundleFile('sbom.cdx.json') : null
    const sbomDigestValid = /^[a-f0-9]{64}$/.test(manifest.sbom?.sha256 ?? '')
    const sbomOk = Boolean(sbomPath && sbomDigestValid && sha256OfFile(sbomPath) === manifest.sbom.sha256)
    check('SBOM digest', sbomOk, sbomOk ? 'sbom.cdx.json digest matches manifest'
      : 'unsafe filename, missing file, or digest mismatch')

    const provenancePath = manifest.provenance?.name === 'provenance.json' ? bundleFile('provenance.json') : null
    const provenanceDigestValid = /^[a-f0-9]{64}$/.test(manifest.provenance?.sha256 ?? '')
    const provenanceDigestOk = Boolean(provenancePath && provenanceDigestValid
      && sha256OfFile(provenancePath) === manifest.provenance.sha256)
    check('provenance digest', provenanceDigestOk, provenanceDigestOk ? 'provenance.json digest matches manifest'
      : 'unsafe filename, missing file, or digest mismatch')

    if (provenancePath) {
      let provenance
      let provenanceParsed = true
      try { provenance = readJson(provenancePath) } catch {
        provenanceParsed = false
        check('provenance.json is valid JSON', false, 'invalid JSON')
      }
      if (provenanceParsed && provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
        const commitValid = /^[0-9a-f]{40}$/.test(provenance.commit ?? '')
        const treeValid = /^[0-9a-f]{40}$/.test(provenance.tree ?? '')
        const object = commitValid
          ? spawnSync('git', ['cat-file', '-e', `${provenance.commit}^{commit}`], { cwd: REPO_ROOT, encoding: 'utf8' })
          : null
        check('provenance commit resolves', object?.status === 0, commitValid ? provenance.commit : 'invalid commit identifier')
        const tree = commitValid && treeValid && object?.status === 0
          ? spawnSync('git', ['rev-parse', `${provenance.commit}^{tree}`], { cwd: REPO_ROOT, encoding: 'utf8' })
          : null
        check('provenance tree matches commit', tree?.status === 0 && tree.stdout.trim() === provenance.tree,
          tree ? `${provenance.tree} vs ${tree.stdout.trim()}` : 'invalid or unresolved provenance commit/tree')
        check('provenance clean checkout', provenance.cleanCheckout === true, provenance.cleanCheckoutMethod)
        check('manifest commit and version match provenance', manifest.commit === provenance.commit
          && manifest.version === provenance.version && commitValid,
        `manifest ${manifest.commit ?? '(missing)'}/${manifest.version ?? '(missing)'} vs provenance ${provenance.commit}/${provenance.version}`)

        const releaseArtifactNames = versionSafe
          ? [`ragam-source-${manifest.version}.tar.gz`, `ragam-web-${manifest.version}.tar.gz`]
          : []
        const provenanceArtifacts = Array.isArray(provenance.artifacts) ? provenance.artifacts : []
        const manifestArtifacts = new Map(artifactEntries.map((entry) => [entry?.name, entry]))
        const provenanceArtifactMap = new Map(provenanceArtifacts.map((entry) => [entry?.name, entry]))
        const provenanceArtifactsMatch = provenanceArtifacts.length === releaseArtifactNames.length
          && provenanceArtifactMap.size === releaseArtifactNames.length
          && releaseArtifactNames.every((name) => {
            const recorded = provenanceArtifactMap.get(name)
            const bundled = manifestArtifacts.get(name)
            return recorded && bundled && recorded.bytes === bundled.bytes && recorded.sha256 === bundled.sha256
          })
        check('release artifact digests match provenance', provenanceArtifactsMatch,
          provenanceArtifactsMatch ? 'source and web digests match' : 'provenance artifact list does not match manifest')

        const provenanceSbomMatches = provenance.sbom?.path === 'sbom.cdx.json'
          && provenance.sbom?.sha256 === manifest.sbom?.sha256
          && manifest.sbom?.name === 'sbom.cdx.json'
        check('SBOM digest matches provenance', provenanceSbomMatches,
          provenanceSbomMatches ? 'SBOM digest matches' : 'provenance and manifest SBOM records differ')

        const expectedLockPaths = ['apps/web/package-lock.json', 'apps/desktop/package-lock.json', 'services/fabric/requirements.lock']
        const provenanceInputs = Array.isArray(provenance.inputs) ? provenance.inputs : []
        const inputMap = new Map(provenanceInputs.map((entry) => [entry?.path, entry?.sha256]))
        const lockInputsMatch = provenanceInputs.length === expectedLockPaths.length
          && inputMap.size === expectedLockPaths.length
          && expectedLockPaths.every((path) => /^[a-f0-9]{64}$/.test(inputMap.get(path) ?? '')
            && existsSync(atRoot(path)) && sha256OfFile(atRoot(path)) === inputMap.get(path))
        check('provenance lockfile inputs match', lockInputsMatch,
          lockInputsMatch ? 'three committed lockfile digests match' : 'recorded lockfile inputs are missing or stale')
      } else if (provenanceParsed) {
        check('provenance.json is an object', false, 'provenance must be a JSON object')
      }
    } else {
      check('provenance commit resolves', false, 'unsafe filename or missing provenance file')
      check('provenance tree matches commit', false, 'provenance file is not available for tree verification')
      check('provenance clean checkout', false, 'provenance file is not available for clean-checkout verification')
    }
    const currentVersion = readFileSync(atRoot('VERSION'), 'utf8').trim()
    check('VERSION matches manifest', manifest.version === currentVersion, `${manifest.version} vs ${currentVersion}`)
  } else if (manifestParsed) {
    check('manifest.json is an object', false, 'manifest must be a JSON object')
  }
}

// 4. Qualification report integrity (PASS evidence, BLOCKED unblock, no laundering).
const reportPath = flag('report', 'docs/release/qualification.json')
const fullReport = atRoot(reportPath)
if (!existsSync(fullReport)) {
  check('qualification report exists', false, reportPath)
} else {
  const report = readJson(fullReport)
  const verdict = validateQualificationReport(report)
  check('qualification report schema and statuses', verdict.ok, verdict.problems.slice(0, 6).join('; '))
  check('no mandatory gate laundered to PASS', verdict.nonPassMandatory > 0 ? report.finalVerdict === 'NOT RELEASE READY' : true,
    `${verdict.nonPassMandatory} non-PASS mandatory gates`)
}

for (const entry of checks) console.log(`${entry.status}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`)
if (problems.length) {
  console.error(`\nverification refused: ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`\nverified ${checks.length} independent checks for ${basename(out)}`)
