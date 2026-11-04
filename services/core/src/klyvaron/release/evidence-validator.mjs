import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { canonicalProvenanceSha256 } from '../provenance.mjs'
import { verifyPinnedLocalFiles } from '../local-provenance.mjs'
import {
  KLYVARON_PRODUCTION_EVIDENCE_FILES,
  KLYVARON_PRODUCTION_SIGNATURES,
  klyvaronEvidenceManifestBody,
  klyvaronProductionModelId,
  isKlyvaronProductionVersion,
  validateKlyvaronProductionEvidenceDocuments,
} from './evidence-schema.mjs'
import { verifyKlyvaronProductionEvidenceSignatures } from './signature-verifier.mjs'

const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/i
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function safeReason(error) {
  if (error?.code === 'ENOENT') return 'required path is missing'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'required path cannot be read'
  if (error?.code === 'ELOOP') return 'symbolic links are not accepted'
  if (error?.code === 'ENOTDIR') return 'path component is not a directory'
  return 'evidence filesystem verification failed'
}

async function safeRead(filePath, maxBytes = MAX_EVIDENCE_FILE_BYTES) {
  let info
  try { info = await lstat(filePath, { bigint: true }) } catch (error) { throw new Error(safeReason(error)) }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('evidence files must be regular non-symlink files')
  if (info.size <= 0n || info.size > BigInt(maxBytes)) throw new Error('evidence file is empty or exceeds the size limit')
  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle
  try { handle = await open(filePath, constants.O_RDONLY | noFollow) } catch (error) { throw new Error(safeReason(error)) }
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== info.size) throw new Error('evidence file changed while being opened')
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== after.size) {
      throw new Error('evidence file changed while being read')
    }
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  } finally { await handle.close() }
}

async function listExactPackageDirectory(directory, requiredNames) {
  let names
  try { names = await readdir(directory) } catch (error) { throw new Error(safeReason(error)) }
  const missing = requiredNames.filter((name) => !names.includes(name))
  const unexpected = names.filter((name) => !requiredNames.includes(name))
  if (missing.length || unexpected.length) {
    throw new Error(`directory must contain exactly the required files (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`)
  }
}

function parseJson(text, filename) {
  try {
    const value = JSON.parse(text)
    if (!isRecord(value)) throw new Error('not an object')
    return value
  } catch { throw new Error(`${filename} is not valid JSON object data`) }
}

function invalid(blockers, details = {}) {
  return {
    schema: 'klyvaron.production-evidence-validation.v1',
    status: 'blocked', passed: false, blockers: [...new Set(blockers)],
    tier: details.tier ?? null, version: details.version ?? null, modelId: details.modelId ?? null,
    modelRevisionSha256: details.modelRevisionSha256 ?? null, artifactSha256: details.artifactSha256 ?? null,
    evidenceManifestSha256: details.evidenceManifestSha256 ?? null,
    signatures: details.signatures ?? [], artifactVerification: details.artifactVerification ?? null,
    package: null,
  }
}

/**
 * Validate one complete, immutable, signed production package and hash the real artifact
 * bytes under artifactRoot. This function never promotes or edits evidence. Weights stay in
 * the external artifact store; only reports, hashes and signature metadata are returned.
 */
