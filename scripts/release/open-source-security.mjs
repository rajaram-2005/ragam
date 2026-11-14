#!/usr/bin/env node
// Zero-cost OSS security qualification runner. All native output and logs are
// captured privately, source/secret-bearing fields are removed before evidence
// is written, and a missing/partial scanner can never produce a PASS.
import {
  accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync, chmodSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  OSS_SECURITY_SCHEMA,
  TRIVY_PIP_REQUIREMENTS_LOCK_PATTERN,
  gateFromScanner,
  normalizeGitleaksJson,
  normalizeSemgrepJson,
  normalizeTrivyJson,
  normalizeZapJson,
  renderZapHtml,
  sanitizeSarif,
  sanitizeZapHtml,
  sha256,
  summarizeFindings,
  trivyFindings,
  zapFindings,
  zapActiveScanOutcome,
} from './open-source-security-utils.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUTPUT_ROOT = resolve(process.env.RAGAM_SECURITY_OUTPUT_DIR || join(tmpdir(), 'ragam-security-qualification'))
const LOCK_PATH = join(ROOT, 'security/scanner-versions.json')
const LOCK = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
const MODES = new Set(['sast', 'dast', 'secrets', 'dependencies', 'full'])
const SCANNER_KEYS = ['sast', 'dast', 'secrets', 'dependencies']
const GATE_KEYS = ['sast', 'findingReview', 'dast', 'authz', 'secrets', 'dependencies', 'checksums', 'sourceIntegrity']
const GATE_IDS = Object.freeze({
  sast: 'SAST',
  findingReview: 'SAST_FINDING_REVIEW',
  dast: 'DAST',
  authz: 'AUTHENTICATION_AUTHORIZATION',
  secrets: 'SECRET_SCANNING',
  dependencies: 'DEPENDENCY_SCANNING',
  checksums: 'REPORT_CHECKSUMS',
  sourceIntegrity: 'SOURCE_INTEGRITY',
})
const GATE_NAMES = Object.freeze({
  findingReview: 'Individual SAST finding review and disposition',
  authz: 'Synthetic authentication and authorization boundary tests',
  checksums: 'Independent scanner-report checksum verification',
  sourceIntegrity: 'Exact source snapshot and working-tree integrity',
})
const EXPECTED_PROBES = Object.freeze({
  'anonymous-session-is-not-authenticated': { method: 'GET', path: '/api/auth', expectedStatus: 200, expectedAuthenticated: false },
  'anonymous-private-config-rejected': { method: 'GET', path: '/api/config', expectedStatus: 401 },
  'synthetic-owner-bootstrap': { method: 'POST', path: '/api/auth/register', expectedStatus: 201, expectedRole: 'owner' },
  'synthetic-owner-session-role': { method: 'GET', path: '/api/auth', expectedStatus: 200, expectedAuthenticated: true, expectedRole: 'owner' },
  'synthetic-member-registration': { method: 'POST', path: '/api/auth/register', expectedStatus: 201, expectedRole: 'member' },
  'synthetic-member-session-role': { method: 'GET', path: '/api/auth', expectedStatus: 200, expectedAuthenticated: true, expectedRole: 'member' },
  'member-cannot-probe-provider-models': { method: 'POST', path: '/api/models/probe', expectedStatus: 403 },
  'member-cannot-change-active-provider': { method: 'PUT', path: '/api/providers/active', expectedStatus: 403 },
  'member-cannot-test-provider-connection': { method: 'POST', path: '/api/providers/ollama/test', expectedStatus: 403 },
  'member-cannot-read-owner-provider-hardware': { method: 'GET', path: '/api/providers/ollama/hardware', expectedStatus: 403 },
  'member-cannot-connect-owner-plugin': { method: 'POST', path: '/api/plugins/connect', expectedStatus: 403 },
})
const EXPECTED_PROBE_IDS = Object.freeze(Object.keys(EXPECTED_PROBES))
const SCAN_ROOTS = [
  'apps', 'services', 'scripts', 'deploy', '.github', 'security/dast',
  '.env.example', 'package.json', 'security/scanner-versions.json',
  'Dockerfile.core', 'Dockerfile.web', 'compose.yaml', 'compose.lan.yaml',
]
const semgrepRuleRoot = 'security/semgrep/rules'
const TOOL_NO_DOWNLOAD = process.env.RAGAM_SECURITY_NO_DOWNLOAD === '1'
const MAX_CAPTURE = 96 * 1024 * 1024
const USER_DATA_DIRECTORIES = new Set(['.aetheris-data'])
const USER_DATA_GIT_PATHSPECS = Object.freeze([
  ':(exclude,glob)**/.aetheris-data',
  ':(exclude,glob)**/.aetheris-data/**',
])
const GENERATED_WORKTREE_DIRECTORIES = new Set([
  '.cache', '.git', '.mypy_cache', '.next', '.nuxt', '.nox', '.output',
  '.parcel-cache', '.pytest_cache', '.ruff_cache', '.svelte-kit', '.tox', '.turbo',
  '.venv', '.vite', '__pycache__', 'build', 'coverage', 'dist', 'node_modules',
  'out', 'target', 'venv',
])
const GENERATED_WORKTREE_SUFFIXES = [
  '.sqlite', '.sqlite-journal', '.sqlite-shm', '.sqlite-wal', '.gguf', '.safetensors',
  '.onnx', '.ckpt', '.lora', '.tmp.mp4', '.tmp.png',
]
const GENERATED_WORKTREE_FILES = new Set([
  'docs/release/evidence/open-source-security-qualification.json',
])
const GENERATED_WORKTREE_PREFIXES = [
  'apps/desktop/release/',
  'apps/web/test/.render-build/',
  'artifacts/',
  'checkpoints/',
  'generated-media/',
]

