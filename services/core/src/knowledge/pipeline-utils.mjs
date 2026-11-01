import { extname } from 'node:path'

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.ini', '.log', '.html', '.htm', '.xml', '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.sql', '.graphql', '.proto'])
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.com', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.class', '.apk', '.ipa', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm'])
const BINARY_SIGNATURES = [
  { name: 'elf', test: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  { name: 'macho', test: (b) => (b[0] === 0xcf || b[0] === 0xce) && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe },
  { name: 'pe', test: (b) => b[0] === 0x4d && b[1] === 0x5a },
  { name: 'pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { name: 'zip_or_office', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { name: 'gzip', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { name: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { name: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
]

export class IngestionRejectedError extends Error {
  constructor(message, reason) {
    super(message)
    this.name = 'IngestionRejectedError'
    this.code = 'ingestion_rejected'
    this.reason = reason
  }
}

/** Reject forbidden types, binary masquerades, and unsupported text extensions. */
export function validateFileType({ filename, bytes }) {
  const ext = extname(String(filename ?? '')).toLowerCase()
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  if (FORBIDDEN_EXTENSIONS.has(ext)) throw new IngestionRejectedError(`'${ext}' files are not ingested`, 'forbidden_extension')
  for (const signature of BINARY_SIGNATURES) {
    if (signature.test(view)) throw new IngestionRejectedError(`file content is ${signature.name}, not text`, `binary_content:${signature.name}`)
  }
  if (!TEXT_EXTENSIONS.has(ext)) throw new IngestionRejectedError(`'${ext || '(no extension)'}' is not a supported text type`, 'unsupported_extension')
  const sample = view.subarray(0, Math.min(8192, view.length))
  let control = 0
  for (const byte of sample) if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  if (sample.length && control / sample.length > 0.02) {
    throw new IngestionRejectedError('file contains a high density of control characters', 'binary_content:heuristic')
  }
  return { ext, mime: mimeFor(ext), bytes: view.byteLength, ok: true }
}

function mimeFor(ext) {
  const map = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
    '.yaml': 'application/yaml', '.yml': 'application/yaml', '.csv': 'text/csv',
    '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.txt': 'text/plain',
  }
  return map[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream')
}

/** Longest consecutive token run shared by two token sequences. */
export function longestCommonTokenRun(a, b) {
  if (!a?.length || !b?.length) return 0
  let best = 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}
