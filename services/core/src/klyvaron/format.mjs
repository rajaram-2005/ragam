// The Klyvaron artifact format: how a first-party model is described, and how a
// description that does not match the bytes is refused.
//
// Phase 4 requires genuine local inference. "Genuine" is the load-bearing word: a
// loader that silently loads the wrong checkpoint, or a checkpoint whose tail was
// truncated, does not crash — it generates worse text, and worse text is attributed to
// the model rather than to the loader. So the format carries integrity data and this
// module refuses to hand back a model that does not match it.

import { createHash } from 'node:crypto'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { endianness } from 'node:os'
import { join, basename } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { memorySnapshot } from '../hardware/detect.mjs'

export const ARTIFACT_FORMAT = 'klyvaron.artifact/1'
export const QUANTIZED_ARTIFACT_FORMAT = 'klyvaron.artifact/2'
export const ADAPTER_FORMAT = 'klyvaron.adapter/1'
export const INT8_SCHEME = 'symmetric-int8-per-tensor'
export const MANIFEST_SUFFIX = '.klyvaron.json'
export const TOKENIZER_FORMAT = 'klyvaron.tokenizer.character/1'
export const BYTE_BPE_FORMAT = 'klyvaron.tokenizer.byte-bpe/1'
export const BASE_BYTE_VOCAB = 256
export const UNK_CHARACTER = '\ufffd'

const IS_LITTLE_ENDIAN = endianness() === 'LE'

export class ArtifactError extends Error {
  constructor(message, { code = 'artifact_error', detail = {} } = {}) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// Container readers: ZIP (the .npz) and .npy
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_EXTRA_ID = 0x0001
const ZIP64_SENTINEL = 0xffffffff

function findExtraField(buffer, start, length, id) {
  const end = Math.min(start + length, buffer.length)
  let cursor = start
  while (cursor + 4 <= end) {
    const fieldId = buffer.readUInt16LE(cursor)
    const fieldLength = buffer.readUInt16LE(cursor + 2)
    if (fieldId === id) return buffer.subarray(cursor + 4, cursor + 4 + fieldLength)
    cursor += 4 + fieldLength
  }
  return null
}

function resolveZip64Sizes(buffer, {
  centralExtraStart, centralExtraLength, localExtraStart, localExtraLength,
  compressedSize, uncompressedSize, name,
}) {
  if (compressedSize !== ZIP64_SENTINEL && uncompressedSize !== ZIP64_SENTINEL) {
    return { compressed: compressedSize, uncompressed: uncompressedSize }
  }
  const sources = [
    ['the central directory', centralExtraStart, centralExtraLength],
    ['the local header', localExtraStart, localExtraLength],
  ]
  for (const [, start, length] of sources) {
    const field = findExtraField(buffer, start, length, ZIP64_EXTRA_ID)
    if (!field) continue
    let cursor = 0
    const resolved = { compressed: compressedSize, uncompressed: uncompressedSize }
    if (uncompressedSize === ZIP64_SENTINEL) {
      if (cursor + 8 > field.length) continue
      resolved.uncompressed = Number(field.readBigUInt64LE(cursor))
      cursor += 8
    }
    if (compressedSize === ZIP64_SENTINEL) {
      if (cursor + 8 > field.length) continue
      resolved.compressed = Number(field.readBigUInt64LE(cursor))
      cursor += 8
    }
    return resolved
  }
  throw new ArtifactError(
    `'${name}' declares a 64-bit size but carries no ZIP64 extra field (looked in the central directory and the local header)`,
    { code: 'corrupt_zip' },
  )
}

export function readZipEntries(buffer, { maxUncompressedBytes = Infinity } = {}) {
  let expandedBytes = 0
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new ArtifactError('not a ZIP container: no end-of-central-directory record', { code: 'not_a_zip' })
  const entryCount = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()

  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ArtifactError(`central directory entry ${i} has a bad signature`, { code: 'corrupt_zip' })
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ArtifactError(`'${name}' has a bad local header`, { code: 'corrupt_zip' })
    }
    if (localOffset === ZIP64_SENTINEL) {
      throw new ArtifactError(
        `'${name}' is stored at a 64-bit offset; this reader works on an in-memory buffer and cannot address past 4 GB`,
        { code: 'unsupported_zip64' },
      )
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const { compressed, uncompressed } = resolveZip64Sizes(buffer, {
      centralExtraStart: offset + 46 + nameLength,
      centralExtraLength: extraLength,
      localExtraStart: localOffset + 30 + localNameLength,
      localExtraLength,
      compressedSize,
      uncompressedSize,
      name,
    })
    expandedBytes += uncompressed
    if (!Number.isSafeInteger(compressed) || !Number.isSafeInteger(uncompressed) || compressed < 0 || uncompressed < 0
      || dataStart + compressed > buffer.length || expandedBytes > maxUncompressedBytes) {
      throw new ArtifactError(`'${name}' exceeds the checked archive allocation envelope`, { code: 'archive_limit' })
    }
    if (entries.has(name)) throw new ArtifactError(`duplicate ZIP member '${name}'`, { code: 'corrupt_zip' })
    const raw = buffer.subarray(dataStart, dataStart + compressed)

    let data
    if (method === 0) data = raw
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressed) }) }
      catch { throw new ArtifactError(`'${name}' has invalid or oversized compressed data`, { code: 'corrupt_zip' }) }
    } else throw new ArtifactError(`'${name}' uses unsupported compression method ${method}`, { code: 'unsupported_compression' })
    if (data.length !== uncompressed) {
      throw new ArtifactError(`'${name}' is ${data.length} bytes, the directory says ${uncompressed}`, { code: 'corrupt_zip' })
    }
    entries.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - (22 + 0xffff))
  for (let i = buffer.length - 22; i >= minimum; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  return -1
}