function now() { return new Date().toISOString() }
function posix(value) { return String(value).split(sep).join('/') }
function relativeToOutput(path) { return posix(relative(OUTPUT_ROOT, path)) }
function pathIsWithin(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function excludedWorktreeClass(pathText) {
  const path = String(pathText ?? '').split(String.fromCharCode(92)).join('/')
  if (!path) return 'invalid-path'
  const parts = path.split('/')
  if (parts.some((part) => USER_DATA_DIRECTORIES.has(part))) return 'user-data'
  if (GENERATED_WORKTREE_FILES.has(path)) return 'generated-output'
  if (GENERATED_WORKTREE_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'generated-output'
  if (GENERATED_WORKTREE_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) return 'generated-output'
  if (parts.some((part) => GENERATED_WORKTREE_DIRECTORIES.has(part))) return 'generated-output'
  return null
}

function isExcludedFromScannerScope(pathText) {
  if (excludedWorktreeClass(pathText) !== null) return true
  const path = String(pathText ?? '').replaceAll('\\', '/')
  if (!path || GENERATED_WORKTREE_FILES.has(path)) return true
  if (GENERATED_WORKTREE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true
  if (GENERATED_WORKTREE_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) return true
  return path.split('/').some((part) => GENERATED_WORKTREE_DIRECTORIES.has(part))
}

function sanitizedEndpoint(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`)
    parsed.username = ''
    parsed.password = ''
    // Proxy paths, queries, and fragments can carry credentials too. Only the
    // origin is required to reach the configured proxy.
    return parsed.origin
  } catch { return null }
}

function childEnvironment() {
  const names = [
    'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
    'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USER', 'LOGNAME',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  ]
  const env = Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]))
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const safe = sanitizedEndpoint(process.env[name])
    if (safe) env[name] = safe
  }
  for (const name of ['NO_PROXY', 'no_proxy']) if (process.env[name] !== undefined) env[name] = process.env[name]
  // Scanner and package-manager processes never inherit GH/AWS/cloud/provider tokens,
  // passwords, or arbitrary application secrets from the invoking shell.
  return env
}

function run(command, args, {
  cwd = ROOT,
  env = childEnvironment(),
  timeout = 0,
  maxBuffer = MAX_CAPTURE,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer,
    windowsHide: true,
    shell: false,
  })
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runBinary(command, args, { cwd = ROOT, env = childEnvironment(), timeout = 0, maxBuffer = MAX_CAPTURE } = {}) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: null, timeout, maxBuffer, windowsHide: true, shell: false,
  })
  return {
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    errorCode: result.error?.code ?? null,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
  }
}

function isExecutable(path) {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

function executableNames(name) {
  return process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
}

function findExecutable(name, extra = []) {
  const candidates = [...extra]
  for (const directory of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const executable of executableNames(name)) candidates.push(join(directory, executable))
  }
  for (const candidate of candidates) if (isExecutable(candidate)) return resolve(candidate)
  return null
}

function safeProcessFailure(label, result) {
  if (result.errorCode === 'ENOENT') return `${label} executable is not installed or not on PATH.`
  if (result.errorCode === 'ETIMEDOUT') return `${label} timed out; its raw output was withheld.`
  if (result.errorCode) return `${label} could not start (${result.errorCode}); its raw output was withheld.`
  if (result.exitCode !== null) return `${label} exited with code ${result.exitCode}; its raw output was withheld.`
  return `${label} did not return an exit status; its raw output was withheld.`
}

function readVersion(command, args, expected, pattern, label, { timeout = 30_000 } = {}) {
  const result = run(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 })
  const output = `${result.stdout}\n${result.stderr}`
  const match = pattern.exec(output)
  const version = match?.[1] ?? null
  if (result.exitCode !== 0 || !version) {
    return { ok: false, version, exitCode: result.exitCode, reason: safeProcessFailure(`${label} version check`, result) }
  }
  if (version !== expected) {
    return { ok: false, version, exitCode: result.exitCode, reason: `${label} version ${version} does not match the pinned ${expected}; refusing to qualify with a different scanner.` }
  }
  return { ok: true, version, exitCode: result.exitCode, reason: null }
}

function platformReason(tool) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    return `${tool} pinned installer currently supports linux/amd64 only; install the exact pinned version manually or run the qualification workflow on ubuntu-latest.`
  }
  return null
}

function installPinnedArchive({ name, url, sha256: expectedSha, binaryName, installDir }) {
  const unsupported = platformReason(name)
  if (unsupported) return { ok: false, path: null, reason: unsupported }
  if (TOOL_NO_DOWNLOAD) {
    return {
      ok: false,
      path: null,
      reason: `Pinned ${name} binary is not installed; automatic download was explicitly disabled by RAGAM_SECURITY_NO_DOWNLOAD=1, so no ${name} scan was executed.`,
    }
  }
  if (!installDir || pathIsWithin(ROOT, resolve(installDir))) {
    return { ok: false, path: null, reason: `Pinned ${name} installation requires a private tool directory outside the source tree.` }
  }
  mkdirSync(installDir, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(installDir, `.${name}-install-`))
  const archive = join(staging, 'scanner.tar.gz')
  const destination = join(installDir, binaryName)
  try {
    const downloaded = run('curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '2',
      '--connect-timeout', '15', '--max-time', '300', '--output', archive, url,
    ], { timeout: 330_000, maxBuffer: 2 * 1024 * 1024 })
    if (downloaded.exitCode !== 0 || downloaded.errorCode || !existsSync(archive)) {
      const code = downloaded.errorCode ?? downloaded.exitCode ?? 'unknown'
      let reason = `Pinned ${name} release download failed (curl exit ${code}); no scanner was run.`
      const diagnostic = `${downloaded.stderr}\n${downloaded.stdout}`
      if (/SSL_ERROR_SYSCALL|SSL_connect|TLS/i.test(diagnostic)) reason = `Pinned ${name} release download failed because the TLS connection to the GitHub release asset could not be established (curl exit ${code}); no scanner was run.`
      else if (/Could not resolve|name resolution|DNS/i.test(diagnostic)) reason = `Pinned ${name} release download failed because the GitHub release asset hostname could not be resolved (curl exit ${code}); no scanner was run.`
      else if (/403|forbidden|denied/i.test(diagnostic)) reason = `Pinned ${name} release asset download was denied (curl exit ${code}); no scanner was run.`
      else if (/404|not found/i.test(diagnostic)) reason = `Pinned ${name} release asset was not found (curl exit ${code}); no scanner was run.`
      return { ok: false, path: null, reason }
    }
    const observed = sha256(readFileSync(archive))
    if (observed !== expectedSha) {
      return { ok: false, path: null, reason: `Pinned ${name} archive SHA-256 mismatch; the binary was not extracted or executed.` }
    }
    const extracted = run('tar', ['-xzf', archive, '-C', staging, binaryName], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    const extractedPath = join(staging, binaryName)
    if (extracted.exitCode !== 0 || !isExecutable(extractedPath)) {
      return { ok: false, path: null, reason: `Pinned ${name} archive was checksum-valid but its expected executable could not be extracted; no scan was run.` }
    }
    copyFileSync(extractedPath, destination)
    chmodSync(destination, 0o755)
    return { ok: true, path: destination, reason: null, archiveSha256: observed }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

function ensureSemgrep({ runDir }) {
  const expected = LOCK.semgrep.version
  let binary = findExecutable('semgrep', [process.env.RAGAM_SEMGREP_BIN].filter(Boolean))
  if (!binary) {
    if (TOOL_NO_DOWNLOAD) return { ok: false, path: null, version: null, reason: 'Pinned Semgrep CE is not installed; automatic package installation was explicitly disabled by RAGAM_SECURITY_NO_DOWNLOAD=1.' }
    const python = findExecutable('python3') ?? findExecutable('python')
    if (!python) return { ok: false, path: null, version: null, reason: 'Python 3 is required to install pinned Semgrep CE from PyPI, but no Python executable is installed.' }
    const venv = join(runDir, 'tools', 'semgrep-venv')
    mkdirSync(dirname(venv), { recursive: true, mode: 0o700 })
    const created = run(python, ['-m', 'venv', venv], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    if (created.exitCode !== 0) return { ok: false, path: null, version: null, reason: safeProcessFailure('Semgrep virtual-environment creation', created) }
    const pythonInVenv = join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const installed = run(pythonInVenv, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', `semgrep==${expected}`], { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 })
    if (installed.exitCode !== 0) return { ok: false, path: null, version: null, reason: `Pinned Semgrep CE ${expected} could not be installed from PyPI (pip exit ${installed.exitCode}); no SAST scan was run.` }
    binary = findExecutable('semgrep', [join(venv, 'bin/semgrep'), join(venv, 'Scripts/semgrep.exe')])
  }
  if (!binary) return { ok: false, path: null, version: null, reason: 'Semgrep package installation completed but its executable is unavailable; no SAST scan was run.' }
  const checked = readVersion(binary, ['--disable-version-check', '--metrics=off', '--version'], expected, /\b(\d+\.\d+\.\d+)\b/, 'Semgrep CE', { timeout: 30_000 })
  return { ...checked, path: binary }
}

function ensureGitleaks({ runDir }) {
  const expected = LOCK.gitleaks.version
  let binary = findExecutable('gitleaks', [process.env.RAGAM_GITLEAKS_BIN, join(runDir, 'tools', 'gitleaks')].filter(Boolean))
  if (!binary) {
    const installed = installPinnedArchive({
      name: 'Gitleaks', url: LOCK.gitleaks.url, sha256: LOCK.gitleaks.sha256, binaryName: 'gitleaks', installDir: join(runDir, 'tools'),
    })
    if (!installed.ok) return { ...installed, version: null }
    binary = installed.path
  }
  const checked = readVersion(binary, ['version'], expected, /\bv?(\d+\.\d+\.\d+)\b/, 'Gitleaks')
  return { ...checked, path: binary }
}

function ensureTrivy({ runDir }) {
  const expected = LOCK.trivy.version
  let binary = findExecutable('trivy', [process.env.RAGAM_TRIVY_BIN, join(runDir, 'tools', 'trivy')].filter(Boolean))
  if (!binary) {
    const installed = installPinnedArchive({
      name: 'Trivy', url: LOCK.trivy.url, sha256: LOCK.trivy.sha256, binaryName: 'trivy', installDir: join(runDir, 'tools'),
    })
    if (!installed.ok) return { ...installed, version: null }
    binary = installed.path
  }
  const checked = readVersion(binary, ['--version'], expected, /(?:Version:\s*|\bv)(\d+\.\d+\.\d+)\b/, 'Trivy')
  return { ...checked, path: binary }
}

function makeRunDirectory(context) {
  mkdirSync(OUTPUT_ROOT, { recursive: true, mode: 0o700 })
  const checkoutRealPath = realpathSync(ROOT)
  const outputRealPath = realpathSync(OUTPUT_ROOT)
  if (pathIsWithin(checkoutRealPath, outputRealPath)) throw new Error('RAGAM_SECURITY_OUTPUT_DIR must resolve outside the source checkout; scanner reports must never be written into the source tree.')
  try { chmodSync(outputRealPath, 0o700) } catch { /* Windows ACLs are managed by the user */ }
  const stamp = now().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
  const name = `${context.commit?.slice(0, 12) ?? 'unknown'}-${stamp}-${context.runId.slice(0, 8)}`
  const runDir = join(OUTPUT_ROOT, name)
  mkdirSync(runDir, { recursive: false, mode: 0o700 })
  const reportsDir = join(runDir, 'reports')
  mkdirSync(reportsDir, { recursive: false, mode: 0o700 })
  try { chmodSync(runDir, 0o700); chmodSync(reportsDir, 0o700) } catch { /* Windows ACLs are managed by the user */ }
  return { runDir, reportsDir, evidencePath: join(runDir, 'open-source-security-qualification.json') }
}

function gitValue(args) {
  const result = run('git', args, { timeout: 30_000, maxBuffer: 24 * 1024 * 1024 })
  return result.exitCode === 0 ? result.stdout : null
}

function walkFiles(root, predicate = () => true, base = root) {
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const relativePath = posix(relative(base, path))
    if (entry.isDirectory()) {
      if (!isExcludedFromScannerScope(relativePath)) out.push(...walkFiles(path, predicate, base))
    } else if (entry.isFile() && predicate(path)) out.push(path)
  }
  return out
}

function getSourceIdentity() {
  const commit = gitValue(['rev-parse', 'HEAD'])?.trim() ?? null
  const tree = commit ? gitValue(['rev-parse', 'HEAD^{tree}'])?.trim() ?? null : null
  const status = gitValue(['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...USER_DATA_GIT_PATHSPECS])
  const statusOk = status !== null
  const trackedDiff = runBinary('git', ['diff', '--binary', 'HEAD', '--', '.', ...USER_DATA_GIT_PATHSPECS], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  const trackedRaw = run('git', ['ls-files', '--cached', '-z'], { timeout: 30_000, maxBuffer: 24 * 1024 * 1024 })
  const untrackedRaw = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 30_000, maxBuffer: 24 * 1024 * 1024 })
  const ignoredRaw = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout: 30_000, maxBuffer: 24 * 1024 * 1024 })
  const listingAvailable = trackedRaw.exitCode === 0 && untrackedRaw.exitCode === 0 && ignoredRaw.exitCode === 0
  const trackedPaths = new Set(trackedRaw.exitCode === 0 ? trackedRaw.stdout.split('\0').filter(Boolean) : [])
  const ignoredPaths = new Set(ignoredRaw.exitCode === 0 ? ignoredRaw.stdout.split('\0').filter(Boolean) : [])
  const untrackedPaths = new Set(untrackedRaw.exitCode === 0 ? untrackedRaw.stdout.split('\0').filter(Boolean) : [])
  const userDataPaths = new Set([...trackedPaths, ...untrackedPaths, ...ignoredPaths])
  const excludedUserDataFiles = [...userDataPaths].filter((path) => excludedWorktreeClass(path) === 'user-data').length
  const allExtras = [...new Set([...untrackedPaths, ...ignoredPaths])].sort()
  let excludedGeneratedFiles = 0
  const extras = allExtras.filter((path) => {
    const classification = excludedWorktreeClass(path)
    if (classification === 'generated-output') excludedGeneratedFiles += 1
    return classification === null
  })
  const digest = createHash('sha256')
  const trackedDiffAvailable = trackedDiff.exitCode === 0
  digest.update(trackedDiffAvailable ? trackedDiff.stdout : Buffer.from('git-diff-unavailable'))
  let untrackedCount = 0
  let untrackedBytes = 0
  let ignoredCount = 0
  let ignoredBytes = 0
  let extrasReadable = true
  for (const encoded of extras) {
    const absolute = join(ROOT, encoded)
    let info
    try { info = lstatSync(absolute) } catch { extrasReadable = false; continue }
    let bytes
    try {
      if (info.isSymbolicLink()) bytes = Buffer.from(`symlink\0${readlinkSync(absolute)}`)
      else if (info.isFile()) bytes = readFileSync(absolute)
      else continue
    } catch { extrasReadable = false; continue }
    digest.update(`\0${posix(encoded)}\0${sha256(bytes)}`)
    if (ignoredPaths.has(encoded)) {
      ignoredCount += 1
      ignoredBytes += bytes.length
    } else {
      untrackedCount += 1
      untrackedBytes += bytes.length
    }
  }
  const identityAvailable = Boolean(commit && tree && statusOk && listingAvailable && trackedDiffAvailable && extrasReadable)
  const clean = identityAvailable && status.trim() === '' && ignoredCount === 0
  return {
    commit,
    tree,
    clean,
    statusAvailable: statusOk,
    identityAvailable,
    trackedDiffAvailable,
    listingAvailable,
    workingTreeSha256: digest.digest('hex'),
    untrackedFiles: untrackedCount,
    untrackedBytes,
    ignoredWorktreeFiles: ignoredCount,
    ignoredWorktreeBytes: ignoredBytes,
    excludedGeneratedFiles,
    excludedUserDataFiles,
    statusText: status,
  }
}

function snapshotInventory(sourceRoot) {
  const digest = createHash('sha256')
  let files = 0
  let bytes = 0
  let symlinks = 0
  let excludedGeneratedEntries = 0
  let excludedUserDataEntries = 0
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = posix(relative(sourceRoot, path))
      const classification = excludedWorktreeClass(relativePath)
      if (classification === 'generated-output') { excludedGeneratedEntries += 1; continue }
      if (classification === 'user-data') { excludedUserDataEntries += 1; continue }
      if (classification) { excludedGeneratedEntries += 1; continue }
      if (entry.isDirectory()) { walk(path); continue }
      let content
      if (entry.isSymbolicLink()) {
        content = Buffer.from(`symlink${String.fromCharCode(0)}${readlinkSync(path)}`)
        symlinks += 1
      } else if (entry.isFile()) content = readFileSync(path)
      else continue
      digest.update(`${String.fromCharCode(0)}${relativePath}${String.fromCharCode(0)}${sha256(content)}`)
      files += 1
      bytes += content.length
    }
  }
  walk(sourceRoot)
  return { sha256: digest.digest('hex'), files, bytes, symlinks, excludedGeneratedEntries, excludedUserDataEntries }
}

function createScanSnapshot(context, runDir) {
  if (!context.identityAvailable || !context.commit || !context.tree) {
    return { ok: false, path: null, reason: 'Repository commit/tree or complete working-tree fingerprint could not be measured; scanner execution was refused.' }
  }
  const sourceRoot = join(runDir, 'source')
  if (existsSync(sourceRoot)) return { ok: false, path: null, reason: 'Unique external source snapshot path already exists; refusing to overwrite it.' }
  let worktreeAdded = false
  let excludedGeneratedFiles = 0
  let excludedUserDataFiles = 0
  let copiedFiles = 0
  const sourceInventoryEntries = []
  let copiedBytes = 0
  let copiedSymlinks = 0
  if (context.clean) {
    const committedPaths = run('git', ['ls-tree', '-r', '--name-only', '-z', context.commit], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    if (committedPaths.exitCode !== 0) {
      return { ok: false, path: null, reason: 'Git could not enumerate the immutable commit paths to verify user-data exclusions; no scanner was run.' }
    }
    const committedUserDataCount = committedPaths.stdout.split(String.fromCharCode(0)).filter(Boolean)
      .filter((pathText) => excludedWorktreeClass(pathText) === 'user-data').length
    if (committedUserDataCount > 0) {
      return {
        ok: false,
        path: null,
        excludedUserDataEntries: committedUserDataCount,
        reason: 'The immutable commit contains tracked user-data paths; source checkout and scanner execution were refused to protect their contents.',
      }
    }
    const added = run('git', ['worktree', 'add', '--detach', sourceRoot, context.commit], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
    if (added.exitCode !== 0) return { ok: false, path: null, reason: 'Could not create a detached worktree for the clean recorded commit; no scanner was run.' }
    worktreeAdded = true
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, timeout: 15_000, maxBuffer: 1024 * 1024 })
    const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: sourceRoot, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
    if (head.exitCode !== 0 || head.stdout.trim() !== context.commit || status.exitCode !== 0 || status.stdout.trim() !== '') {
      run('git', ['worktree', 'remove', '--force', sourceRoot], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      return { ok: false, path: null, reason: 'Detached worktree commit/status verification failed; no scanner was run.' }
    }
    const tracked = run('git', ['ls-files', '--cached', '-z'], { cwd: sourceRoot, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    if (tracked.exitCode !== 0) {
      run('git', ['worktree', 'remove', '--force', sourceRoot], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      return { ok: false, path: null, reason: 'Git could not enumerate every tracked path in the detached worktree; no scanner was run.' }
    }
    try {
      for (const pathText of tracked.stdout.split(String.fromCharCode(0)).filter(Boolean).sort()) {
        const classification = excludedWorktreeClass(pathText)
        if (classification) {
          if (classification === 'user-data') excludedUserDataFiles += 1
          else sourceInventoryEntries.push({ path: pathText, classification, includedInSnapshot: false, contentRead: false })
          continue
        }
        const path = join(sourceRoot, pathText)
        const info = lstatSync(path)
        if (info.isSymbolicLink()) {
          const link = readlinkSync(path)
          const resolvedTarget = resolve(dirname(path), link)
          if (!pathIsWithin(sourceRoot, resolvedTarget) || isExcludedFromScannerScope(posix(relative(sourceRoot, resolvedTarget)))) {
            throw new Error('external-or-user-data-symlink')
          }
          sourceInventoryEntries.push({ path: pathText, classification: 'tracked-source', type: 'symlink', includedInSnapshot: true, targetSha256: sha256(Buffer.from(link)) })
        } else if (info.isFile()) {
          const content = readFileSync(path)
          sourceInventoryEntries.push({ path: pathText, classification: 'tracked-source', type: 'file', includedInSnapshot: true, bytes: content.length, sha256: sha256(content) })
        } else {
          throw new Error('unsupported-source-entry')
        }
      }
    } catch {
      run('git', ['worktree', 'remove', '--force', sourceRoot], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
      return { ok: false, path: null, reason: 'A tracked path in the detached source worktree could not be classified safely; no scanner was run.' }
    }
  } else {
    mkdirSync(sourceRoot, { recursive: false, mode: 0o700 })
    const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const tracked = run('git', ['ls-files', '--cached', '-z'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    const ignored = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
    if (listed.exitCode !== 0 || tracked.exitCode !== 0 || ignored.exitCode !== 0) {
      rmSync(sourceRoot, { recursive: true, force: true })
      return { ok: false, path: null, reason: 'Git could not enumerate every tracked, untracked and ignored source path; no scanner was run.' }
    }
    const trackedPaths = new Set(tracked.stdout.split(String.fromCharCode(0)).filter(Boolean))
    const ignoredPaths = new Set(ignored.stdout.split(String.fromCharCode(0)).filter(Boolean))
    const paths = [...new Set([...listed.stdout.split(String.fromCharCode(0)), ...ignoredPaths])].filter(Boolean).sort()
    try {
      for (const pathText of paths) {
        const excludedClass = excludedWorktreeClass(pathText)
        if (excludedClass) {
          if (excludedClass === 'generated-output') {
            excludedGeneratedFiles += 1
            sourceInventoryEntries.push({ path: pathText, classification: excludedClass, includedInSnapshot: false, contentRead: false })
          } else if (excludedClass === 'user-data') {
            excludedUserDataFiles += 1
          } else {
            throw new Error('invalid-source-path')
          }
          continue
        }
        const classification = trackedPaths.has(pathText) ? 'tracked-source' : (ignoredPaths.has(pathText) ? 'ignored-untracked-source' : 'untracked-source')
        const source = join(ROOT, pathText)
        let info
        try { info = lstatSync(source) } catch {
          sourceInventoryEntries.push({ path: pathText, classification: trackedPaths.has(pathText) ? 'tracked-deleted' : 'source-path-unavailable', includedInSnapshot: false, contentRead: false })
          if (!trackedPaths.has(pathText)) throw new Error('source-path-disappeared')
          continue
        }
        const target = join(sourceRoot, pathText)
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        if (info.isSymbolicLink()) {
          const link = readlinkSync(source)
          const resolvedTarget = resolve(dirname(source), link)
          if (!pathIsWithin(ROOT, resolvedTarget) || isExcludedFromScannerScope(relative(ROOT, resolvedTarget))) {
            throw new Error('external-or-generated-symlink')
          }
          const snapshotTarget = join(sourceRoot, relative(ROOT, resolvedTarget))
          symlinkSync(relative(dirname(target), snapshotTarget), target)
          copiedSymlinks += 1
          sourceInventoryEntries.push({ path: pathText, classification, type: 'symlink', includedInSnapshot: true, targetSha256: sha256(Buffer.from(link)) })
        } else if (info.isFile()) {
          const content = readFileSync(source)
          writeFileSync(target, content, { mode: info.mode & 0o111 ? 0o700 : 0o600, flag: 'wx' })
          copiedFiles += 1
          copiedBytes += content.length
          sourceInventoryEntries.push({ path: pathText, classification, type: 'file', includedInSnapshot: true, bytes: content.length, sha256: sha256(content) })
        } else {
          throw new Error('unsupported-source-entry')
        }
      }
    } catch {
      rmSync(sourceRoot, { recursive: true, force: true })
      return { ok: false, path: null, reason: 'A source file or symlink could not be safely materialized inside the isolated snapshot; no scanner was run.' }
    }
    const afterCopy = getSourceIdentity()
    if (!afterCopy.identityAvailable || afterCopy.commit !== context.commit || afterCopy.tree !== context.tree || afterCopy.workingTreeSha256 !== context.workingTreeSha256) {
      rmSync(sourceRoot, { recursive: true, force: true })
      return { ok: false, path: null, reason: 'The source worktree changed during snapshot creation; no scanner was run.' }
    }
  }

  let inventory
  try { inventory = snapshotInventory(sourceRoot) } catch {
    if (worktreeAdded) run('git', ['worktree', 'remove', '--force', sourceRoot], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    else rmSync(sourceRoot, { recursive: true, force: true })
    return { ok: false, path: null, reason: 'The isolated source snapshot could not be fingerprinted; no scanner was run.' }
  }
  if (!worktreeAdded && inventory.files !== copiedFiles + copiedSymlinks) {
    rmSync(sourceRoot, { recursive: true, force: true })
    return { ok: false, path: null, reason: 'The isolated snapshot file count differs from the materialized working-tree contents; no scanner was run.' }
  }
  const inventoryManifestPath = join(runDir, 'source-inventory.json')
  writeJson(inventoryManifestPath, {
    schema: 'ragam-oss-source-inventory/1',
    recordedAt: now(),
    baseCommit: context.commit,
    baseTree: context.tree,
    workingTreeSha256: context.workingTreeSha256,
    snapshotSha256: inventory.sha256,
    exclusions: {
      generatedOutputEntries: inventory.excludedGeneratedEntries + excludedGeneratedFiles,
      userData: {
        classification: 'user-data',
        directory: '.aetheris-data/',
        workingTreeFileCount: context.excludedUserDataFiles ?? 0,
        snapshotEntryCount: inventory.excludedUserDataEntries + excludedUserDataFiles,
        includedInSnapshot: false,
        contentRead: false,
      },
    },
    entries: sourceInventoryEntries,
  })
  const inventoryManifestSha256 = sha256(readFileSync(inventoryManifestPath))
  const snapshot = {
    ok: true,
    path: sourceRoot,
    mode: worktreeAdded ? 'detached-clean-commit-worktree' : 'isolated-full-working-tree-snapshot',
    exact: true,
    worktreeAdded,
    baseCommit: context.commit,
    baseTree: context.tree,
    workingTreeSha256: context.workingTreeSha256,
    snapshotSha256: inventory.sha256,
    inventoryManifest: relativeToOutput(inventoryManifestPath),
    inventoryManifestSha256,
    inventoryEntryCount: sourceInventoryEntries.length,
    files: inventory.files,
    bytes: inventory.bytes,
    symlinks: inventory.symlinks,
    excludedGeneratedEntries: inventory.excludedGeneratedEntries + excludedGeneratedFiles,
    excludedUserDataEntries: inventory.excludedUserDataEntries + excludedUserDataFiles,
    copiedFiles,
    copiedBytes,
    copiedSymlinks,
    stableDuringRun: null,
  }
  writeJson(join(runDir, 'source-snapshot.json'), {
    schema: 'ragam-oss-source-snapshot/1',
    recordedAt: now(),
    mode: snapshot.mode,
    baseCommit: snapshot.baseCommit,
    baseTree: snapshot.baseTree,
    workingTreeSha256: snapshot.workingTreeSha256,
    snapshotSha256: snapshot.snapshotSha256,
    inventoryManifest: snapshot.inventoryManifest,
    inventoryManifestSha256: snapshot.inventoryManifestSha256,
    inventoryEntryCount: snapshot.inventoryEntryCount,
    fileCount: snapshot.files,
    byteCount: snapshot.bytes,
    symlinkCount: snapshot.symlinks,
    excludedGeneratedEntries: snapshot.excludedGeneratedEntries,
    excludedUserDataEntries: snapshot.excludedUserDataEntries,
    stableAtCreation: true,
  })
  return snapshot
}

function snapshotStillMatches(snapshot) {
  if (!snapshot?.ok || !existsSync(snapshot.path)) return false
  try { return snapshotInventory(snapshot.path).sha256 === snapshot.snapshotSha256 } catch { return false }
}

function cleanupScanSnapshot(snapshot) {
  if (!snapshot?.path) return true
  if (snapshot.worktreeAdded) {
    const removed = run('git', ['worktree', 'remove', '--force', snapshot.path], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    return removed.exitCode === 0
  }
  rmSync(snapshot.path, { recursive: true, force: true })
  return !existsSync(snapshot.path)
}

function rulesetIdentity(sourceRoot) {
  const files = walkFiles(join(sourceRoot, semgrepRuleRoot), (path) => extname(path).toLowerCase() === '.yaml', sourceRoot).sort()
  const hash = createHash('sha256')
  for (const path of files) {
    const rel = posix(relative(sourceRoot, path))
    hash.update(`${rel}\0${sha256(readFileSync(path))}\n`)
  }
  return { path: semgrepRuleRoot, fileCount: files.length, sha256: hash.digest('hex') }
}

function addReport(reports, fullPath, format, validation) {
  if (!existsSync(fullPath)) return null
  const bytes = readFileSync(fullPath)
  const report = {
    path: relativeToOutput(fullPath),
    format,
    bytes: bytes.length,
    sha256: sha256(bytes),
    validated: validation,
    sanitized: true,
  }
  reports.push(report)
  return report
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return path
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
  return path
}

function validateJsonReport(path, predicate = () => true) {
  try { return predicate(JSON.parse(readFileSync(path, 'utf8'))) === true } catch { return false }
}

function validateSarif(path) {
  return validateJsonReport(path, (value) => value?.version === '2.1.0' && Array.isArray(value?.runs) && value.runs.length === 1)
}

function validateHtml(path, brand) {
  try {
    const text = readFileSync(path, 'utf8')
    return /<html[\s>]/i.test(text) && /<\/html>/i.test(text) && text.includes(brand)
  } catch { return false }
}

function createScannerRecord({ name, version = null, status = 'NOT_RUN', reason = null, scope = {} } = {}) {
  return {
    name,
    version,
    execution: {
      executed: false,
      status,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      reason,
      runs: [],
    },
    scope,
    findings: [],
    findingSummary: summarizeFindings([]),
    reviewState: 'NOT_TESTED',
    reports: [],
  }
}

function finishRecord(record, { version, status, startedAt, exitCode, reason = null, runs = [], findings = [], reports = [], scope = record.scope } = {}) {
  record.version = version ?? record.version
  record.execution = {
    executed: runs.some((item) => item.executed === true),
    status,
    startedAt: startedAt ?? record.execution.startedAt,
    completedAt: now(),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    reason,
    runs,
  }
  record.scope = scope
  record.findings = findings
  record.findingSummary = summarizeFindings(findings)
  record.reviewState = findings.length
    ? (findings.every((finding) => finding.reviewState === 'REVIEWED') ? 'REVIEWED' : 'UNREVIEWED')
    : (record.execution.executed ? 'NO_FINDINGS' : 'NOT_TESTED')
  record.reports = reports
  return record
}

function verifyReportHashes(scans, { runDir }) {
  const byScanner = {}
  for (const [key, scan] of Object.entries(scans)) {
    const reports = Array.isArray(scan?.reports) ? scan.reports : []
    if (!reports.length) {
      byScanner[key] = { verified: false, count: 0, method: 'sha256sum -c', reason: 'No validated scanner reports were produced.' }
      continue
    }
    const lines = []
    let missing = null
    for (const report of reports) {
      const path = join(OUTPUT_ROOT, report.path)
      if (!existsSync(path)) { missing = relativeToOutput(path); break }
      lines.push(`${report.sha256}  ${relative(runDir, path).split(sep).join('/')}`)
    }
    if (missing) {
      byScanner[key] = { verified: false, count: reports.length, method: 'sha256sum -c', reason: `Expected report is missing: ${missing}.` }
      continue
    }
    const manifestPath = join(runDir, `SHA256SUMS-${key}`)
    writeText(manifestPath, `${lines.join('\n')}\n`)
    const checked = run('sha256sum', ['-c', relative(runDir, manifestPath).split(sep).join('/')], { cwd: runDir, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    byScanner[key] = checked.exitCode === 0
      ? { verified: true, count: reports.length, method: 'sha256sum -c', manifest: relativeToOutput(manifestPath), reason: null }
      : { verified: false, count: reports.length, method: 'sha256sum -c', reason: checked.errorCode ? `Independent checksum verifier unavailable (${checked.errorCode}).` : `Independent sha256sum verification failed (exit ${checked.exitCode}).` }
  }
  const byArtifact = {}
  if (scans.dast) {
    const report = (scans.dast.reports ?? []).find((item) => item.path.endsWith('/dast-authz-probes.json'))
    if (!report) {
      byArtifact.dastAuthz = { verified: false, count: 0, method: 'sha256sum -c', reason: 'The dedicated authentication/authorization report was not produced.' }
    } else {
      const path = join(OUTPUT_ROOT, report.path)
      if (!existsSync(path)) {
        byArtifact.dastAuthz = { verified: false, count: 1, method: 'sha256sum -c', reason: 'The dedicated authentication/authorization report is missing.' }
      } else {
        const manifestPath = join(runDir, 'SHA256SUMS-authz')
        writeText(manifestPath, `${report.sha256}  ${relative(runDir, path).split(sep).join('/')}\n`)
        const checked = run('sha256sum', ['-c', relative(runDir, manifestPath).split(sep).join('/')], { cwd: runDir, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
        byArtifact.dastAuthz = checked.exitCode === 0
          ? { verified: true, count: 1, method: 'sha256sum -c', manifest: relativeToOutput(manifestPath), report: report.path, reason: null }
          : { verified: false, count: 1, method: 'sha256sum -c', report: report.path, reason: checked.errorCode ? `Independent authz checksum verifier unavailable (${checked.errorCode}).` : `Independent authz checksum verification failed (exit ${checked.exitCode}).` }
      }
    }
  }
  const sourceArtifactNames = ['source-snapshot.json', 'source-inventory.json']
  const sourceArtifacts = sourceArtifactNames.map((name) => ({ name, path: join(runDir, name) }))
  if (sourceArtifacts.some((item) => !existsSync(item.path))) {
    byArtifact.sourceSnapshot = { verified: false, count: 0, method: 'sha256sum -c', reason: 'The source snapshot or file inventory manifest is missing.' }
  } else {
    const sourceLines = sourceArtifacts.map((item) => `${sha256(readFileSync(item.path))}  ${item.name}`)
    const manifestPath = join(runDir, 'SHA256SUMS-source-snapshot')
    writeText(manifestPath, `${sourceLines.join('\n')}\n`)
    const checked = run('sha256sum', ['-c', relative(runDir, manifestPath).split(sep).join('/')], { cwd: runDir, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
    byArtifact.sourceSnapshot = checked.exitCode === 0
      ? { verified: true, count: sourceArtifacts.length, method: 'sha256sum -c', manifest: relativeToOutput(manifestPath), files: sourceArtifacts.map((item) => ({ path: relativeToOutput(item.path), bytes: statSync(item.path).size, sha256: sha256(readFileSync(item.path)) })), reason: null }
      : { verified: false, count: sourceArtifacts.length, method: 'sha256sum -c', reason: checked.errorCode ? `Independent source-manifest checksum verifier unavailable (${checked.errorCode}).` : `Independent source-manifest checksum verification failed (exit ${checked.exitCode}).` }
  }
  const values = Object.values(byScanner)
  const artifactValues = Object.values(byArtifact)
  const allVerified = values.length > 0 && values.every((item) => item.verified) && artifactValues.every((item) => item.verified)
  return {
    verified: allVerified,
    count: values.reduce((sum, item) => sum + item.count, 0),
    method: 'sha256sum -c (per-scanner reports, dedicated authz report, and source snapshot/inventory manifests)',
    byScanner,
    byArtifact,
    reason: allVerified ? null : 'One or more requested scanner report sets or independently checked artifacts failed verification or produced no reports.',
  }
}

function initialGate(id, name, requested, mode) {
  return {
    id,
    name,
    independent: true,
    mandatory: true,
    status: requested ? 'BLOCKED' : 'NOT TESTED',
    reason: requested ? 'Scanner has not completed.' : `Not executed by release:${mode}; rerun the individual command or release:security:full.`,
    reviewState: 'NOT TESTED',
    findingSummary: summarizeFindings([]),
    evidence: [],
  }
}

function updateGate(record, { id, name, source, hashVerification, context, evidencePath, findings = record.findings, activeScanRequired = false, activeScanPerformed = false, blockOnAnyFinding = false }) {
  const complete = record.execution.status === 'COMPLETED'
  const ownHashVerification = hashVerification.byScanner?.[source.key] ?? { verified: false, reason: 'Independent report hash verification is unavailable.' }
  const validated = record.reports.length > 0 && record.reports.every((report) => report.validated && report.sha256) && ownHashVerification.verified === true
  const gate = gateFromScanner({
    executed: record.execution.executed,
    complete,
    validated,
    cleanCheckout: context.clean && context.statusAvailable,
    activeScanRequired,
    activeScanPerformed,
    findings,
    blocked: record.execution.status === 'BLOCKED',
    notTested: record.execution.status === 'NOT_RUN',
    executionFailed: record.execution.status === 'FAILED',
    blockOnAnyFinding,
  })
  return {
    id,
    name,
    independent: true,
    mandatory: true,
    status: gate.status,
    reason: record.execution.reason || gate.reason,
    reviewState: record.reviewState,
    findingSummary: summarizeFindings(findings),
    reports: record.reports.map(({ path, format, sha256, bytes, validated: reportValidated }) => ({ path, format, sha256, bytes, validated: reportValidated })),
    evidence: [
      ...(record.execution.executed ? [{ command: source.command, exitCode: record.execution.exitCode, completedAt: record.execution.completedAt }] : []),
      ...(record.execution.executed ? [{ artifact: relativeToOutput(evidencePath), commit: context.commit }] : []),
    ],
    scanner: source,
    hashVerification: { verified: ownHashVerification.verified === true, method: ownHashVerification.method, count: record.reports.length, reason: ownHashVerification.reason ?? null },
  }
}

function controlGate({ id, name, status, reason, reviewState = 'NOT APPLICABLE', findingSummary = summarizeFindings([]), evidence = [], details = {} }) {
  return { id, name, independent: true, mandatory: true, status, reason, reviewState, findingSummary, evidence, ...details }
}

function findingReviewGate({ requested, mode, record, evidencePath }) {
  const name = GATE_NAMES.findingReview
  if (!requested.includes('sast')) return initialGate(GATE_IDS.findingReview, name, false, mode)
  if (record.execution.status !== 'COMPLETED') {
    const notTested = record.execution.status === 'BLOCKED' || record.execution.status === 'NOT_RUN' || !record.execution.executed
    return controlGate({
      id: GATE_IDS.findingReview,
      name,
      status: notTested ? 'NOT TESTED' : 'FAIL',
      reason: notTested ? 'No valid Semgrep report was available to review; finding review was not performed.' : 'Semgrep execution failed before a valid finding-review set could be established.',
      reviewState: 'NOT TESTED',
      evidence: record.execution.executed ? [{ artifact: relativeToOutput(evidencePath), commit: record.source?.commit ?? null }] : [],
    })
  }
  const unreviewed = record.findings.filter((finding) => finding.reviewState !== 'REVIEWED' || !validSemgrepReview(finding.review))
  const acceptedRiskMissingApproval = record.findings.filter((finding) => finding.review?.disposition === 'OWNER_ACCEPTED_RISK'
    && !(finding.review.ownerApproval?.required === true && finding.review.ownerApproval?.status === 'APPROVED'))
  const passed = unreviewed.length === 0 && acceptedRiskMissingApproval.length === 0
  const report = record.reports.find((item) => item.path.endsWith('/semgrep.json'))
  return controlGate({
    id: GATE_IDS.findingReview,
    name,
    status: passed ? 'PASS' : 'FAIL',
    reason: passed
      ? (record.findings.length ? 'Every Semgrep finding has a location-specific technical disposition; any residual risk has recorded owner approval.' : 'Semgrep completed with no findings requiring individual review.')
      : `${unreviewed.length} Semgrep finding(s) remain unreviewed or lack complete technical disposition; residual-risk approval is mandatory.`,
    reviewState: passed ? (record.findings.length ? 'REVIEWED' : 'NO_FINDINGS') : 'UNREVIEWED',
    findingSummary: record.findingSummary,
    evidence: [
      ...(report ? [{ artifact: report.path, sha256: report.sha256 }] : []),
      { artifact: relativeToOutput(evidencePath), commit: record.source?.commit ?? null },
    ],
    details: {
      reviewedCount: record.findings.length - unreviewed.length,
      unreviewedCount: unreviewed.length,
      ownerApprovalMissingCount: acceptedRiskMissingApproval.length,
      dispositions: Object.fromEntries(['FALSE_POSITIVE', 'OWNER_ACCEPTED_RISK'].map((disposition) => [
        disposition, record.findings.filter((finding) => finding.review?.disposition === disposition).length,
      ])),
    },
  })
}

function authzGate({ requested, mode, record, hashVerification }) {
  const name = GATE_NAMES.authz
  if (!requested.includes('dast')) return initialGate(GATE_IDS.authz, name, false, mode)
  const probeRun = record.execution.runs.find((item) => item.name === 'authz-boundary-probes')
  if (!probeRun) {
    const unavailable = record.execution.status === 'BLOCKED'
    return controlGate({
      id: GATE_IDS.authz,
      name,
      status: unavailable ? 'BLOCKED' : 'NOT TESTED',
      reason: unavailable ? 'The isolated DAST prerequisites were unavailable; authentication/authorization probes did not execute.' : 'The target did not become ready for the authentication/authorization probes; no valid probe run occurred.',
      reviewState: 'NOT TESTED',
    })
  }
  const report = record.reports.find((item) => item.path.endsWith('/dast-authz-probes.json'))
  const hash = hashVerification.byArtifact?.dastAuthz
  const passed = probeRun.executed === true
    && probeRun.exitCode === 0
    && probeRun.coverageComplete === true
    && probeRun.failedProbeCount === 0
    && probeRun.reportValidated === true
    && report?.validated === true
    && hash?.verified === true
  const attempted = probeRun.executed === true
  const status = passed ? 'PASS' : (attempted ? 'FAIL' : 'BLOCKED')
  return controlGate({
    id: GATE_IDS.authz,
    name,
    status,
    reason: passed
      ? 'All expected synthetic anonymous/owner/member probes passed and the sanitized result was hash-verified.'
      : (attempted ? 'Authentication/authorization probes failed, were incomplete, or lacked independently verified sanitized evidence.' : 'Authentication/authorization probe prerequisites were unavailable.'),
    reviewState: 'NOT APPLICABLE',
    findingSummary: summarizeFindings(record.findings.filter((finding) => finding.ruleId === 'ragam.authz.boundary')),
    evidence: report ? [{ artifact: report.path, sha256: report.sha256, verified: hash?.verified === true }] : [],
    details: {
      expectedProbeCount: probeRun.expectedProbeCount ?? null,
      observedProbeCount: probeRun.probeCount ?? null,
      failedProbeCount: probeRun.failedProbeCount ?? null,
      coverageComplete: probeRun.coverageComplete === true,
      checksumVerified: hash?.verified === true,
    },
  })
}

function checksumGate({ requested, mode, scans, hashVerification }) {
  const name = GATE_NAMES.checksums
  if (!requested.length) return initialGate(GATE_IDS.checksums, name, false, mode)
  const requestedScans = requested.map((key) => scans[key])
  const unavailable = requestedScans.some((scan) => scan.execution.status === 'BLOCKED')
  const failedAttempt = requestedScans.some((scan) => scan.execution.status === 'FAILED')
  const anyExecuted = requestedScans.some((scan) => scan.execution.executed)
  const manifests = [
    ...Object.entries(hashVerification.byScanner ?? {}).flatMap(([key, value]) => value.manifest
      ? [{ scanner: key, artifact: value.manifest, verified: value.verified === true, reportCount: value.count }]
      : []),
    ...Object.entries(hashVerification.byArtifact ?? {}).flatMap(([key, value]) => value.manifest
      ? [{ scanner: key, artifact: value.manifest, verified: value.verified === true, reportCount: value.count }]
      : []),
  ]
  const status = hashVerification.verified ? 'PASS' : (failedAttempt ? 'FAIL' : (unavailable || !anyExecuted ? 'BLOCKED' : 'FAIL'))
  return controlGate({
    id: GATE_IDS.checksums,
    name,
    status,
    reason: hashVerification.verified
      ? 'Every requested sanitized scanner report was independently recomputed with sha256sum -c.'
      : (status === 'BLOCKED' ? 'One or more requested scanners were unavailable or produced no report set to verify.' : 'An independent report checksum failed or a scanner execution did not produce a complete report set.'),
    evidence: manifests,
    details: { method: hashVerification.method, verified: hashVerification.verified, reportCount: hashVerification.count, byScanner: hashVerification.byScanner, byArtifact: hashVerification.byArtifact },
  })
}

function sourceIntegrityGate({ context, hashVerification }) {
  const name = GATE_NAMES.sourceIntegrity
  if (!context.identityAvailable || !context.statusAvailable) {
    return controlGate({
      id: GATE_IDS.sourceIntegrity,
      name,
      status: 'BLOCKED',
      reason: 'Git could not establish the base commit, tree, status, and complete source fingerprint.',
      reviewState: 'NOT TESTED',
    })
  }
  const snapshot = context.sourceSnapshot ?? {}
  const sourceArtifactsVerified = hashVerification.byArtifact?.sourceSnapshot?.verified === true
  const passed = context.clean === true && context.workingTreeStable === true
    && snapshot.status === 'READY' && snapshot.exact === true
    && snapshot.stableDuringRun === true && snapshot.cleanupSucceeded === true
    && sourceArtifactsVerified
  return controlGate({
    id: GATE_IDS.sourceIntegrity,
    name,
    status: passed ? 'PASS' : 'FAIL',
    reason: passed
      ? 'The exact clean commit and source snapshot fingerprints remained stable; the temporary snapshot was removed successfully.'
      : 'Source-integrity failure: checkout was dirty, the immutable source identity changed, the isolated snapshot was incomplete/unstable, or cleanup failed.',
    reviewState: passed ? 'VERIFIED' : 'FAILED',
    evidence: [
      ...(snapshot.manifest ? [{ artifact: snapshot.manifest, sourceSnapshotSha256: snapshot.snapshotSha256 }] : []),
      ...(snapshot.inventoryManifest ? [{ artifact: snapshot.inventoryManifest, sha256: snapshot.inventoryManifestSha256, entryCount: snapshot.inventoryEntryCount }] : []),
      ...(hashVerification.byArtifact?.sourceSnapshot?.manifest ? [{ artifact: hashVerification.byArtifact.sourceSnapshot.manifest, verified: sourceArtifactsVerified }] : []),
    ],
    details: {
      baseCommit: context.commit,
      baseTree: context.tree,
      workingTreeSha256: context.workingTreeSha256,
      cleanCheckout: context.clean,
      workingTreeStable: context.workingTreeStable,
      snapshotMode: snapshot.mode,
      snapshotSha256: snapshot.snapshotSha256,
      inventoryManifest: snapshot.inventoryManifest,
      inventoryManifestSha256: snapshot.inventoryManifestSha256,
      inventoryEntryCount: snapshot.inventoryEntryCount,
      sourceArtifactsVerified,
      snapshotStable: snapshot.stableDuringRun,
      snapshotCleanupSucceeded: snapshot.cleanupSucceeded,
      fileCount: snapshot.fileCount,
      byteCount: snapshot.byteCount,
      excludedGeneratedEntries: snapshot.excludedGeneratedEntries,
      excludedUserDataEntries: snapshot.excludedUserDataEntries,
    },
  })
}

function writeEvidence(path, report) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch { /* permissions are managed by Windows ACLs */ }
  // Write the fixed evidence path atomically; the file contains sanitized scanner output only.
  renameSync(temporary, path)
}

function semgrepSuppressionReason(sourceRoot) {
  const present = walkFiles(sourceRoot, (path) => path.split(sep).at(-1) === '.semgrepignore', sourceRoot)
    .map((path) => posix(relative(sourceRoot, path)))
    .sort()
  return present.length
    ? `Semgrep suppression file(s) are not permitted for this gate: ${present.join(', ')}.`
    : null
}

const SEMGREP_REVIEW_PATH = 'security/reviews/semgrep-findings.json'
const SEMGREP_REVIEW_DISPOSITIONS = new Set(['FALSE_POSITIVE', 'OWNER_ACCEPTED_RISK'])

function reviewKey(path, line, ruleId) { return `${path}\0${line}\0${ruleId}` }

function validSemgrepReview(entry) {
  if (!entry || typeof entry !== 'object' || !SEMGREP_REVIEW_DISPOSITIONS.has(entry.disposition)) return false
  for (const key of ['path', 'ruleId', 'reviewedAt', 'reviewer', 'sourceToSink', 'exploitability', 'rootCause', 'rationale', 'residualRisk']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) return false
  }
  if (!Number.isInteger(entry.line) || entry.line < 1 || Number.isNaN(Date.parse(entry.reviewedAt))) return false
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0 || entry.evidence.some((item) => typeof item !== 'string' || !item.trim())) return false
  if (entry.disposition === 'FALSE_POSITIVE') {
    return entry.residualRisk.toLowerCase() === 'none identified' && entry.ownerApproval?.required === false
  }
  return entry.ownerApproval?.required === true
    && entry.ownerApproval?.status === 'APPROVED'
    && typeof entry.ownerApproval?.owner === 'string' && entry.ownerApproval.owner.trim().length > 0
    && typeof entry.ownerApproval?.approvedAt === 'string' && !Number.isNaN(Date.parse(entry.ownerApproval.approvedAt))
}

function loadSemgrepReviewCatalog(sourceRoot) {
  const path = join(sourceRoot, SEMGREP_REVIEW_PATH)
  if (!existsSync(path)) return { ok: false, entries: [], sha256: null, reason: 'No source-controlled individual SAST finding review catalog is present.' }
  try {
    const bytes = readFileSync(path)
    const catalog = JSON.parse(bytes.toString('utf8'))
    if (catalog?.schema !== 'ragam-semgrep-finding-reviews/1' || !Array.isArray(catalog.findings)) {
      return { ok: false, entries: [], sha256: sha256(bytes), reason: 'SAST finding review catalog schema is invalid.' }
    }
    const entries = catalog.findings
    const keys = entries.map((entry) => reviewKey(entry?.path, entry?.line, entry?.ruleId))
    const duplicate = new Set(keys).size !== keys.length
    if (duplicate || entries.some((entry) => !validSemgrepReview(entry))) {
      return { ok: false, entries: [], sha256: sha256(bytes), reason: 'SAST finding review catalog contains a duplicate, malformed, or unapproved disposition.' }
    }
    return { ok: true, entries, sha256: sha256(bytes), reason: null }
  } catch {
    return { ok: false, entries: [], sha256: null, reason: 'SAST finding review catalog could not be parsed; findings remain unreviewed.' }
  }
}

function applySemgrepReviews(findings, catalog) {
  const byLocation = new Map(catalog.entries.map((entry) => [reviewKey(entry.path, entry.line, entry.ruleId), entry]))
  return findings.map((finding) => {
    const entry = byLocation.get(reviewKey(finding.path, finding.start?.line, finding.check_id))
    if (!catalog.ok || !entry || !validSemgrepReview(entry)) return finding
    const ownerApproval = entry.disposition === 'OWNER_ACCEPTED_RISK'
      ? { required: true, status: 'APPROVED', owner: entry.ownerApproval.owner, approvedAt: entry.ownerApproval.approvedAt }
      : { required: false, status: 'NOT_REQUIRED' }
    const review = {
      path: entry.path,
      line: entry.line,
      ruleId: entry.ruleId,
      disposition: entry.disposition,
      reviewedAt: new Date(entry.reviewedAt).toISOString(),
      reviewer: entry.reviewer,
      sourceToSink: entry.sourceToSink,
      exploitability: entry.exploitability,
      rootCause: entry.rootCause,
      rationale: entry.rationale,
      evidence: entry.evidence,
      residualRisk: entry.residualRisk,
      ownerApproval,
    }
    return { ...finding, reviewState: 'REVIEWED', review }
  })
}

async function runSemgrep({ context, reportsDir, runDir, sourceRoot }) {
  const startedAt = now()
  const record = createScannerRecord({
    name: LOCK.semgrep.name,
    scope: {
      roots: SCAN_ROOTS,
      rulesDirectory: semgrepRuleRoot,
      rulesRepository: LOCK.semgrep.rulesRepository,
      rulesCommit: LOCK.semgrep.rulesCommit,
      rulesLicense: LOCK.semgrep.rulesLicense,
      registryNetworkAccess: false,
      usageMetrics: 'off',
      suppressions: false,
      rulePack: rulesetIdentity(sourceRoot),
    },
  })
  const suppressionReason = semgrepSuppressionReason(sourceRoot)
  if (suppressionReason) return finishRecord(record, { status: 'FAILED', exitCode: 1, reason: suppressionReason, startedAt, scope: record.scope })
  const tool = ensureSemgrep({ runDir })
  if (!tool.ok) return finishRecord(record, { status: 'BLOCKED', reason: tool.reason, startedAt, scope: record.scope })

  const rawDir = join(runDir, 'private-semgrep')
  mkdirSync(rawDir, { recursive: false, mode: 0o700 })
  const rawJson = join(rawDir, 'semgrep.raw.json')
  const rawSarif = join(rawDir, 'semgrep.raw.sarif')
  const command = [
    'scan', '--disable-version-check', '--disable-nosem', '--config', semgrepRuleRoot, '--metrics=off', '--quiet',
    '--json-output', rawJson, '--sarif-output', rawSarif, '--strict', ...SCAN_ROOTS,
  ]
  const result = run(tool.path, command, { cwd: sourceRoot, timeout: 900_000, maxBuffer: 24 * 1024 * 1024 })
  const reports = []
  let findings = []
  let diagnostics = []
  let version = tool.version
  let validJson = false
  let validSarif = false
  try {
    if (!existsSync(rawJson)) throw new Error('missing JSON output')
    const raw = JSON.parse(readFileSync(rawJson, 'utf8'))
    const normalized = normalizeSemgrepJson(raw, { basePath: sourceRoot })
    const reviewCatalog = loadSemgrepReviewCatalog(sourceRoot)
    findings = applySemgrepReviews(normalized.results, reviewCatalog)
    record.scope.findingReviewCatalog = {
      path: SEMGREP_REVIEW_PATH,
      valid: reviewCatalog.ok,
      sha256: reviewCatalog.sha256,
      entryCount: reviewCatalog.entries.length,
      reason: reviewCatalog.reason,
    }
    diagnostics = normalized.errors
    version = normalized.version || tool.version
    const jsonReport = {
      schema: 'ragam-sanitized-semgrep-report/1',
      scanner: { name: LOCK.semgrep.name, version },
      commit: context.commit,
      generatedAt: now(),
      rulePack: record.scope.rulePack,
      scannedPathCount: normalized.paths.scanned.length,
      paths: normalized.paths,
      findings,
      errors: diagnostics,
    }
    const jsonPath = writeJson(join(reportsDir, 'semgrep.json'), jsonReport)
    validJson = validateJsonReport(jsonPath, (value) => value?.scanner?.version === tool.version && Array.isArray(value?.findings) && Array.isArray(value?.errors))
    if (validJson) addReport(reports, jsonPath, 'json', true)

    if (existsSync(rawSarif)) {
      const rawSarifValue = JSON.parse(readFileSync(rawSarif, 'utf8'))
      const sanitizedSarif = sanitizeSarif(rawSarifValue, { toolName: LOCK.semgrep.name, version, findings })
      const sarifPath = writeJson(join(reportsDir, 'semgrep.sarif'), sanitizedSarif)
      validSarif = validateSarif(sarifPath)
      if (validSarif) addReport(reports, sarifPath, 'sarif', true)
    }
  } catch {
    diagnostics.push({ code: null, type: 'report_validation', path: null, ruleId: null, message: 'Semgrep report was missing or invalid; raw scanner output withheld.' })
  } finally {
    rmSync(rawDir, { recursive: true, force: true })
  }
  const reportValid = validJson && validSarif && reports.length === 2
  const scannerErrors = diagnostics.length > 0
  // Semgrep may return 1 for rule findings; this remains a completed execution if
  // both reports validate and there are no parser/internal scanner errors.
  const complete = reportValid && !scannerErrors && (result.exitCode === 0 || result.exitCode === 1)
  const reason = complete ? null : (!reportValid
    ? 'Semgrep did not produce validated JSON and SARIF reports; raw output was withheld.'
    : (scannerErrors ? `${diagnostics.length} Semgrep parser/internal error(s); affected files/rules are reported and the gate cannot pass.` : safeProcessFailure('Semgrep scan', result)))
  return finishRecord(record, {
    version,
    status: complete ? 'COMPLETED' : 'FAILED',
    startedAt,
    exitCode: result.exitCode,
    reason,
    runs: [{ name: 'semgrep scan', command: `semgrep scan --disable-version-check --disable-nosem --config ${semgrepRuleRoot} --metrics=off --json-output --sarif-output --strict <scope>`, executed: true, exitCode: result.exitCode, signal: result.signal, timeout: result.errorCode === 'ETIMEDOUT' }],
    findings,
    reports,
    scope: { ...record.scope, scannedPathCount: validJson ? JSON.parse(readFileSync(join(reportsDir, 'semgrep.json'), 'utf8')).scannedPathCount : null },
  })
}

function materializeWorkingTree(destination, sourceRoot) {
  let copiedFiles = 0
  let skippedSymlinks = 0
  let excludedGeneratedFiles = 0
  let excludedUserDataFiles = 0
  let bytes = 0
  const copy = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const classification = excludedWorktreeClass(relativePath)
      if (classification === 'generated-output') { excludedGeneratedFiles += 1; continue }
      if (classification === 'user-data') { excludedUserDataFiles += 1; continue }
      if (classification) { excludedGeneratedFiles += 1; continue }
      const source = join(directory, entry.name)
      const target = join(destination, relativePath)
      if (entry.isDirectory()) {
        mkdirSync(target, { recursive: true, mode: 0o700 })
        copy(source, relativePath)
      } else if (entry.isSymbolicLink()) {
        skippedSymlinks += 1
      } else if (entry.isFile()) {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
        const contents = readFileSync(source)
        writeFileSync(target, contents, { mode: 0o600, flag: 'wx' })
        copiedFiles += 1
        bytes += contents.length
      }
    }
  }
  try { copy(sourceRoot) } catch {
    return { ok: false, copiedFiles, skippedSymlinks, excludedGeneratedFiles, excludedUserDataFiles, bytes, reason: 'The isolated source snapshot could not be materialized for Gitleaks; no working-tree secret scan was run.' }
  }
  return {
    ok: skippedSymlinks === 0,
    copiedFiles,
    skippedSymlinks,
    excludedGeneratedFiles,
    excludedUserDataFiles,
    bytes,
    ...(skippedSymlinks ? { reason: 'One or more symlinks could not be safely included in the Gitleaks filesystem scan.' } : {}),
  }
}

function shallowRepository() {
  const result = run('git', ['rev-parse', '--is-shallow-repository'], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  return result.exitCode !== 0 || result.stdout.trim() === 'true'
}

function historicalUserDataPathInventory() {
  const result = run('git', [
    'log', '--all', '--no-renames', '--format=', '--name-only', '--',
    ':(glob)**/.aetheris-data', ':(glob)**/.aetheris-data/**',
  ], { timeout: 120_000, maxBuffer: 24 * 1024 * 1024 })
  if (result.exitCode !== 0) return { ok: false, pathEntryCount: null }
  const pathEntryCount = result.stdout.split('\n').filter(Boolean).length
  return { ok: true, pathEntryCount }
}

async function runGitleaks({ context, reportsDir, runDir, sourceRoot }) {
  const startedAt = now()
  const record = createScannerRecord({
    name: LOCK.gitleaks.name,
    scope: {
      workingTree: 'tracked, untracked, and ignored source/configuration files; generated outputs and the local .aetheris-data user store are separately classified and excluded; symlinks are not followed and block this scan',
      history: '--log-opts=--all over all local refs; CI checkout fetch-depth is zero',
      defaultRules: true,
      ignoreFile: 'explicit empty Gitleaks ignore file and default community rules; repository ignore files are not applied as scanner policy; inline allow-comments are disabled',
      allowComments: 'ignored with --ignore-gitleaks-allow',
      redaction: '100 percent; raw report is private temporary data and is not uploaded',
    },
  })
  const tool = ensureGitleaks({ runDir })
  if (!tool.ok) return finishRecord(record, { status: 'BLOCKED', reason: tool.reason, startedAt, scope: record.scope })

  const shallow = shallowRepository()
  const historyUserData = historicalUserDataPathInventory()
  const historyUserDataBlocked = !historyUserData.ok || historyUserData.pathEntryCount > 0
  const historyUserDataReason = !historyUserData.ok
    ? 'Git could not enumerate historical paths to verify that user-data blobs remain outside the secret scan.'
    : (historyUserData.pathEntryCount > 0
      ? 'Git history contains .aetheris-data user-data paths; Gitleaks history scanning was refused to keep those contents outside the scanner.'
      : null)
  const reports = []
  const findings = []
  const runs = []
  const tempRoot = join(runDir, 'private-gitleaks')
  mkdirSync(tempRoot, { recursive: false, mode: 0o700 })
  try {
    const sourceTree = join(tempRoot, 'working-tree')
    const rawDir = join(tempRoot, 'raw')
    const ignoreDir = join(tempRoot, 'empty-ignore')
    const configPath = join(tempRoot, 'gitleaks-defaults.toml')
    const historyRepo = join(tempRoot, 'history.git')
    mkdirSync(sourceTree, { recursive: true, mode: 0o700 })
    mkdirSync(rawDir, { recursive: true, mode: 0o700 })
    mkdirSync(ignoreDir, { recursive: true, mode: 0o700 })
    const ignoreFile = join(ignoreDir, '.gitleaksignore')
    writeFileSync(ignoreFile, '', { mode: 0o600 })
    writeFileSync(configPath, '[extend]\nuseDefault = true\n', { mode: 0o600 })
    const materialized = materializeWorkingTree(sourceTree, sourceRoot)
    if (!materialized.ok) {
      return finishRecord(record, { version: tool.version, status: 'FAILED', startedAt, reason: materialized.reason })
    }

    const common = [
      '--no-banner', '--redact=100', '--ignore-gitleaks-allow',
      `--gitleaks-ignore-path=${ignoreFile}`, `--config=${configPath}`, '--report-format=json',
    ]
    let historyPrepared = false
    let historyBlockReason = null
    runs.push({
      name: 'history-user-data-path-inventory',
      command: 'git log --all --no-renames --format= --name-only -- <.aetheris-data pathspecs>',
      executed: true,
      exitCode: historyUserData.ok ? 0 : 1,
      pathEntryCount: historyUserData.pathEntryCount,
    })
    const scans = [
      { name: 'working-tree', args: ['dir', ...common, `--report-path=${join(rawDir, 'working.raw.json')}`, sourceTree], raw: join(rawDir, 'working.raw.json'), output: 'gitleaks-working-tree.json', base: sourceTree, required: true },
      { name: 'git-history', args: ['git', ...common, '--log-opts=--all', `--report-path=${join(rawDir, 'history.raw.json')}`, historyRepo], raw: join(rawDir, 'history.raw.json'), output: 'gitleaks-history.json', base: historyRepo, required: !shallow },
    ]
    if (shallow) runs.push({ name: 'git-history', executed: false, exitCode: null, reason: 'Git repository is shallow; full history is not available, so the history scan was not executed.' })
    else if (historyUserDataBlocked) {
      historyBlockReason = historyUserDataReason
      runs.push({ name: 'git-history', executed: false, exitCode: null, reason: historyBlockReason })
    } else {
      const mirror = run('git', ['clone', '--mirror', '--no-hardlinks', ROOT, historyRepo], { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 })
      historyPrepared = mirror.exitCode === 0
      runs.push({ name: 'history-mirror-preparation', executed: true, exitCode: mirror.exitCode, refs: historyPrepared ? 'all local refs copied offline' : undefined })
      if (!historyPrepared) runs.push({ name: 'git-history', executed: false, exitCode: null, reason: 'Could not create an isolated offline mirror of all local refs; history scan was not executed.' })
    }
    let allReportsValid = true
    for (const item of scans) {
      if (!item.required || (item.name === 'git-history' && !historyPrepared)) continue
      const result = run(tool.path, item.args, { timeout: 900_000, maxBuffer: 12 * 1024 * 1024 })
      const valid = existsSync(item.raw) && validateJsonReport(item.raw, (value) => Array.isArray(value) || Array.isArray(value?.findings))
      if (!valid || (result.exitCode !== 0 && result.exitCode !== 1)) {
        allReportsValid = false
        runs.push({ name: item.name, executed: true, exitCode: result.exitCode, signal: result.signal, reason: valid ? safeProcessFailure(`Gitleaks ${item.name} scan`, result) : 'Gitleaks did not produce a valid JSON report; raw output was withheld.' })
        continue
      }
      const raw = JSON.parse(readFileSync(item.raw, 'utf8'))
      const normalized = normalizeGitleaksJson(raw, { basePath: item.base })
      findings.push(...normalized.map((finding) => ({ ...finding, scan: item.name })))
      const jsonPath = writeJson(join(reportsDir, item.output), normalized)
      const jsonValid = validateJsonReport(jsonPath, (value) => Array.isArray(value) && value.every((finding) => !Object.hasOwn(finding, 'Secret') && !Object.hasOwn(finding, 'Match')))
      if (jsonValid) addReport(reports, jsonPath, 'json', true)
      else allReportsValid = false
      runs.push({ name: item.name, executed: true, exitCode: result.exitCode, signal: result.signal, findingCount: normalized.length, report: relativeToOutput(jsonPath) })
    }
    const requiredCount = historyPrepared ? 2 : 1
    const completedCount = runs.filter((item) => item.executed && (item.exitCode === 0 || item.exitCode === 1) && item.report).length
    const complete = historyPrepared && allReportsValid && completedCount === requiredCount && reports.length === requiredCount
    const reason = complete ? null : (shallow
      ? 'Working-tree scan ran, but Git-history scanning is blocked because the clone is shallow; fetch full history and rerun.'
      : (historyBlockReason || (!historyPrepared ? 'The temporary offline Git-history mirror could not be created; full history is unavailable for this run.' : 'One or both Gitleaks scans failed or lacked a validated report; no all-scope secret gate may pass.')))
    return finishRecord(record, {
      version: tool.version,
      status: complete ? 'COMPLETED' : (shallow || historyBlockReason ? 'BLOCKED' : 'FAILED'),
      startedAt,
      exitCode: runs.filter((item) => item.executed).some((item) => item.exitCode !== 0) ? 1 : 0,
      reason,
      runs,
      findings,
      reports,
      scope: { ...record.scope, workingTreeFiles: materialized.copiedFiles, skippedSymlinks: materialized.skippedSymlinks, excludedGeneratedFiles: materialized.excludedGeneratedFiles, excludedUserDataFiles: context.excludedUserDataFiles ?? 0, ignoredWorktreeFiles: context.ignoredWorktreeFiles ?? 0, workingTreeBytes: materialized.bytes, historyUserDataPathEntryCount: historyUserData.pathEntryCount, historyUserDataContentsRead: false, historyComplete: historyPrepared },
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function runDockerAvailable() {
  const docker = findExecutable('docker')
  if (!docker) {
    const podman = findExecutable('podman')
    return { ok: false, binary: null, reason: podman
      ? 'Podman is installed, but this qualification profile requires Docker Compose v2 for the pinned isolated ZAP stack; no DAST scan was run.'
      : 'Neither Docker nor Podman is installed; the isolated Compose environment and OWASP ZAP scan were not executed.' }
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') return { ok: false, binary: docker, reason: 'The isolated security stack is qualified only on a local linux/amd64 Docker engine; no DAST stack or image scan was executed.' }
  const compose = run(docker, ['compose', 'version'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  if (compose.exitCode !== 0) return { ok: false, binary: docker, reason: 'Docker CLI exists but Docker Compose v2 is unavailable; the isolated DAST stack was not executed.' }
  const selectedContext = run(docker, ['context', 'show'], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  if (selectedContext.exitCode !== 0 || !selectedContext.stdout.trim()) return { ok: false, binary: docker, reason: 'Docker CLI could not identify its selected context; no DAST stack or image scan was executed.' }
  const endpoint = run(docker, ['context', 'inspect', selectedContext.stdout.trim(), '--format', '{{.Endpoints.docker.Host}}'], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  if (endpoint.exitCode !== 0 || !/^unix:\/\/\//.test(endpoint.stdout.trim())) return { ok: false, binary: docker, reason: 'Selected Docker context does not resolve to a local Unix socket; remote Docker engines are refused and no DAST stack or image scan was executed.' }
  const daemon = run(docker, ['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
  if (daemon.exitCode !== 0) return { ok: false, binary: docker, reason: `Local Docker daemon is unavailable (${daemon.errorCode ?? `exit ${daemon.exitCode}`}); no DAST stack or image scan was executed.` }
  return { ok: true, binary: docker, composeVersion: compose.stdout.trim(), localEngine: true, daemonVersion: daemon.stdout.trim() }
}

function assertDastConfig(sourceRoot) {
  const compose = readFileSync(join(sourceRoot, 'security/dast/compose.yaml'), 'utf8')
  const proxy = readFileSync(join(sourceRoot, 'security/dast/Caddyfile'), 'utf8')
  const api = readFileSync(join(sourceRoot, 'security/dast/openapi.yaml'), 'utf8')
  const errors = []
  if (!/^\s+internal:\s+true\s*$/m.test(compose)) errors.push('isolated Docker network must be internal')
  if (/^\s+ports\s*:/m.test(compose)) errors.push('DAST services must not publish host ports')
  if (!compose.includes(LOCK.zap.image)) errors.push('ZAP image must match the pinned version and digest in scanner-versions.json')
  if (!/tmpfs:[\s\S]*?\/var\/lib\/ragam/m.test(compose)) errors.push('test data must use fresh ephemeral tmpfs storage')
  if (!proxy.includes('header_up Host edge:8080')) errors.push('Core must receive the exact isolated local host used for same-origin checks')
  if (!/aliases:\s*\n\s+- edge/.test(compose)) errors.push('The only DAST target alias must resolve to the isolated Web service')
  if (!api.includes('url: http://edge:8080')) errors.push('OpenAPI server must target only the isolated edge alias')
  for (const url of [...api.matchAll(/https?:\/\/[^\s"']+/g)].map((match) => match[0])) {
    if (url !== 'http://edge:8080') errors.push('OpenAPI scope contains a non-local server URL')
  }
  if (errors.length) throw new Error(errors.join('; '))
}

function parseProbeOutput(stdout) {
  const marker = 'RAGAM_DAST_PROBE_JSON='
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(marker))
  if (!line) return null
  try { return JSON.parse(line.slice(marker.length)) } catch { return null }
}

function normalizeProbeReport(raw) {
  if (raw?.schema !== 'ragam-dast-authz-probes/1' || raw?.target !== 'http://edge:8080' || !Array.isArray(raw.probes)) return null
  const seen = new Set()
  const probes = []
  let malformed = false
  for (const item of raw.probes) {
    if (!EXPECTED_PROBE_IDS.includes(item?.id) || seen.has(item.id)) { malformed = true; continue }
    const expected = EXPECTED_PROBES[item.id]
    if (!expected || item.method !== expected.method || item.path !== expected.path
      || item.expectedStatus !== expected.expectedStatus
      || !Number.isInteger(item.actualStatus) || item.actualStatus < 100 || item.actualStatus > 599) {
      malformed = true
      continue
    }
    const expectedAuthenticated = expected.expectedAuthenticated
    const actualAuthenticated = typeof item.actualAuthenticated === 'boolean' ? item.actualAuthenticated : undefined
    const expectedRole = expected.expectedRole
    const actualRole = ['owner', 'member'].includes(item.actualRole) ? item.actualRole : null
    if ((expectedAuthenticated !== undefined && item.expectedAuthenticated !== expectedAuthenticated)
      || (expectedAuthenticated !== undefined && actualAuthenticated === undefined)
      || (expectedRole !== undefined && item.expectedRole !== expectedRole)) malformed = true
    const passed = item.passed === true
      && item.expectedStatus === item.actualStatus
      && (expectedAuthenticated === undefined || expectedAuthenticated === actualAuthenticated)
      && (expectedRole === undefined || expectedRole === actualRole)
    const errorCode = typeof item.actualErrorCode === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(item.actualErrorCode) ? item.actualErrorCode : null
    probes.push({
      id: item.id,
      method: item.method,
      path: item.path,
      expectedStatus: item.expectedStatus,
      actualStatus: item.actualStatus,
      actualErrorCode: errorCode,
      ...(expectedAuthenticated === undefined ? {} : { expectedAuthenticated, actualAuthenticated: actualAuthenticated ?? null }),
      ...(expectedRole === undefined ? {} : { expectedRole, actualRole }),
      passed,
    })
    seen.add(item.id)
  }
  const generatedAt = typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)) ? new Date(raw.generatedAt).toISOString() : null
  const coverageComplete = !malformed && generatedAt !== null && probes.length === EXPECTED_PROBE_IDS.length
    && EXPECTED_PROBE_IDS.every((id) => seen.has(id))
  return {
    schema: 'ragam-dast-authz-probes/1',
    target: 'http://edge:8080',
    generatedAt,
    accounts: 'synthetic in-memory credentials; values and session cookies are not recorded',
    expectedProbeCount: EXPECTED_PROBE_IDS.length,
    observedProbeCount: probes.length,
    coverageComplete,
    probes,
  }
}

function validateNativeZAPHtml(path) {
  try {
    const stats = statSync(path)
    if (stats.size < 64 || stats.size > 64 * 1024 * 1024) return false
    const text = readFileSync(path, 'utf8')
    return /<html[\s>]/i.test(text) && /<\/html>/i.test(text) && /ZAP/i.test(text)
  } catch { return false }
}

async function runZAP({ docker, composeArgs, env, reportsDir, rawReportsDir, timeout = 1_500_000 }) {
  mkdirSync(rawReportsDir, { recursive: true, mode: 0o700 })
  try {
    const versionResult = run(docker, [...composeArgs, 'run', '--rm', '--no-deps', 'zap', 'zap.sh', '-version'], { env, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
    const match = versionOutput.match(/\b(2\.\d+\.\d+)\b/)
    const version = match?.[1] ?? null
    if (versionResult.exitCode !== 0 || version !== LOCK.zap.version) {
      return { ok: false, version, reason: version ? `ZAP container reports version ${version}, expected ${LOCK.zap.version}; scan refused.` : safeProcessFailure('ZAP version check', versionResult), runs: [] }
    }

    const common = [...composeArgs, 'run', '--rm', '--no-deps', 'zap']
    const specs = [
      {
        name: 'web-full-active',
        stem: 'zap-web',
        args: ['zap-full-scan.py', '-I', '-t', 'http://edge:8080', '-m', '5', '-T', '20', '-r', '/zap/wrk/out/zap-web.html', '-J', '/zap/wrk/out/zap-web.json'],
        timeout: 1_500_000,
      },
      {
        name: 'api-active',
        stem: 'zap-api',
        args: ['zap-api-scan.py', '-I', '-t', '/zap/wrk/openapi.yaml', '-f', 'openapi', '-T', '20', '-z', '-config replacer.full_list(0).description=Ragam-local-mutation-marker -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=x-aetheris-request -config replacer.full_list(0).replacement=1', '-r', '/zap/wrk/out/zap-api.html', '-J', '/zap/wrk/out/zap-api.json'],
        timeout: 1_500_000,
      },
    ]
    const runs = []
    const findings = []
    const reports = []
    let complete = true
    for (const spec of specs) {
      const startedAt = now()
      const rawJson = join(rawReportsDir, `${spec.stem}.json`)
      const rawHtml = join(rawReportsDir, `${spec.stem}.html`)
      const jsonPath = join(reportsDir, `${spec.stem}.json`)
      const htmlPath = join(reportsDir, `${spec.stem}.html`)
      const result = run(docker, [...common, ...spec.args], { env, timeout: spec.timeout ?? timeout, maxBuffer: 32 * 1024 * 1024 })
      const nativeReportsExist = existsSync(rawJson) && existsSync(rawHtml)
      const nativeHtmlValid = nativeReportsExist && validateNativeZAPHtml(rawHtml)
      if (!nativeReportsExist || !nativeHtmlValid) {
        complete = false
        runs.push({ name: spec.name, executed: true, startedAt, exitCode: result.exitCode, signal: result.signal, timeout: result.errorCode === 'ETIMEDOUT', nativeJsonProduced: existsSync(rawJson), nativeHtmlProduced: existsSync(rawHtml), nativeHtmlValidated: nativeHtmlValid, reason: 'ZAP did not produce both a valid native JSON and HTML report; raw scanner output was withheld.' })
        continue
      }
      let normalized
      try { normalized = normalizeZapJson(JSON.parse(readFileSync(rawJson, 'utf8'))) } catch {
        complete = false
        runs.push({ name: spec.name, executed: true, startedAt, exitCode: result.exitCode, reason: 'ZAP JSON report was invalid; raw scanner output was withheld.' })
        continue
      }
      const generatedAt = now()
      const items = zapFindings(normalized).map((finding) => ({ ...finding, scan: spec.name }))
      writeJson(jsonPath, { schema: 'ragam-sanitized-zap-report/1', scanner: { name: LOCK.zap.name, version }, generatedAt, ...normalized })
      const safeHtml = sanitizeZapHtml(renderZapHtml({ findings: items, version, generatedAt }))
      writeFileSync(htmlPath, safeHtml, { encoding: 'utf8', mode: 0o600 })
      chmodSync(jsonPath, 0o600)
      chmodSync(htmlPath, 0o600)
      const validJson = validateJsonReport(jsonPath, (value) => value?.schema === 'ragam-sanitized-zap-report/1' && value?.scanner?.version === version && Array.isArray(value?.site))
      const validHtml = validateHtml(htmlPath, 'ZAP')
      if (validJson) addReport(reports, jsonPath, 'json', true)
      if (validHtml) addReport(reports, htmlPath, 'html', true)
      const outcome = zapActiveScanOutcome(result.exitCode, validJson && validHtml)
      if (!outcome.complete) complete = false
      findings.push(...items)
      runs.push({
        name: spec.name,
        executed: true,
        startedAt,
        completedAt: now(),
        exitCode: result.exitCode,
        signal: result.signal,
        timeout: result.errorCode === 'ETIMEDOUT',
        findingCount: items.length,
        activeScan: true,
        scanStatus: outcome.complete ? 'COMPLETED' : 'FAILED',
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        nativeHtmlValidated: true,
        htmlProjection: 'generated from sanitized native JSON; native HTML was discarded without upload',
        reports: [relativeToOutput(jsonPath), relativeToOutput(htmlPath)],
      })
    }
    return { ok: complete && reports.length === specs.length * 2, version, reason: complete ? null : 'One or more ZAP active scan commands returned a nonzero exit, timed out, or lacked valid native JSON/HTML and sanitized reports; sanitized outputs and findings are retained, and DAST cannot pass.', runs, findings, reports }
  } finally {
    // The container writes scanner-native reports into this private directory.
    // It is never part of artifact upload and is removed on success or failure.
    rmSync(rawReportsDir, { recursive: true, force: true })
  }
}

async function runDAST({ context, reportsDir, runDir, project, imageTag, sourceRoot }) {
  const startedAt = now()
  const record = createScannerRecord({
    name: LOCK.zap.name,
    scope: {
      target: 'http://edge:8080',
      targetMode: 'fixed isolated Docker service alias; no target override is accepted',
      image: LOCK.zap.image,
      network: 'security/dast/compose.yaml isolated internal network (no host ports and no external egress)',
      testData: 'fresh tmpfs only; synthetic owner/member accounts and no provider credentials or external destinations',
      web: 'ZAP full scan with passive spider/alerting and controlled active scan; 5-minute spider cap',
      api: 'ZAP OpenAPI active scan of security/dast/openapi.yaml; only local edge server; request marker constrained to the validation-only API operation',
      authz: 'synthetic unauthenticated/owner/member requests verify authentication and owner-only authorization boundaries; ZAP itself is unauthenticated',
      destructiveOperations: 'only against fresh ephemeral test state; no real user data',
      imageDigestVerification: 'runtime Docker Buildx inspection of the official GHCR version tag must match the locked OCI digest before any image pull or scan',
    },
  })
  const configErrors = []
  try { assertDastConfig(sourceRoot) } catch (error) { configErrors.push(error.message) }
  if (configErrors.length) return finishRecord(record, { status: 'FAILED', reason: `DAST isolation configuration refused: ${configErrors.join('; ')}.`, startedAt })
  const docker = runDockerAvailable()
  if (!docker.ok) return finishRecord(record, { status: 'BLOCKED', reason: docker.reason, startedAt, scope: { ...record.scope, imageDigestVerification: { status: 'NOT VERIFIED', reason: 'Docker/Compose is unavailable; official GHCR tag-to-digest comparison was not performed.' } } })

  const digest = verifyZapRegistryDigest(docker.binary)
  const digestRun = { name: 'zap-registry-digest-verification', executed: true, exitCode: digest.ok ? 0 : 1, tag: digest.tag, expectedDigest: digest.expectedDigest, observedDigest: digest.observedDigest ?? null, method: 'docker buildx imagetools inspect against official GHCR tag' }
  if (!digest.ok) {
    const mismatch = Boolean(digest.expectedDigest && digest.observedDigest && digest.expectedDigest !== digest.observedDigest)
    return finishRecord(record, {
      status: mismatch ? 'FAILED' : 'BLOCKED',
      startedAt,
      exitCode: 1,
      reason: digest.reason,
      runs: [digestRun],
      scope: { ...record.scope, imageDigestVerification: { status: mismatch ? 'FAILED' : 'NOT VERIFIED', ...digest } },
    })
  }

  const composeFile = join(sourceRoot, 'security/dast/compose.yaml')
  const composeArgs = ['compose', '-p', project, '-f', composeFile]
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000'
  const gid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000'
  const rawReportsDir = join(runDir, 'private-zap-reports')
  const env = { ...childEnvironment(), RAGAM_DAST_REPORT_DIR: rawReportsDir, RAGAM_DAST_IMAGE_TAG: imageTag, RAGAM_DAST_UID: uid, RAGAM_DAST_GID: gid }
  const configResult = run(docker.binary, [...composeArgs, 'config', '-q'], { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  if (configResult.exitCode !== 0) {
    return finishRecord(record, { status: 'FAILED', reason: 'docker compose config rejected the isolated DAST profile; raw configuration output was withheld.', startedAt, runs: [digestRun, { name: 'compose config', executed: true, exitCode: configResult.exitCode }] })
  }

  let stackStarted = false
  const runs = [digestRun]
  let findings = []
  const reports = []
  let zapComplete = false
  let stackStopSucceeded = true
  let zapVersion = null
  try {
    stackStarted = true
    const up = run(docker.binary, [...composeArgs, 'up', '--build', '--detach', 'core', 'web'], { env, timeout: 1_200_000, maxBuffer: 24 * 1024 * 1024 })
    runs.push({ name: 'isolated-stack-start', executed: true, exitCode: up.exitCode, signal: up.signal })
    if (up.exitCode !== 0) {
      return finishRecord(record, { status: 'FAILED', startedAt, exitCode: up.exitCode, reason: safeProcessFailure('Isolated DAST Compose stack startup', up), runs, scope: record.scope })
    }

    const readyDeadline = Date.now() + 180_000
    let ready = false
    while (Date.now() < readyDeadline) {
      const health = run(docker.binary, [...composeArgs, 'exec', '--no-TTY', 'web', 'wget', '-q', '--spider', 'http://127.0.0.1:8080/healthz'], { env, timeout: 15_000, maxBuffer: 1024 * 1024 })
      if (health.exitCode === 0) { ready = true; break }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 3000))
    }
    runs.push({ name: 'isolated-stack-health', executed: true, exitCode: ready ? 0 : 1 })
    if (!ready) {
      return finishRecord(record, { status: 'FAILED', startedAt, exitCode: 1, reason: 'Isolated web/API edge did not become healthy within 180 seconds; scans were not started.', runs, scope: record.scope })
    }

    const probe = run(docker.binary, [...composeArgs, 'run', '--rm', '--no-deps', '--no-TTY', 'probe'], { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
    const probeRaw = parseProbeOutput(probe.stdout)
    const probeValue = probeRaw ? normalizeProbeReport(probeRaw) : null
    let probeReportValidated = false
    if (probeValue) {
      const probePath = writeJson(join(reportsDir, 'dast-authz-probes.json'), probeValue)
      probeReportValidated = validateJsonReport(probePath, (value) => value?.schema === 'ragam-dast-authz-probes/1'
        && value?.target === 'http://edge:8080'
        && value?.coverageComplete === true
        && value?.expectedProbeCount === EXPECTED_PROBE_IDS.length
        && value?.probes?.length === EXPECTED_PROBE_IDS.length)
      if (probeReportValidated) addReport(reports, probePath, 'json', true)
      for (const item of probeValue.probes) {
        if (item.passed !== true) findings.push({
          id: `authz-${item.id}`,
          ruleId: 'ragam.authz.boundary',
          title: 'Local authentication/authorization boundary probe did not meet its expected result',
          url: `http://edge:8080${item.path}`,
          method: item.method,
          severity: 'HIGH',
          reviewState: 'UNREVIEWED',
          expectedStatus: item.expectedStatus,
          actualStatus: item.actualStatus,
          actualErrorCode: item.actualErrorCode,
          ...(item.expectedAuthenticated === undefined ? {} : { expectedAuthenticated: item.expectedAuthenticated, actualAuthenticated: item.actualAuthenticated }),
          ...(item.expectedRole === undefined ? {} : { expectedRole: item.expectedRole, actualRole: item.actualRole }),
        })
      }
    }
    const failedProbeCount = probeValue?.probes?.filter((item) => item.passed !== true).length ?? null
    const authzComplete = probe.exitCode === 0
      && probeValue?.coverageComplete === true
      && failedProbeCount === 0
      && probeReportValidated
    runs.push({
      name: 'authz-boundary-probes',
      executed: true,
      exitCode: probe.exitCode,
      status: authzComplete ? 'COMPLETED' : 'FAILED',
      probeCount: probeValue?.probes?.length ?? 0,
      expectedProbeCount: EXPECTED_PROBE_IDS.length,
      coverageComplete: probeValue?.coverageComplete ?? false,
      failedProbeCount,
      reportValidated: probeReportValidated,
      report: probeValue ? relativeToOutput(join(reportsDir, 'dast-authz-probes.json')) : null,
      ...(!probeValue ? { reason: 'Probe container did not return the expected sanitized structured result; raw output was withheld.' } : {}),
    })

    const zap = await runZAP({ docker: docker.binary, composeArgs, env, reportsDir, rawReportsDir })
    zapVersion = zap.version
    runs.push(...zap.runs)
    findings.push(...zap.findings)
    reports.push(...zap.reports)
    zapComplete = zap.ok
  } finally {
    if (stackStarted) {
      const down = run(docker.binary, [...composeArgs, 'down'], { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
      runs.push({ name: 'isolated-stack-stop', executed: true, exitCode: down.exitCode, volumesRemoved: false })
      if (down.exitCode !== 0) {
        stackStopSucceeded = false
        runs.push({ name: 'isolated-stack-stop-diagnostic', executed: false, reason: `Project-scoped docker compose down failed (exit ${down.exitCode}); no volume deletion was requested.` })
      }
    }
  }

  const dastComplete = zapComplete && stackStopSucceeded
  return finishRecord(record, {
    version: zapVersion,
    status: dastComplete ? 'COMPLETED' : 'FAILED',
    startedAt,
    exitCode: dastComplete ? 0 : 1,
    reason: dastComplete ? null : (stackStopSucceeded
      ? 'One or more ZAP active scans failed or lacked validated sanitized reports; DAST qualification is incomplete.'
      : 'Project-scoped Compose shutdown failed after DAST; the isolated service cleanup gate failed.'),
    runs,
    findings,
    reports,
    scope: { ...record.scope, image: LOCK.zap.image, imageDigestVerification: { status: 'VERIFIED', tag: digest.tag, digest: digest.observedDigest, verifiedAt: digest.verifiedAt, method: digest.method }, project, imageTag, sourceCommit: context.commit, target: 'http://edge:8080' },
  })
}

async function runTrivyOne({ binary, version, args, rawJson, jsonPath, sarifPath, reports, label, basePath = ROOT }) {
  const startedAt = now()
  const result = run(binary, args('json', rawJson), { timeout: 1_200_000, maxBuffer: 24 * 1024 * 1024 })
  const runRecord = {
    name: label,
    executed: true,
    startedAt,
    completedAt: now(),
    exitCode: result.exitCode,
    signal: result.signal,
    timeout: result.errorCode === 'ETIMEDOUT',
  }
  try {
    if (!existsSync(rawJson)) {
      return { ok: false, run: { ...runRecord, reason: 'Trivy did not produce a native JSON output; raw scanner output was withheld.' }, findings: [] }
    }
    const normalized = normalizeTrivyJson(JSON.parse(readFileSync(rawJson, 'utf8')), { basePath })
    const findings = trivyFindings(normalized)
    const reportJson = {
      schema: 'ragam-sanitized-trivy-report/1',
      scanner: { name: LOCK.trivy.name, version },
      generatedAt: now(),
      ...normalized,
    }
    writeJson(jsonPath, reportJson)
    // Build a minimal, standards-compliant SARIF projection from this exact native
    // JSON scan so both artifacts describe one timestamp/database snapshot.
    const sarif = sanitizeSarif(null, { toolName: LOCK.trivy.name, version, findings })
    writeJson(sarifPath, sarif)
    const validJson = validateJsonReport(jsonPath, (value) => value?.scanner?.version === version && Array.isArray(value?.Results))
    const validSarif = validateSarif(sarifPath)
    if (validJson) addReport(reports, jsonPath, 'json', true)
    if (validSarif) addReport(reports, sarifPath, 'sarif', true)
    const commandOk = result.exitCode === 0
    return {
      ok: validJson && validSarif && commandOk,
      run: {
        ...runRecord,
        findingCount: findings.length,
        reports: [relativeToOutput(jsonPath), relativeToOutput(sarifPath)],
        sarifDerivedFrom: 'validated native Trivy JSON from this exact scan; source snippets and secret values omitted',
        reason: commandOk ? null : safeProcessFailure(`Trivy ${label} scan`, result),
      },
      findings,
    }
  } catch {
    return { ok: false, run: { ...runRecord, reason: 'Trivy JSON could not be parsed or sanitized; raw output was withheld.' }, findings: [] }
  } finally {
    rmSync(rawJson, { force: true })
  }
}

async function runDependencies({ context, reportsDir, runDir, project, imageTag, sourceRoot }) {
  const startedAt = now()
  const record = createScannerRecord({
    name: LOCK.trivy.name,
    scope: {
      filesystem: 'repository manifests and lockfiles with vulnerability, misconfiguration and secret scanners; generated caches excluded explicitly',
      configuration: 'repository Dockerfiles, Docker Compose, supported YAML/configuration and infrastructure sources',
      containers: [
        `ragam/security-core:${imageTag}`,
        `ragam/security-web:${imageTag} (Caddy static web + isolated API edge)`,
      ],
      packageUpgradePolicy: 'scan only; no dependency changes or automatic upgrades',
      ignorePolicy: 'empty temporary Trivy ignore file; repository suppressions are not applied',
      severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'],
    },
  })
  const docker = runDockerAvailable()
  const tool = ensureTrivy({ runDir })
  if (!tool.ok) return finishRecord(record, {
    status: 'BLOCKED',
    reason: tool.reason,
    startedAt,
    scope: {
      ...record.scope,
      containerPrerequisite: docker.ok ? 'AVAILABLE' : 'UNAVAILABLE',
      containerPrerequisiteReason: docker.ok ? null : docker.reason,
      containerImageScans: 'NOT EXECUTED; the pinned Trivy scanner was unavailable.',
    },
  })

  const reports = []
  const findings = []
  const runs = []
  let complete = true
  let blockedReason = null
  const rawDir = mkdtempSync(join(tmpdir(), 'ragam-trivy-'))
  const cacheDir = join(runDir, 'trivy-cache')
  const emptyIgnore = join(rawDir, 'empty.trivyignore')
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  writeFileSync(emptyIgnore, '', { mode: 0o600 })
  const skipDirs = ['.git', 'build', 'node_modules', '.venv', 'venv', 'dist', 'coverage', '.next', '.vite', '.pytest_cache', '__pycache__']
  const severity = 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL'
  const common = [
    '--quiet', '--cache-dir', cacheDir, '--ignorefile', emptyIgnore,
    '--severity', severity, '--timeout', '15m',
  ]
  const scan = async ({ label, stem, baseArgs }) => {
    const rawJson = join(rawDir, `${stem}.raw.json`)
    const jsonPath = join(reportsDir, `${stem}.json`)
    const sarifPath = join(reportsDir, `${stem}.sarif`)
    const result = await runTrivyOne({
      binary: tool.path,
      version: tool.version,
      label,
      rawJson,
      jsonPath,
      sarifPath,
      reports,
      basePath: sourceRoot,
      args: (format, output) => [...baseArgs, ...common, '--format', format, '--output', output],
    })
    runs.push(result.run)
    findings.push(...result.findings)
    if (!result.ok) complete = false
  }
  try {
    await scan({
      label: 'repository-dependencies-lockfiles-secrets-misconfigurations',
      stem: 'trivy-filesystem',
      baseArgs: [
        'fs', '--scanners', 'vuln,misconfig,secret', '--include-dev-deps',
        '--file-patterns', TRIVY_PIP_REQUIREMENTS_LOCK_PATTERN,
        ...skipDirs.flatMap((path) => ['--skip-dirs', path]),
        sourceRoot,
      ],
    })
    await scan({
      label: 'repository-infrastructure-and-configuration',
      stem: 'trivy-configuration',
      baseArgs: [
        'config', '--scanners', 'misconfig',
        ...skipDirs.flatMap((path) => ['--skip-dirs', path]),
        sourceRoot,
      ],
    })

    if (!docker.ok) {
      complete = false
      blockedReason = `Container-image scans were not executed: ${docker.reason}`
      runs.push({ name: 'container-image-build-and-scan', executed: false, reason: blockedReason })
    } else {
      const composeFile = join(sourceRoot, 'security/dast/compose.yaml')
      const composeArgs = ['compose', '-p', project, '-f', composeFile]
      const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '1000'
      const gid = typeof process.getgid === 'function' ? String(process.getgid()) : '1000'
      const env = {
        ...childEnvironment(),
        RAGAM_DAST_REPORT_DIR: reportsDir,
        RAGAM_DAST_IMAGE_TAG: imageTag,
        RAGAM_DAST_UID: uid,
        RAGAM_DAST_GID: gid,
      }
      const config = run(docker.binary, [...composeArgs, 'config', '-q'], { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
      if (config.exitCode !== 0) {
        complete = false
        blockedReason = 'docker compose config rejected the isolated local image build profile; raw configuration output was withheld.'
        runs.push({ name: 'container-compose-config', executed: true, exitCode: config.exitCode, reason: blockedReason })
      } else {
        const buildStartedAt = now()
        const built = run(docker.binary, [...composeArgs, 'build', 'core', 'web'], { env, timeout: 1_500_000, maxBuffer: 24 * 1024 * 1024 })
        runs.push({ name: 'container-image-build', executed: true, startedAt: buildStartedAt, completedAt: now(), exitCode: built.exitCode, signal: built.signal })
        if (built.exitCode !== 0) {
          complete = false
          blockedReason = safeProcessFailure('Isolated Core/Web container-image build', built)
        } else {
          const imageSpecs = [
            { name: 'core', image: `ragam/security-core:${imageTag}`, stem: 'trivy-container-core' },
            { name: 'web', image: `ragam/security-web:${imageTag}`, stem: 'trivy-container-web' },
          ]
          for (const item of imageSpecs) {
            await scan({
              label: `container-image-${item.name}-vulnerabilities-and-secrets`,
              stem: item.stem,
              baseArgs: ['image', '--image-src', 'docker', '--scanners', 'vuln,secret', item.image],
            })
          }
        }
      }
    }
  } finally {
    rmSync(rawDir, { recursive: true, force: true })
  }

  const reason = complete ? null : (blockedReason || 'One or more Trivy filesystem, configuration, or container-image scans failed or lacked validated native JSON and sanitized SARIF reports; dependency qualification is incomplete.')
  return finishRecord(record, {
    version: tool.version,
    status: complete ? 'COMPLETED' : (blockedReason ? 'BLOCKED' : 'FAILED'),
    startedAt,
    exitCode: complete ? 0 : 1,
    reason,
    runs,
    findings,
    reports,
    scope: {
      ...record.scope,
      sourceCommit: context.commit,
      imageTag,
      noAutomaticUpgrades: true,
      skippedGeneratedDirectories: skipDirs,
      containerPrerequisite: docker.ok ? 'AVAILABLE' : 'UNAVAILABLE',
      containerPrerequisiteReason: docker.ok ? null : docker.reason,
      docker: runs.find((item) => item.name === 'container-image-build')?.exitCode === 0 ? 'Core and Web/Caddy images built and scanned from local Docker daemon' : 'image coverage unavailable or incomplete; see exact run reason',
    },
  })
}

function verifyZapRegistryDigest(docker) {
  const expected = String(LOCK.zap.image ?? '').match(/@(sha256:[a-f0-9]{64})$/i)?.[1]?.toLowerCase() ?? null
  const tag = `ghcr.io/zaproxy/zaproxy:${LOCK.zap.version}`
  if (!expected) return { ok: false, tag, expectedDigest: null, observedDigest: null, reason: 'OWASP ZAP lock entry has no valid immutable SHA-256 OCI digest; pull and scan refused.' }
  const checked = run(docker, ['buildx', 'imagetools', 'inspect', tag], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  const match = checked.stdout.match(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/im)
  const observed = match?.[1]?.toLowerCase() ?? null
  if (checked.exitCode !== 0 || !observed) {
    return {
      ok: false, tag, expectedDigest: expected, observedDigest: observed,
      reason: checked.errorCode === 'ENOENT'
        ? 'Docker Buildx imagetools is required to verify the official GHCR ZAP version tag against its pinned digest; no ZAP image was pulled or scan executed.'
        : `Could not independently read the official GHCR ${LOCK.zap.version} tag digest with Docker Buildx (exit ${checked.exitCode ?? checked.errorCode ?? 'unknown'}); no ZAP scan was executed.`,
    }
  }
  if (observed !== expected) {
    return {
      ok: false, tag, expectedDigest: expected, observedDigest: observed,
      reason: `Official GHCR tag ${tag} resolves to ${observed}, which does not match the pinned ${expected}; no ZAP image was pulled or scan executed. Review and update the pin from the official registry.`,
    }
  }
  return { ok: true, tag, expectedDigest: expected, observedDigest: observed, verifiedAt: now(), method: 'docker buildx imagetools inspect against the official GHCR tag' }
}

const GATES_FOR_SCANNER = Object.freeze({
  sast: ['sast', 'findingReview'],
  dast: ['dast', 'authz'],
  secrets: ['secrets'],
  dependencies: ['dependencies'],
})

function gateKeysForRequestedScanners(requested) {
  const selected = new Set(['checksums', 'sourceIntegrity'])
  for (const scanner of requested) for (const gate of GATES_FOR_SCANNER[scanner] ?? []) selected.add(gate)
  return GATE_KEYS.filter((key) => selected.has(key))
}

function evidenceForMode(mode, requested, context, scans, gates, hashVerification, { runDir, reportsDir, startedAt, completedAt, project, imageTag, runnerExitCode }) {
  const allPassed = GATE_KEYS.every((key) => gates[key]?.status === 'PASS')
  const relevantGateKeys = gateKeysForRequestedScanners(requested)
  const requestedPassed = relevantGateKeys.every((key) => gates[key]?.status === 'PASS')
  const relevantStatuses = relevantGateKeys.map((key) => gates[key]?.status)
  const runStatus = requestedPassed ? 'PASS' : (relevantStatuses.includes('FAIL') ? 'FAIL' : 'BLOCKED')
  const allReports = Object.values(scans).flatMap((scan) => scan.reports ?? [])
  return {
    schema: OSS_SECURITY_SCHEMA,
    title: 'Ragam OSS security qualification evidence',
    generatedAt: completedAt,
    run: {
      id: context.runId,
      mode,
      command: mode === 'full' ? 'npm run release:security:full' : `npm run release:${mode}`,
      startedAt,
      completedAt,
      exitCode: runnerExitCode,
      status: runStatus,
      evaluatedGates: relevantGateKeys.map((key) => gates[key].id),
      project,
      imageTag,
      outputRoot: OUTPUT_ROOT,
      reportsDirectory: relativeToOutput(reportsDir),
      runDirectory: relativeToOutput(runDir),
    },
    source: {
      repository: 'rajaram-2005/ragam',
      branch: context.branch,
      commit: context.commit,
      tree: context.tree,
      snapshot: context.sourceSnapshot ?? { status: 'NOT CREATED', exact: false },
      workingTree: {
        clean: context.clean,
        statusAvailable: context.statusAvailable,
        identityAvailable: context.identityAvailable,
        stableDuringRun: context.workingTreeStable,
        sha256: context.workingTreeSha256,
        sha256AfterScan: context.afterScan?.workingTreeSha256 ?? null,
        untrackedFiles: context.untrackedFiles,
        untrackedBytes: context.untrackedBytes,
        ignoredWorktreeFiles: context.ignoredWorktreeFiles,
        ignoredWorktreeBytes: context.ignoredWorktreeBytes,
        excludedGeneratedFiles: context.excludedGeneratedFiles,
        excludedUserDataFiles: context.excludedUserDataFiles,
        scannedContent: 'exact HEAD commit or isolated working-tree snapshot; non-generated in-scope untracked/ignored sources are fingerprinted, while verified generated outputs and the local user-data store are counted and excluded; qualification requires a clean, stable exact commit',
      },
    },
    policy: {
      paidServices: false,
      externalCodeUploads: false,
      semgrepRegistryAccess: false,
      productionTargetsScanned: false,
      thirdPartyTargetsScanned: false,
      destructiveTestsAgainstRealData: false,
      dependencyUpgradesPerformed: false,
      secretsPolicy: 'secret values, source snippets, request/response bodies and raw scanner logs are never emitted to CI logs or sanitized evidence; findings identify locations and remediation only',
      highSeverityPolicy: 'unreviewed HIGH/CRITICAL findings block their independent gate; findings are retained and never silently suppressed',
    },
    scanners: scans,
    releaseGates: GATE_KEYS.map((key) => gates[key]),
    reportHashVerification: {
      method: hashVerification.method,
      verified: hashVerification.verified,
      count: hashVerification.count,
      byScanner: hashVerification.byScanner,
      byArtifact: hashVerification.byArtifact,
      reason: hashVerification.reason,
    },
    reports: allReports.map(({ path, format, bytes, sha256: digest, validated, sanitized }) => ({ path, format, bytes, sha256: digest, validated, sanitized })),
    qualification: {
      ossSecurity: {
        status: allPassed ? 'PASS' : 'NOT QUALIFIED',
        requiredIndependentGates: GATE_KEYS.map((key) => gates[key].id),
        passedGates: GATE_KEYS.filter((key) => gates[key].status === 'PASS').map((key) => gates[key].id),
        failedGates: GATE_KEYS.filter((key) => gates[key].status === 'FAIL').map((key) => gates[key].id),
        blockedGates: GATE_KEYS.filter((key) => gates[key].status === 'BLOCKED').map((key) => gates[key].id),
        notTestedGates: GATE_KEYS.filter((key) => gates[key].status === 'NOT TESTED').map((key) => gates[key].id),
        reason: allPassed ? 'All eight independent OSS gates passed on validated, clean-commit evidence.' : 'At least one required independent OSS gate failed, is blocked by a prerequisite, or was not tested.',
      },
      commercialPenetrationTesting: {
        status: 'NOT TESTED',
        path: '.github/workflows/release.yml and scripts/release/commercial-sast-dast.mjs (separate optional commercial workflow)',
        reason: 'This OSS qualification run does not execute or substitute for the commercial penetration-test workflow; its status is preserved independently.',
      },
      liveProductionQualification: {
        status: 'NOT TESTED',
        reason: 'Only repository code and an isolated ephemeral local test environment are in scope; no production deployment, live provider, third-party domain or model service was scanned.',
      },
    },
  }
}

function unavailableRecord(key, error) {
  const startedAt = now()
  const record = createScannerRecord({ name: key })
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : ''
  return finishRecord(record, {
    status: 'FAILED',
    startedAt,
    exitCode: 1,
    reason: `The ${key} runner encountered an internal failure${code}; raw exception details were withheld.`,
  })
}

async function runOpenSourceSecurity(mode) {
  const startedAt = now()
  const context = { ...getSourceIdentity(), runId: randomUUID() }
  context.branch = gitValue(['branch', '--show-current'])?.trim() || null
  const requested = mode === 'full' ? [...SCANNER_KEYS] : [mode]
  const { runDir, reportsDir, evidencePath } = makeRunDirectory(context)
  const snapshot = createScanSnapshot(context, runDir)
  const sourceRoot = snapshot.ok ? snapshot.path : null
  context.sourceSnapshot = {
    status: snapshot.ok ? 'READY' : 'BLOCKED',
    path: snapshot.ok ? relativeToOutput(snapshot.path) : null,
    manifest: existsSync(join(runDir, 'source-snapshot.json')) ? relativeToOutput(join(runDir, 'source-snapshot.json')) : null,
    inventoryManifest: snapshot.inventoryManifest ?? null,
    inventoryManifestSha256: snapshot.inventoryManifestSha256 ?? null,
    inventoryEntryCount: snapshot.inventoryEntryCount ?? null,
    mode: snapshot.mode ?? null,
    exact: snapshot.exact === true,
    baseCommit: snapshot.baseCommit ?? context.commit,
    baseTree: snapshot.baseTree ?? context.tree,
    workingTreeSha256: snapshot.workingTreeSha256 ?? context.workingTreeSha256,
    snapshotSha256: snapshot.snapshotSha256 ?? null,
    fileCount: snapshot.files ?? null,
    byteCount: snapshot.bytes ?? null,
    symlinkCount: snapshot.symlinks ?? null,
    excludedGeneratedEntries: snapshot.excludedGeneratedEntries ?? null,
    excludedUserDataEntries: snapshot.excludedUserDataEntries ?? null,
    stableDuringRun: null,
    cleanupSucceeded: null,
    reason: snapshot.ok ? null : snapshot.reason,
  }
  const project = `ragam-oss-${context.runId.slice(0, 8)}`
  const imageTag = `${context.commit?.slice(0, 12) ?? 'unknown'}-${context.runId.slice(0, 8)}`
  const scanners = {
    sast: createScannerRecord({ name: LOCK.semgrep.name, status: 'NOT_RUN' }),
    dast: createScannerRecord({ name: LOCK.zap.name, status: 'NOT_RUN' }),
    secrets: createScannerRecord({ name: LOCK.gitleaks.name, status: 'NOT_RUN' }),
    dependencies: createScannerRecord({ name: LOCK.trivy.name, status: 'NOT_RUN' }),
  }
  const functionsByKey = {
    sast: () => runSemgrep({ context, reportsDir, runDir, sourceRoot }),
    secrets: () => runGitleaks({ context, reportsDir, runDir, sourceRoot }),
    dependencies: () => runDependencies({ context, reportsDir, runDir, project, imageTag, sourceRoot }),
    dast: () => runDAST({ context, reportsDir, runDir, project, imageTag, sourceRoot }),
  }
  for (const key of requested) {
    if (!snapshot.ok) {
      scanners[key] = finishRecord(createScannerRecord({ name: scanners[key].name }), {
        status: 'BLOCKED', startedAt: now(), reason: snapshot.reason ?? 'An exact source snapshot could not be prepared; no scanner was run.',
      })
      continue
    }
    try { scanners[key] = await functionsByKey[key]() }
    catch (error) { scanners[key] = unavailableRecord(key, error) }
  }
  const snapshotStable = snapshot.ok && snapshotStillMatches(snapshot)
  context.sourceSnapshot.stableDuringRun = snapshotStable
  snapshot.stableDuringRun = snapshotStable
  let snapshotCleanupSucceeded = false
  if (snapshot.ok) {
    try { snapshotCleanupSucceeded = cleanupScanSnapshot(snapshot) } catch { snapshotCleanupSucceeded = false }
  }
  context.sourceSnapshot.cleanupSucceeded = snapshotCleanupSucceeded

  const afterScan = getSourceIdentity()
  context.afterScan = afterScan
  context.workingTreeStable = Boolean(
    context.identityAvailable && afterScan.identityAvailable
    && context.commit === afterScan.commit
    && context.tree === afterScan.tree
    && context.workingTreeSha256 === afterScan.workingTreeSha256,
  )
  context.sourceIntegrityStable = Boolean(context.workingTreeStable && snapshotStable && snapshotCleanupSucceeded)
  context.clean = Boolean(context.clean && afterScan.clean && context.sourceIntegrityStable)
  context.statusAvailable = Boolean(context.statusAvailable && afterScan.statusAvailable)
  for (const key of requested) {
    scanners[key].source = {
      commit: context.commit,
      tree: context.tree,
      workingTreeSha256: context.workingTreeSha256,
      clean: context.clean,
      stableDuringRun: context.workingTreeStable,
    }
  }
  const hashVerification = verifyReportHashes(Object.fromEntries(requested.map((key) => [key, scanners[key]])), { runDir })
  const sourceDefs = {
    sast: { key: 'sast', name: 'Semgrep Community Edition static analysis', command: 'npm run release:sast', version: scanners.sast.version },
    dast: { key: 'dast', name: 'OWASP ZAP isolated dynamic application security testing', command: 'npm run release:dast', version: scanners.dast.version },
    secrets: { key: 'secrets', name: 'Gitleaks working-tree and Git-history secret scanning', command: 'npm run release:secrets', version: scanners.secrets.version },
    dependencies: { key: 'dependencies', name: 'Trivy dependency, container and infrastructure scanning', command: 'npm run release:dependencies', version: scanners.dependencies.version },
  }
  const gates = {}
  for (const key of SCANNER_KEYS) {
    if (!requested.includes(key)) {
      gates[key] = initialGate(GATE_IDS[key], sourceDefs[key].name, false, mode)
      continue
    }
    const activeScanPerformed = key === 'dast'
      && ['web-full-active', 'api-active'].every((name) => scanners.dast.execution.runs.some((item) => item.name === name && item.executed === true && item.activeScan === true))
    const scannerFindings = key === 'dast'
      ? scanners.dast.findings.filter((finding) => finding.ruleId !== 'ragam.authz.boundary')
      : scanners[key].findings
    gates[key] = updateGate(scanners[key], {
      id: GATE_IDS[key],
      name: sourceDefs[key].name,
      source: sourceDefs[key],
      hashVerification,
      context,
      evidencePath,
      findings: scannerFindings,
      activeScanRequired: key === 'dast',
      activeScanPerformed,
      blockOnAnyFinding: key === 'secrets',
    })
  }
  gates.findingReview = findingReviewGate({ requested, mode, record: scanners.sast, evidencePath })
  gates.authz = authzGate({ requested, mode, record: scanners.dast, hashVerification })
  gates.checksums = checksumGate({ requested, mode, scans: scanners, hashVerification })
  gates.sourceIntegrity = sourceIntegrityGate({ context, hashVerification })

  const completedAt = now()
  const relevantGateKeys = gateKeysForRequestedScanners(requested)
  const requestedPassed = relevantGateKeys.every((key) => gates[key].status === 'PASS')
  const evidence = evidenceForMode(mode, requested, context, scanners, gates, hashVerification, {
    runDir, reportsDir, startedAt, completedAt, project, imageTag, runnerExitCode: requestedPassed ? 0 : 1,
  })
  writeEvidence(evidencePath, evidence)
  for (const key of requested) {
    const scan = scanners[key]
    const gate = gates[key]
    const summary = scan.findingSummary?.total ?? 0
    console.log(`${GATE_IDS[key]}: ${gate.status}; scanner=${scan.version ?? 'unavailable'}; findings=${summary}; reports=${scan.reports?.length ?? 0}`)
    if (scan.execution.reason) console.log(`  reason: ${scan.execution.reason}`)
  }
  for (const key of relevantGateKeys.filter((item) => !SCANNER_KEYS.includes(item))) {
    console.log(`${GATE_IDS[key]}: ${gates[key].status}`)
    if (gates[key].reason) console.log(`  reason: ${gates[key].reason}`)
  }
  console.log(`OSS security qualification: ${evidence.qualification.ossSecurity.status}`)
  console.log(`Evidence: ${relativeToOutput(evidencePath)}`)
  process.exitCode = requestedPassed ? 0 : 1
  return evidence
}

function usage() {
  return [
    'Usage: node scripts/release/open-source-security.mjs <sast|dast|secrets|dependencies|full>',
    'The DAST target is fixed to the isolated internal Compose service; no target URL option is supported.',
    'Set RAGAM_SECURITY_NO_DOWNLOAD=1 to refuse pinned scanner downloads and report the exact unavailable reason.',
  ].join('\n')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage())
  } else if (args.length !== 1 || !MODES.has(args[0])) {
    console.error(usage())
    process.exitCode = 2
  } else {
    await runOpenSourceSecurity(args[0])
  }
}
