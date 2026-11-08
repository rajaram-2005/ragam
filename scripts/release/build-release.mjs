#!/usr/bin/env node
// Build a reproducible, versioned release staging bundle.
//
//   node scripts/release/build-release.mjs --out build/release/0.2.0
//
// The source artifact is `git archive` of one exact commit, so no working-tree
// file can leak in. The web bundle is built from that same extracted archive
// with `npm ci` (the committed lockfile), not from a developer's node_modules.
// Every step refuses rather than guessing: a dirty checkout, a version that
// disagrees with a package, a missing lockfile, or a failed install stops the
// build with a non-zero exit code.
//
// This script does NOT sign and does NOT publish. Signing is a separate,
// fail-closed step that needs an authorized key; publication needs explicit
// owner authorization.

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

import { REPO_ROOT, atRoot, readJson, writeJson, sha256OfFile, writeChecksums, collectSbom, buildProvenance } from './lib.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const has = (name) => args.includes(`--${name}`)

function run(cmd, cmdArgs, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error) throw new Error(`${cmd} ${cmdArgs.join(' ')}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim().slice(0, 800)}`)
  return result
}

function binary(cmd, cmdArgs, input, options = {}) {
  const result = spawnSync(cmd, cmdArgs, { input, maxBuffer: 128 * 1024 * 1024, ...options })
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${cmd} exited ${result.status}: ${String(result.stderr).slice(0, 800)}`)
  return result.stdout
}

function gz(bytes) {
  return binary('gzip', ['-n', '-9'], bytes)
}

const version = (readFileSync(atRoot('VERSION'), 'utf8')).trim()
if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(version)) throw new Error(`VERSION '${version}' is not semver`)
for (const path of ['package.json', 'services/core/package.json', 'apps/web/package.json', 'apps/desktop/package.json']) {
  const declared = readJson(atRoot(path)).version
  if (declared !== version) throw new Error(`${path} declares ${declared}, VERSION declares ${version}`)
}
for (const path of ['apps/web/package-lock.json', 'apps/desktop/package-lock.json', 'services/fabric/requirements.lock']) {
  if (!existsSync(atRoot(path))) throw new Error(`pinned dependency input ${path} is missing`)
}

const status = run('git', ['status', '--porcelain']).stdout.trim()
if (status && !has('allow-dirty')) {
  throw new Error(`refusing to build from a dirty working tree (commit first, or pass --allow-dirty for a throwaway build):\n${status.split('\n').slice(0, 8).join('\n')}`)
}

const requested = flag('commit', 'HEAD')
const commit = run('git', ['rev-parse', requested]).stdout.trim()
run('git', ['cat-file', '-e', `${commit}^{commit}`])
const out = atRoot(flag('out', `build/release/${version}`))
mkdirSync(out, { recursive: true })

// Clean checkout: extract the exact commit into an empty temporary directory.
const work = mkdtempSync(join(tmpdir(), 'ragam-release-'))
const sourceDir = join(work, 'checkout')
mkdirSync(sourceDir, { recursive: true })
try {
  const tarBytes = spawnSync('git', ['archive', '--format=tar', `--prefix=ragam-${version}/`, commit], { cwd: REPO_ROOT, maxBuffer: 128 * 1024 * 1024 })
  if (tarBytes.status !== 0) throw new Error(`git archive failed: ${String(tarBytes.stderr)}`)
  const sourceArtifact = join(out, `ragam-source-${version}.tar.gz`)
  writeFileSync(sourceArtifact, gz(tarBytes.stdout))
  // The extracted tree is used for the web build, not the working tree.
  binary('tar', ['-xf', '-', '-C', sourceDir], tarBytes.stdout)
  const extracted = join(sourceDir, `ragam-${version}`)
  if (!existsSync(join(extracted, 'apps/web/package.json'))) throw new Error('git archive did not produce the expected tree')

  let webArtifact = null
  if (!has('skip-web')) {
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: join(extracted, 'apps/web') })
    run('npm', ['run', 'build'], { cwd: join(extracted, 'apps/web') })
    const dist = join(extracted, 'apps/web/dist')
    if (!existsSync(join(dist, 'index.html'))) throw new Error('web build produced no dist/index.html')
    const tar = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', dist, '.'], { maxBuffer: 128 * 1024 * 1024 })
    if (tar.status !== 0) throw new Error(`deterministic tar failed: ${String(tar.stderr)}`)
    webArtifact = join(out, `ragam-web-${version}.tar.gz`)
    writeFileSync(webArtifact, gz(tar.stdout))
  }

  const sbom = collectSbom(REPO_ROOT, { version })
  const sbomPath = join(out, 'sbom.cdx.json')
  writeJson(sbomPath, sbom)

  const artifactPaths = [join(out, `ragam-source-${version}.tar.gz`), ...(webArtifact ? [webArtifact] : [])]
  const provenance = buildProvenance({ root: REPO_ROOT, version, commit, artifacts: artifactPaths, sbomPath })
  const provenancePath = join(out, 'provenance.json')
  writeJson(provenancePath, provenance)

  const checksumFiles = [...artifactPaths, sbomPath, provenancePath]
  const sums = writeChecksums(out, checksumFiles)
  const manifest = {
    schema: 'ragam-release-manifest/1',
    version,
    commit,
    producedAt: provenance.producedAt,
    unsigned: true,
    signed: false,
    signingRequirement: {
      status: 'BLOCKED',
      env: ['RAGAM_RELEASE_SIGNING_KEY_ID', 'RAGAM_RELEASE_SIGNING_KEY_FILE'],
      workflow: 'node scripts/release/sign-release.mjs --dir <out>',
      note: 'An authorized signing key and independent gpg --verify are required. No key was generated or used.',
    },
    artifacts: checksumFiles.map((path) => ({ name: basename(path), bytes: readFileSync(path).length, sha256: sha256OfFile(path) })),
    checksumFile: { name: basename(sums.path), entries: sums.entries, sha256: sha256OfFile(sums.path) },
    sbom: { name: basename(sbomPath), components: sbom.components.length, sha256: sha256OfFile(sbomPath) },
    provenance: { name: basename(provenancePath), sha256: sha256OfFile(provenancePath) },
    cleanCheckout: provenance.cleanCheckoutMethod,
    published: false,
  }
  writeJson(join(out, 'manifest.json'), manifest)

  console.log(`release ${version} staged from clean checkout of ${commit}`)
  console.log(`  out                ${out}`)
  console.log(`  artifacts           ${artifactPaths.map((p) => basename(p)).join(', ')}`)
  console.log(`  checksum entries    ${sums.entries}`)
  console.log(`  SBOM components     ${sbom.components.length}`)
  console.log(`  signature           UNSIGNED (no authorized key)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