const DTYPE_READERS = {
  '|i1': { bytes: 1, read: (buffer, offset) => buffer.readInt8(offset), array: Int8Array },
  '<f4': { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset), array: Float32Array },
  '<f8': { bytes: 8, read: (buffer, offset) => buffer.readDoubleLE(offset), array: Float64Array },
  '|i4': { bytes: 4, read: (buffer, offset) => buffer.readInt32LE(offset), array: Int32Array },
  '<i4': { bytes: 4, read: (buffer, offset) => buffer.readInt32LE(offset), array: Int32Array },
  '|u1': { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset), array: Uint8Array },
}

export function readNpy(buffer, allowFortran = false) {
  if (buffer.length < 10) throw new ArtifactError('a .npy member is too short to hold a header', { code: 'corrupt_npy' })
  const magic = buffer.toString('latin1', 0, 6)
  if (magic !== '\x93NUMPY') throw new ArtifactError('a .npy member has a bad magic string', { code: 'corrupt_npy' })
  const major = buffer.readUInt8(6)
  let headerLength
  let headerStart
  if (major === 1) {
    headerLength = buffer.readUInt16LE(8)
    headerStart = 10
  } else if (major === 2 || major === 3) {
    headerLength = buffer.readUInt32LE(8)
    headerStart = 12
  } else {
    throw new ArtifactError(`unsupported .npy version ${major}`, { code: 'unsupported_npy' })
  }
  const header = buffer.toString('latin1', headerStart, headerStart + headerLength)

  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1]
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1]
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1]
  if (!descr || !fortran || shapeText === undefined) {
    throw new ArtifactError('.npy header is missing descr, fortran_order or shape', { code: 'corrupt_npy' })
  }
  if (fortran === 'True' && !allowFortran) {
    throw new ArtifactError('the array is Fortran-ordered; transposing it silently would change the model', {
      code: 'fortran_order',
    })
  }
  const shape = shapeText.split(',').map((part) => part.trim()).filter(Boolean).map((part) => Number(part))
  const reader = DTYPE_READERS[descr]
  if (!reader) throw new ArtifactError(`unsupported dtype '${descr}'`, { code: 'unsupported_dtype' })

  const count = shape.reduce((a, b) => a * b, 1)
  if (!shape.every((n) => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(count)) {
    throw new ArtifactError('invalid or overflowing array shape', { code: 'corrupt_npy' })
  }
  const start = headerStart + headerLength
  const expected = count * reader.bytes
  if (buffer.length - start !== expected) {
    throw new ArtifactError(
      `array data is ${buffer.length - start} bytes, shape ${JSON.stringify(shape)} with ${descr} needs ${expected}`,
      { code: 'corrupt_npy' },
    )
  }
  let out
  if (IS_LITTLE_ENDIAN) {
    const byteOffset = buffer.byteOffset + start
    if (byteOffset % reader.bytes === 0) {
      out = new reader.array(buffer.buffer, byteOffset, count).slice()
    } else {
      const aligned = Buffer.from(buffer.subarray(start, start + expected))
      out = new reader.array(aligned.buffer, aligned.byteOffset, count)
    }
  } else {
    out = new reader.array(count)
    for (let i = 0; i < count; i += 1) out[i] = reader.read(buffer, start + i * reader.bytes)
  }
  return { dtype: descr, shape, data: out, fortranOrder: fortran === 'True' }
}

