import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const SHA256 = /^[a-f0-9]{64}$/i
const DEFAULT_MAX_FILE_BYTES = 50 * 1024 ** 3
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 ** 3
const READ_CHUNK_BYTES = 1024 * 1024

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) throw new TypeError('file verification records must contain JSON-compatible values only')
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function validRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false
  const parts = value.split('/')
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.includes(':') && /^[a-z0-9._-]+$/i.test(part))
}

function invalid(reason) {
  return { status: 'blocked', passed: false, blockers: [reason], files: [], totalBytes: 0, manifestSha256: null, reportSha256: null }
}

function safeErrorReason(error) {
  const known = new Set([
    'symbolic links are not accepted',
    'a parent path component is not a directory',
    'target is not a regular file',
    'file size is empty or exceeds the configured per-file limit',
    'file size does not match the pinned byte count',
    'file grew beyond the configured per-file limit while being read',
    'file changed while it was being verified',
  ])
  if (known.has(error?.message)) return error.message
  if (error?.code === 'ENOENT') return 'file or path component is missing'
  if (error?.code === 'ELOOP') return 'symbolic links are not accepted'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'file cannot be read due to permissions'
  if (error?.code === 'ENOTDIR') return 'a parent path component is not a directory'
  return 'filesystem verification failed'
}

async function inspectPathWithoutLinks(root, relativePath) {
  const parts = relativePath.split('/')
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    const info = await lstat(current, { bigint: true })
    if (info.isSymbolicLink()) throw new Error('symbolic links are not accepted')
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('a parent path component is not a directory')
    if (index === parts.length - 1 && !info.isFile()) throw new Error('target is not a regular file')
  }
  return current
}

async function hashOneFile(root, entry, maxFileBytes) {
  const filePath = await inspectPathWithoutLinks(root, entry.path)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(filePath, constants.O_RDONLY | noFollow)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('target is not a regular file')
    if (before.size <= 0n || before.size > BigInt(maxFileBytes)) throw new Error('file size is empty or exceeds the configured per-file limit')
    if (entry.bytes !== undefined && before.size !== BigInt(entry.bytes)) throw new Error('file size does not match the pinned byte count')

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let bytes = 0n
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      bytes += BigInt(bytesRead)
      if (bytes > BigInt(maxFileBytes)) throw new Error('file grew beyond the configured per-file limit while being read')
      hash.update(buffer.subarray(0, bytesRead))
    }

    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes !== after.size) {
      throw new Error('file changed while it was being verified')
    }
    const sha256 = hash.digest('hex')
    const expected = entry.sha256.toLowerCase()
    return {
      path: entry.path,
      expectedSha256: expected,
      actualSha256: sha256,
      bytes: Number(bytes),
      verified: sha256 === expected,
      reason: sha256 === expected ? null : 'SHA-256 does not match the pinned digest',
    }
  } finally {
    await handle.close()
  }
}

/**
 * Hash a caller-pinned set of files already present under a local directory. This performs
 * no network access and reads bytes only to compute SHA-256; it never returns or stores file
 * contents. It does not authenticate who supplied the expected digests or establish legal
 * rights. The caller must keep the verification root private and quiescent during the run.
 */