export async function validateKlyvaronProductionEvidencePackage({
  tier, version, packageDir, artifactRoot, trustStore, now = new Date(),
} = {}) {
  const blockers = []
  if (!klyvaronProductionModelId(tier) || !isKlyvaronProductionVersion(version)) {
    return invalid(['canonical tier and semantic version are required'], { tier, version })
  }
  if (typeof packageDir !== 'string' || !packageDir || typeof artifactRoot !== 'string' || !artifactRoot) {
    return invalid(['package directory and real artifact root are mandatory'], { tier, version, modelId: klyvaronProductionModelId(tier) })
  }
  const root = resolve(packageDir)
  let rootInfo
  try { rootInfo = await lstat(root, { bigint: true }) } catch (error) {
    return invalid([`package directory: ${safeReason(error)}`], { tier, version, modelId: klyvaronProductionModelId(tier) })
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return invalid(['package path must be a real directory, not a symbolic link'], { tier, version })
  if (basename(root) !== `v${version}`) blockers.push(`package directory must be named v${version}`)

  const signatureDir = join(root, 'signatures')
  try {
    const signatureDirInfo = await lstat(signatureDir, { bigint: true })
    if (signatureDirInfo.isSymbolicLink() || !signatureDirInfo.isDirectory()) blockers.push('signatures must be a real directory, not a symbolic link')
    await listExactPackageDirectory(root, [...KLYVARON_PRODUCTION_EVIDENCE_FILES, 'signatures'])
    await listExactPackageDirectory(signatureDir, ['evidence-manifest.json', ...Object.values(KLYVARON_PRODUCTION_SIGNATURES).map((item) => item.file)])
  } catch (error) { blockers.push(error.message) }
  if (blockers.length) return invalid(blockers, { tier, version, modelId: klyvaronProductionModelId(tier) })

  const rawFiles = {}
  const documents = {}
  for (const filename of KLYVARON_PRODUCTION_EVIDENCE_FILES) {
    try {
      const loaded = await safeRead(join(root, filename), filename === 'artifact-checksums.sha256' ? 8 * 1024 * 1024 : MAX_EVIDENCE_FILE_BYTES)
      rawFiles[filename] = loaded
      if (filename === 'artifact-checksums.sha256') documents[filename] = loaded.bytes.toString('utf8')
      else documents[filename] = parseJson(loaded.bytes.toString('utf8'), filename)
    } catch (error) { blockers.push(`${filename}: ${error.message}`) }
  }
  let manifest
  const signatures = {}
  try {
    const loaded = await safeRead(join(signatureDir, 'evidence-manifest.json'))
    manifest = parseJson(loaded.bytes.toString('utf8'), 'evidence-manifest.json')
  } catch (error) { blockers.push(`evidence manifest: ${error.message}`) }
  for (const { file } of Object.values(KLYVARON_PRODUCTION_SIGNATURES)) {
    try {
      const loaded = await safeRead(join(signatureDir, file))
      signatures[file] = parseJson(loaded.bytes.toString('utf8'), file)
    } catch (error) { blockers.push(`${file}: ${error.message}`) }
  }
  if (blockers.length) return invalid(blockers, { tier, version, modelId: klyvaronProductionModelId(tier) })

  const documentValidation = validateKlyvaronProductionEvidenceDocuments({ tier, version, documents })
  blockers.push(...documentValidation.blockers)
  const identity = documentValidation.identity
  let computedManifestSha256 = null
  try { computedManifestSha256 = canonicalProvenanceSha256(klyvaronEvidenceManifestBody(manifest)) } catch { /* malformed manifest is blocked below */ }
  if (manifest.schema !== 'klyvaron.production-evidence-manifest.v1' || manifest.manifestSha256 !== computedManifestSha256) {
    blockers.push('evidence manifest body or digest is invalid')
  }
  if (manifest.tier !== tier || manifest.modelId !== klyvaronProductionModelId(tier) || manifest.version !== version
    || manifest.modelRevisionSha256 !== identity?.modelRevisionSha256 || manifest.artifactSha256 !== identity?.artifactSha256) {
    blockers.push('evidence manifest does not bind to the exact requested tier, version and model artifact')
  }
  const manifestFiles = manifest.files
  if (!Array.isArray(manifestFiles) || manifestFiles.length !== KLYVARON_PRODUCTION_EVIDENCE_FILES.length) {
    blockers.push('evidence manifest must pin every required evidence file exactly once')
  } else {
    const expectedNames = [...KLYVARON_PRODUCTION_EVIDENCE_FILES].sort()
    const manifestNames = manifestFiles.map((entry) => entry?.path).sort()
    if (expectedNames.some((name, index) => manifestNames[index] !== name)
      || new Set(manifestNames).size !== manifestNames.length) blockers.push('evidence manifest file list is missing, duplicated or contains unexpected files')
    for (const entry of manifestFiles) {
      const actual = rawFiles[entry?.path]
      if (!actual || !SHA256.test(entry?.sha256 ?? '') || !Number.isSafeInteger(entry?.bytes)
        || actual.sha256 !== entry.sha256.toLowerCase() || actual.size !== entry.bytes) {
        blockers.push(`evidence manifest does not match file bytes for '${entry?.path ?? 'unknown'}'`)
      }
    }
  }

  const signatureReport = verifyKlyvaronProductionEvidenceSignatures({ manifest, signatures, documents, trustStore, now })
  blockers.push(...signatureReport.blockers)

  let artifactVerification = null
  if (identity && documentValidation.artifactFiles.length) {
    const fileReport = await verifyPinnedLocalFiles({
      root: artifactRoot,
      files: documentValidation.artifactFiles.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    })
    if (!fileReport.passed) blockers.push(...fileReport.blockers.map((reason) => `artifact bytes: ${reason}`))
    artifactVerification = {
      passed: fileReport.passed,
      artifactSha256: identity.artifactSha256,
      files: fileReport.files.map((file) => ({ ...file })),
      totalBytes: fileReport.totalBytes,
      localFileReportSha256: fileReport.reportSha256,
    }
  } else blockers.push('artifact file manifest is unavailable for byte verification')

  const passed = blockers.length === 0
  const packageObject = passed ? {
    schema: 'klyvaron.production-evidence-package.v1',
    manifest,
    signatures,
    documents,
    fileContents: Object.fromEntries(Object.entries(rawFiles).map(([name, entry]) => [name, entry.bytes.toString('utf8')])),
    artifactVerification,
  } : null
  return {
    schema: 'klyvaron.production-evidence-validation.v1',
    status: passed ? 'passed' : 'blocked',
    passed,
    blockers: [...new Set(blockers)],
    tier,
    version,
    modelId: identity?.modelId ?? klyvaronProductionModelId(tier),
    modelRevisionSha256: identity?.modelRevisionSha256 ?? null,
    artifactSha256: identity?.artifactSha256 ?? null,
    evidenceManifestSha256: manifest.manifestSha256 ?? null,
    signatures: signatureReport.verifications,
    artifactVerification,
    package: packageObject,
  }
}