/** Read every array in an .npz buffer, keyed by parameter name. */
export function readNpz(buffer, options = {}) {
  const entries = readZipEntries(buffer, options)
  const arrays = new Map()
  for (const [name, data] of entries) {
    if (!name.endsWith('.npy') || basename(name) !== name || name.includes('\\')) {
      throw new ArtifactError(`noncanonical NPZ member '${name}'`, { code: 'corrupt_zip' })
    }
    arrays.set(basename(name, '.npy'), readNpy(data))
  }
  if (!arrays.size) throw new ArtifactError('the archive holds no .npy members', { code: 'empty_archive' })
  return arrays
}

// ---------------------------------------------------------------------------
// Vocabulary digests, computed identically in Python (`export.py`) and here
// ---------------------------------------------------------------------------

export function vocabularyDigest(characters) {
  const hash = createHash('sha256')
  hash.update(`${TOKENIZER_FORMAT}\n`, 'utf8')
  for (const character of characters) hash.update(`${JSON.stringify(character)}\n`, 'utf8')
  return hash.digest('hex')
}

export function bpeDigest(merges, baseVocabSize = BASE_BYTE_VOCAB) {
  const hash = createHash('sha256')
  hash.update(`${BYTE_BPE_FORMAT}\n${baseVocabSize}\n`, 'utf8')
  for (const [left, right] of merges) hash.update(`${left},${right}\n`, 'utf8')
  return hash.digest('hex')
}

export { bpeDigest as byteBpeDigest }

// ---------------------------------------------------------------------------
// Manifest validation (supporting trunk-only and full `aetheris-core-v1`)
// ---------------------------------------------------------------------------

const REQUIRED_MANIFEST_FIELDS = [
  'format', 'tier', 'id', 'version', 'kind', 'instructionTuned', 'architecture',
  'tokenizer', 'weights', 'generation', 'provenance', 'limitations', 'licence',
]

/** The parameter names this architecture must contain, in load order. */
export function expectedParameterNames(architecture) {
  const names = ['emb', 'pos']
  for (let layer = 0; layer < architecture.n_layers; layer += 1) {
    names.push(
      `L${layer}.ln1_gain`, `L${layer}.ln1_bias`,
      `L${layer}.wq`, `L${layer}.wk`, `L${layer}.wv`, `L${layer}.wo`,
      `L${layer}.ln2_gain`, `L${layer}.ln2_bias`,
      `L${layer}.w1`, `L${layer}.w2`,
    )
  }
  names.push('lnf_gain', 'lnf_bias')
  if (!architecture.tie_embeddings) names.push('head')
  if ((architecture.age_buckets ?? 0) > 0) names.push('age_emb')
  if ((architecture.state_classes ?? 0) > 0) names.push('state_emb')
  if (architecture.verdict_head === true) names.push('verdict_w', 'verdict_b')
  if (architecture.state_head === true) names.push('state_head_w', 'state_head_b')
  return names
}

/** Parameter count for a decoder-only pre-LayerNorm transformer with optional differentiators. */
export function parameterCount(architecture) {
  const { d_model: d, d_ff: ff, vocab_size: v, n_layers: L, seq_len } = architecture
  const embedding = v * d
  const perLayer = 4 * d * d + 2 * d * ff + 4 * d
  const ageBuckets = architecture.age_buckets ?? 0
  const stateClasses = architecture.state_classes ?? 0
  const differentiators = (ageBuckets > 0 ? ageBuckets * d : 0)
    + (stateClasses > 0 ? stateClasses * d : 0)
    + (architecture.verdict_head === true ? 2 * d + 2 : 0)
    + (architecture.state_head === true ? stateClasses * d + stateClasses : 0)
  return embedding + seq_len * d + L * perLayer + 2 * d + (architecture.tie_embeddings ? 0 : v * d) + differentiators
}