export async function verifyPinnedLocalFiles({
  root,
  files,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
} = {}) {
  if (typeof root !== 'string' || !root || !Array.isArray(files) || files.length === 0) {
    return invalid('a local root and at least one pinned file are required')
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
    return invalid('file and total byte limits must be positive safe integers')
  }
  if (!files.every((entry) => isRecord(entry)
    && Object.keys(entry).every((key) => ['path', 'sha256', 'bytes'].includes(key))
    && validRelativePath(entry.path)
    && typeof entry.sha256 === 'string' && SHA256.test(entry.sha256)
    && Number.isSafeInteger(entry.bytes) && entry.bytes > 0)) {
    return invalid('each pinned file requires a safe relative path, SHA-256 digest and positive byte count')
  }
  if (new Set(files.map((entry) => entry.path)).size !== files.length) return invalid('duplicate file paths are not accepted')
  if (files.reduce((sum, entry) => sum + entry.bytes, 0) > maxTotalBytes) {
    return invalid('pinned byte counts exceed the configured total limit')
  }

  const absoluteRoot = resolve(root)
  try {
    const rootInfo = await lstat(absoluteRoot, { bigint: true })
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return invalid('verification root must be a real directory, not a symbolic link')
  } catch (error) {
    return invalid(`verification root cannot be inspected: ${safeErrorReason(error)}`)
  }

  const fileResults = []
  let totalBytes = 0
  for (const entry of files) {
    try {
      const result = await hashOneFile(absoluteRoot, entry, maxFileBytes)
      totalBytes += result.bytes
      if (totalBytes > maxTotalBytes) {
        fileResults.push({ ...result, verified: false, reason: 'files exceed the configured total byte limit' })
        break
      }
      fileResults.push(result)
    } catch (error) {
      fileResults.push({
        path: entry.path,
        expectedSha256: entry.sha256.toLowerCase(),
        actualSha256: null,
        bytes: null,
        verified: false,
        reason: safeErrorReason(error),
      })
    }
  }

  const passed = fileResults.length === files.length && fileResults.every((entry) => entry.verified)
  const manifest = files.map(({ path, sha256, bytes }) => ({ path, sha256: sha256.toLowerCase(), bytes }))
  const manifestSha256 = digest({ schema: 'klyvaron.local-file-manifest.v1', files: manifest })
  const reportBody = {
    schema: 'klyvaron.local-file-verification.v1',
    status: passed ? 'passed' : 'blocked',
    manifestSha256,
    artifactSha256: passed ? (fileResults.length === 1 ? fileResults[0].actualSha256 : manifestSha256) : null,
    totalBytes,
    files: fileResults,
  }
  return {
    ...reportBody,
    passed,
    blockers: fileResults.filter((entry) => !entry.verified).map(({ path, reason }) => `${path}: ${reason}`),
    reportSha256: digest(reportBody),
  }
}

/** Check the internal consistency and artifact binding of a successful local-file report. */
export function isVerifiedPinnedLocalFileReport(report, { sha256, bytes } = {}) {
  if (!isRecord(report)
    || Object.keys(report).some((key) => !['schema', 'status', 'manifestSha256', 'artifactSha256', 'totalBytes', 'files', 'passed', 'blockers', 'reportSha256'].includes(key))
    || report.schema !== 'klyvaron.local-file-verification.v1'
    || report.status !== 'passed' || report.passed !== true
    || typeof report.manifestSha256 !== 'string' || !SHA256.test(report.manifestSha256)
    || typeof report.artifactSha256 !== 'string' || !SHA256.test(report.artifactSha256)
    || typeof report.reportSha256 !== 'string' || !SHA256.test(report.reportSha256)
    || !Number.isSafeInteger(report.totalBytes) || report.totalBytes <= 0
    || !Array.isArray(report.files) || report.files.length === 0
    || !Array.isArray(report.blockers) || report.blockers.length !== 0) return false

  const filesValid = report.files.every((file) => isRecord(file)
    && Object.keys(file).every((key) => ['path', 'expectedSha256', 'actualSha256', 'bytes', 'verified', 'reason'].includes(key))
    && validRelativePath(file.path)
    && typeof file.expectedSha256 === 'string' && SHA256.test(file.expectedSha256)
    && typeof file.actualSha256 === 'string' && SHA256.test(file.actualSha256)
    && file.expectedSha256.toLowerCase() === file.actualSha256.toLowerCase()
    && Number.isSafeInteger(file.bytes) && file.bytes > 0
    && file.verified === true && file.reason === null)
  if (!filesValid || new Set(report.files.map((file) => file.path)).size !== report.files.length) return false

  const totalBytes = report.files.reduce((sum, file) => sum + file.bytes, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== report.totalBytes) return false
  const manifest = report.files.map((file) => ({ path: file.path, sha256: file.expectedSha256.toLowerCase(), bytes: file.bytes }))
  if (digest({ schema: 'klyvaron.local-file-manifest.v1', files: manifest }) !== report.manifestSha256) return false
  const expectedArtifactSha256 = report.files.length === 1 ? report.files[0].actualSha256.toLowerCase() : report.manifestSha256
  if (report.artifactSha256 !== expectedArtifactSha256) return false
  const reportBody = {
    schema: report.schema,
    status: report.status,
    manifestSha256: report.manifestSha256,
    artifactSha256: report.artifactSha256,
    totalBytes: report.totalBytes,
    files: report.files,
  }
  if (digest(reportBody) !== report.reportSha256) return false
  return (sha256 === undefined || (typeof sha256 === 'string' && SHA256.test(sha256) && sha256.toLowerCase() === report.artifactSha256))
    && (bytes === undefined || (Number.isSafeInteger(bytes) && bytes === report.totalBytes))
}