function requireField(container, field, where) {
  const value = container?.[field]
  if (value === undefined || value === null) {
    throw new ArtifactError(`${where} is missing '${field}'`, { code: 'invalid_manifest', detail: { field, where } })
  }
  return value
}

export function validateManifest(manifest) {
  if (![ARTIFACT_FORMAT, QUANTIZED_ARTIFACT_FORMAT].includes(manifest?.format)) {
    throw new ArtifactError(
      `unsupported artifact format ${JSON.stringify(manifest?.format)}; this build reads ${ARTIFACT_FORMAT} and ${QUANTIZED_ARTIFACT_FORMAT}`,
      { code: 'unsupported_format' },
    )
  }
  for (const field of REQUIRED_MANIFEST_FIELDS) requireField(manifest, field, 'the manifest')

  if (typeof manifest.instructionTuned !== 'boolean') {
    throw new ArtifactError('instructionTuned must be a boolean — it decides whether the model may answer a question', {
      code: 'invalid_manifest',
    })
  }
  const arch = { ...manifest.architecture }
  for (const field of ['vocab_size', 'd_model', 'n_layers', 'n_heads', 'd_ff', 'seq_len', 'tie_embeddings']) {
    requireField(arch, field, 'architecture')
  }
  for (const field of ['vocab_size', 'd_model', 'n_layers', 'n_heads', 'd_ff', 'seq_len']) {
    if (!Number.isSafeInteger(arch[field]) || arch[field] < 1) {
      throw new ArtifactError(`architecture.${field} must be a positive safe integer`, { code: 'invalid_manifest' })
    }
  }
  for (const field of ['age_buckets', 'state_classes']) {
    if (arch[field] !== undefined && (!Number.isSafeInteger(arch[field]) || arch[field] < 0)) {
      throw new ArtifactError(`architecture.${field} must be a non-negative integer`, { code: 'invalid_manifest' })
    }
  }
  for (const field of ['verdict_head', 'state_head']) {
    if (arch[field] !== undefined && typeof arch[field] !== 'boolean') {
      throw new ArtifactError(`architecture.${field} must be a boolean`, { code: 'invalid_manifest' })
    }
  }
  if (arch.state_head === true && !(arch.state_classes > 0)) {
    throw new ArtifactError('architecture.state_head requires state_classes > 0', { code: 'invalid_manifest' })
  }
  if (typeof arch.tie_embeddings !== 'boolean' || !Number.isSafeInteger(parameterCount(arch))) {
    throw new ArtifactError('invalid architecture or overflowing parameter count', { code: 'invalid_manifest' })
  }
  if (arch.d_model % arch.n_heads) {
    throw new ArtifactError(`architecture: d_model ${arch.d_model} is not divisible by n_heads ${arch.n_heads}`, {
      code: 'invalid_manifest',
    })
  }

  const tokenizer = manifest.tokenizer
  if (tokenizer.kind === 'character') {
    if (tokenizer.unkChar !== UNK_CHARACTER) {
      throw new ArtifactError(`the unknown character must be ${JSON.stringify(UNK_CHARACTER)}, got ${JSON.stringify(tokenizer.unkChar)}`, {
        code: 'invalid_manifest',
      })
    }
    if (!Array.isArray(tokenizer.characters) || !tokenizer.characters.length) {
      throw new ArtifactError('the tokenizer must carry its vocabulary', { code: 'invalid_manifest' })
    }
    if (new Set(tokenizer.characters).size !== tokenizer.characters.length) {
      throw new ArtifactError('the vocabulary contains duplicate characters', { code: 'invalid_manifest' })
    }
    if (tokenizer.characters.includes(UNK_CHARACTER)) {
      throw new ArtifactError('the vocabulary must not contain the reserved unknown character', { code: 'invalid_manifest' })
    }
    const computed = vocabularyDigest(tokenizer.characters)
    if (tokenizer.digest !== computed) {
      throw new ArtifactError(
        `vocabulary digest is ${tokenizer.digest}, the characters hash to ${computed}`,
        { code: 'vocabulary_mismatch' },
      )
    }
    if (tokenizer.characters.length + 1 !== arch.vocab_size) {
      throw new ArtifactError(
        `vocabulary has ${tokenizer.characters.length} characters but the architecture expects ${arch.vocab_size - 1}`,
        { code: 'invalid_manifest' },
      )
    }
  } else if (tokenizer.kind === 'byte-bpe') {
    const baseSize = tokenizer.baseVocabSize ?? BASE_BYTE_VOCAB
    if (baseSize !== BASE_BYTE_VOCAB) {
      throw new ArtifactError(`byte-bpe requires baseVocabSize ${BASE_BYTE_VOCAB}`, { code: 'invalid_manifest' })
    }
    if (!Array.isArray(tokenizer.merges) || !tokenizer.merges.length) {
      throw new ArtifactError('byte-bpe tokenizer must declare non-empty merges', { code: 'invalid_manifest' })
    }
    const seenPairs = new Set()
    for (let i = 0; i < tokenizer.merges.length; i += 1) {
      const pair = tokenizer.merges[i]
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new ArtifactError(`merge ${i} must be a [left, right] pair`, { code: 'invalid_manifest' })
      }
      const [left, right] = pair
      if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
        || left < 0 || left >= BASE_BYTE_VOCAB + i || right < 0 || right >= BASE_BYTE_VOCAB + i) {
        throw new ArtifactError(`merge ${i} references invalid token id`, { code: 'invalid_manifest' })
      }
      const key = `${left},${right}`
      if (seenPairs.has(key)) {
        throw new ArtifactError(`duplicate merge pair '${key}'`, { code: 'invalid_manifest' })
      }
      seenPairs.add(key)
    }
    const computed = bpeDigest(tokenizer.merges, baseSize)
    if (tokenizer.digest !== computed) {
      throw new ArtifactError(
        `vocabulary digest is ${tokenizer.digest}, the merges hash to ${computed}`,
        { code: 'vocabulary_mismatch' },
      )
    }
    if (baseSize + tokenizer.merges.length !== arch.vocab_size) {
      throw new ArtifactError(
        `byte-bpe vocabulary has ${baseSize + tokenizer.merges.length} tokens, architecture expects ${arch.vocab_size}`,
        { code: 'invalid_manifest' },
      )
    }
  } else {
    throw new ArtifactError(`unsupported tokenizer kind '${tokenizer.kind}'`, { code: 'unsupported_tokenizer' })
  }

  const weights = manifest.weights
  requireField(weights, 'file', 'weights')
  requireField(weights, 'sha256', 'weights')
  requireField(weights, 'bytes', 'weights')
  if (typeof weights.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.npz$/.test(weights.file)
    || !Number.isSafeInteger(weights.bytes) || weights.bytes < 1) {
    throw new ArtifactError('weights require a safe NPZ basename and positive byte count', { code: 'invalid_manifest' })
  }
  if (!/^[0-9a-f]{64}$/.test(weights.sha256)) {
    throw new ArtifactError('weights.sha256 must be a lowercase hex sha256', { code: 'invalid_manifest' })
  }
  if (!Array.isArray(weights.names) || new Set(weights.names).size !== weights.names.length) {
    throw new ArtifactError('weights.names must be a unique list', { code: 'name_mismatch' })
  }
  const expectedCount = 10 * arch.n_layers + 4
    + (arch.tie_embeddings ? 0 : 1)
    + ((arch.age_buckets ?? 0) > 0 ? 1 : 0)
    + ((arch.state_classes ?? 0) > 0 ? 1 : 0)
    + (arch.verdict_head === true ? 2 : 0)
    + (arch.state_head === true ? 2 : 0)
  if (weights.names.length !== expectedCount) {
    throw new ArtifactError('the weight list and the architecture disagree on parameter count', { code: 'name_mismatch' })
  }
  const expected = expectedParameterNames(arch)
  const declared = new Set(weights.names ?? [])
  const missing = expected.filter((name) => !declared.has(name))
  const unexpected = [...declared].filter((name) => !expected.includes(name))
  if (missing.length || unexpected.length) {
    throw new ArtifactError(
      `the weight list and the architecture disagree (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`,
      { code: 'name_mismatch', detail: { missing, unexpected } },
    )
  }

  const quantization = weights.quantization
  if (manifest.format === QUANTIZED_ARTIFACT_FORMAT) {
    if (quantization?.scheme !== INT8_SCHEME || quantization?.scaleDtype !== 'float32') {
      throw new ArtifactError('v2 requires symmetric int8 weights and float32 scales', { code: 'invalid_quantization' })
    }
  } else if (quantization != null) {
    throw new ArtifactError('quantization metadata requires artifact format v2', { code: 'invalid_quantization' })
  }

  if (!Array.isArray(manifest.limitations) || !manifest.limitations.length) {
    throw new ArtifactError('the manifest must declare at least one limitation', { code: 'invalid_manifest' })
  }
  return manifest
}

// ---------------------------------------------------------------------------
// Loading a directory
// ---------------------------------------------------------------------------

export function findManifest(directory) {
  if (!existsSync(directory)) {
    throw new ArtifactError(`no such model directory: ${directory}`, { code: 'not_installed' })
  }
  const candidates = readdirSync(directory).filter((name) => name.endsWith(MANIFEST_SUFFIX))
  if (!candidates.length) {
    throw new ArtifactError(`no *${MANIFEST_SUFFIX} manifest in ${directory}`, { code: 'not_installed' })
  }
  if (candidates.length > 1) {
    throw new ArtifactError(
      `${directory} holds ${candidates.length} manifests (${candidates.join(', ')}); a model directory holds one`,
      { code: 'ambiguous_artifact' },
    )
  }
  return join(directory, candidates[0])
}

export function loadArtifact(directory, { verify = true, availableMemory = () => memorySnapshot().availableRamBytes } = {}) {
  const manifestPath = findManifest(directory)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new ArtifactError(`the manifest is not readable JSON: ${error.message}`, { code: 'invalid_manifest' })
  }
  validateManifest(manifest)

  const weightsPath = join(directory, manifest.weights.file)
  if (!existsSync(weightsPath)) {
    throw new ArtifactError(`the manifest names '${manifest.weights.file}', which is not in ${directory}`, {
      code: 'weights_missing',
    })
  }
  const allocation = artifactAllocation(manifest)
  const available = availableMemory()
  if (!Number.isSafeInteger(allocation.loadBytes) || !Number.isFinite(available) || available < allocation.loadBytes) {
    throw new ArtifactError('insufficient available RAM to load weights; keep the task and select a smaller model', { code: 'needs_hardware' })
  }
  if (statSync(weightsPath).size !== manifest.weights.bytes) {
    throw new ArtifactError('weights file size differs from the manifest before loading', { code: 'size_mismatch' })
  }
  const bytes = readFileSync(weightsPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (verify) {
    if (bytes.length !== manifest.weights.bytes) {
      throw new ArtifactError(
        `'${manifest.weights.file}' is ${bytes.length} bytes, the manifest says ${manifest.weights.bytes}`,
        { code: 'size_mismatch' },
      )
    }
    if (sha256 !== manifest.weights.sha256) {
      throw new ArtifactError(
        `'${manifest.weights.file}' hashes to ${sha256}, the manifest says ${manifest.weights.sha256}`,
        { code: 'digest_mismatch' },
      )
    }
  }

  const shapes = shapeMap(manifest.architecture)
  const quantized = manifest.format === QUANTIZED_ARTIFACT_FORMAT
  const matrixNames = Object.keys(shapes).filter((name) => shapes[name].length === 2)
  const scaleNames = quantized ? matrixNames.map((name) => `${name}.scale`) : []
  const weights = readNpz(bytes, { maxUncompressedBytes: allocation.expandedBytes })
  for (const name of expectedParameterNames(manifest.architecture)) {
    if (!weights.has(name)) {
      throw new ArtifactError(`the archive is missing parameter '${name}'`, { code: 'weights_incomplete' })
    }
  }
  const extra = [...weights.keys()].filter((name) => !expectedParameterNames(manifest.architecture).includes(name) && !scaleNames.includes(name))
  if (extra.length) {
    throw new ArtifactError(`the archive carries parameters the architecture does not describe: ${extra.join(', ')}`, {
      code: 'weights_unexpected',
    })
  }
  for (const [name, expectedShape] of Object.entries(shapes)) {
    const found = weights.get(name).shape
    if (found.join('x') !== expectedShape.join('x')) {
      throw new ArtifactError(
        `parameter '${name}' is ${found.join('x')}, the architecture expects ${expectedShape.join('x')}`,
        { code: 'shape_mismatch', detail: { name, found, expected: expectedShape } },
      )
    }
  }
  for (const [name, shape] of Object.entries(shapes)) {
    const entry = weights.get(name)
    if (quantized && shape.length === 2) {
      const scale = weights.get(`${name}.scale`)
      if (!(entry.data instanceof Int8Array) || !scale || scale.dtype !== '<f4'
        || scale.shape.join('x') !== '1' || !Number.isFinite(scale.data[0]) || scale.data[0] <= 0) {
        throw new ArtifactError(`invalid int8 tensor or scale for '${name}'`, { code: 'invalid_quantization' })
      }
      const s0 = scale.data[0]
      let minVal = 0
      for (let i = 0; i < entry.data.length; i += 1) {
        const v = entry.data[i]
        if (v < minVal) minVal = v
      }
      if (minVal === -128 || !Number.isFinite(Math.fround(127 * s0))) {
        throw new ArtifactError(`invalid int8 tensor or scale for '${name}'`, { code: 'invalid_quantization' })
      }
      entry.scale = scale.data
      weights.delete(`${name}.scale`)
    } else if (!(entry.data instanceof Float32Array || (!quantized && entry.data instanceof Float64Array))) {
      throw new ArtifactError(`'${name}' must contain finite floating-point weights`, { code: 'unsupported_dtype' })
    } else {
      for (let i = 0; i < entry.data.length; i += 1) {
        if (!Number.isFinite(entry.data[i])) {
          throw new ArtifactError(`'${name}' must contain finite floating-point weights`, { code: 'unsupported_dtype' })
        }
      }
    }
  }
  return { manifest, weights, directory, manifestPath, weightsPath, sha256 }
}

export function artifactAllocation(manifest) {
  const quantized = manifest.format === QUANTIZED_ARTIFACT_FORMAT
  const shapes = Object.values(shapeMap(manifest.architecture))
  const scales = quantized ? shapes.filter((shape) => shape.length === 2).length : 0
  const tensorBytes = shapes.reduce((sum, shape) => sum + shape.reduce((a, b) => a * b, 1)
    * (quantized ? shape.length === 2 ? 1 : 4 : 8), 0) + scales * 4
  const expandedBytes = tensorBytes + 4096 * (shapes.length + scales)
  return { tensorBytes, expandedBytes, loadBytes: manifest.weights.bytes + 2 * expandedBytes }
}

/** Expected shape of every parameter, derived from the architecture. */
export function shapeMap(architecture) {
  const { d_model: d, d_ff: ff, vocab_size: v, n_layers: L, seq_len: T } = architecture
  const shapes = { emb: [v, d], pos: [T, d] }
  for (let layer = 0; layer < L; layer += 1) {
    Object.assign(shapes, {
      [`L${layer}.ln1_gain`]: [d], [`L${layer}.ln1_bias`]: [d],
      [`L${layer}.wq`]: [d, d], [`L${layer}.wk`]: [d, d], [`L${layer}.wv`]: [d, d], [`L${layer}.wo`]: [d, d],
      [`L${layer}.ln2_gain`]: [d], [`L${layer}.ln2_bias`]: [d],
      [`L${layer}.w1`]: [d, ff], [`L${layer}.w2`]: [ff, d],
    })
  }
  shapes.lnf_gain = [d]
  shapes.lnf_bias = [d]
  if (!architecture.tie_embeddings) shapes.head = [v, d]
  if ((architecture.age_buckets ?? 0) > 0) shapes.age_emb = [architecture.age_buckets, d]
  if ((architecture.state_classes ?? 0) > 0) shapes.state_emb = [architecture.state_classes, d]
  if (architecture.verdict_head === true) {
    shapes.verdict_w = [d, 2]
    shapes.verdict_b = [2]
  }
  if (architecture.state_head === true) {
    shapes.state_head_w = [d, architecture.state_classes]
    shapes.state_head_b = [architecture.state_classes]
  }
  return shapes
}

/** Load and SHA-256-verify a `klyvaron.adapter/1` low-rank adapter directory. */
export function loadAdapterArtifact(directory, { expectedBaseManifest = null } = {}) {
  if (!existsSync(directory)) {
    throw new ArtifactError(`adapter directory '${directory}' does not exist`, { code: 'adapter_missing' })
  }
  const readyPath = join(directory, '.ready')
  if (!existsSync(readyPath)) {
    throw new ArtifactError(`adapter directory '${directory}' is missing its .ready marker`, { code: 'adapter_unfinalized' })
  }
  const manifests = readdirSync(directory).filter((entry) => entry.endsWith('.klyvaron.json')).sort()
  if (manifests.length !== 1) {
    throw new ArtifactError(`adapter directory '${directory}' must contain exactly one *.klyvaron.json manifest`, {
      code: 'adapter_manifest_invalid',
    })
  }
  const manifestPath = join(directory, manifests[0])
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (cause) {
    throw new ArtifactError(`adapter manifest '${manifestPath}' is invalid JSON: ${cause.message}`, {
      code: 'adapter_manifest_invalid',
    })
  }
  if (manifest?.format !== ADAPTER_FORMAT) {
    throw new ArtifactError(`unsupported adapter format '${manifest?.format}'`, { code: 'adapter_format_unsupported' })
  }
  if (expectedBaseManifest) {
    const bm = manifest.baseModel ?? {}
    if (bm.id !== expectedBaseManifest.id) {
      throw new ArtifactError(
        `adapter targets '${bm.id}', cannot load onto '${expectedBaseManifest.id}'`,
        { code: 'adapter_base_mismatch' },
      )
    }
    if (bm.weightsSha256 !== expectedBaseManifest.weights?.sha256) {
      throw new ArtifactError(
        `adapter baseWeightsSha256 (${bm.weightsSha256}) disagrees with loaded weights (${expectedBaseManifest.weights?.sha256})`,
        { code: 'adapter_base_mismatch' },
      )
    }
    if (bm.tokenizerDigest !== expectedBaseManifest.tokenizer?.digest) {
      throw new ArtifactError('adapter tokenizerDigest disagrees with loaded base tokenizer', {
        code: 'adapter_base_mismatch',
      })
    }
  }
  const weightsPath = join(directory, String(manifest.weights?.file ?? ''))
  if (!existsSync(weightsPath)) {
    throw new ArtifactError(`adapter weights file '${weightsPath}' is missing`, { code: 'adapter_weights_missing' })
  }
  const bytes = readFileSync(weightsPath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== manifest.weights?.sha256) {
    throw new ArtifactError(
      `adapter SHA-256 mismatch: manifest declares ${manifest.weights?.sha256}, file hashes to ${sha256}`,
      { code: 'adapter_digest_mismatch' },
    )
  }
  const rank = Number(manifest.lora?.rank)
  const alpha = Number(manifest.lora?.alpha)
  const targets = Array.isArray(manifest.lora?.targets) ? manifest.lora.targets : []
  if (!Number.isInteger(rank) || rank < 1 || !Number.isFinite(alpha) || alpha <= 0 || targets.length === 0) {
    throw new ArtifactError('adapter LoRA metadata is invalid', { code: 'adapter_manifest_invalid' })
  }
  const tensors = readNpz(bytes, { maxUncompressedBytes: Math.max(bytes.byteLength * 8 + 1_048_576, 67_108_864) })
  for (const [name, entry] of tensors.entries()) {
    if (!(entry.data instanceof Float32Array)) {
      throw new ArtifactError(`adapter tensor '${name}' must be float32`, { code: 'unsupported_dtype' })
    }
    for (let i = 0; i < entry.data.length; i += 1) {
      if (!Number.isFinite(entry.data[i])) {
        throw new ArtifactError(`adapter tensor '${name}' contains non-finite values`, { code: 'unsupported_dtype' })
      }
    }
  }
  return { manifest, tensors, directory, sha256, rank, alpha, scale: alpha / rank, targets }
}
