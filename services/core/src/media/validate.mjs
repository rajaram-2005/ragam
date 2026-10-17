// Media output validation.
//
// Directive §9: "Validate outputs, MIME types, sizes, safety constraints and file
// integrity" and "Do not represent a still image, static preview or synthetic
// placeholder as a completed generated video."
//
// Every check here inspects real bytes. A provider's Content-Type header is treated
// as a *claim* and verified against the container signature.

export const MEDIA_KINDS = Object.freeze({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' })

const SIGNATURES = [
  { format: 'png', kind: MEDIA_KINDS.IMAGE, mime: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { format: 'jpeg', kind: MEDIA_KINDS.IMAGE, mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { format: 'gif', kind: MEDIA_KINDS.IMAGE, mime: 'image/gif', test: (b) => startsWithAscii(b, 'GIF8') },
  { format: 'webp', kind: MEDIA_KINDS.IMAGE, mime: 'image/webp', test: (b) => startsWithAscii(b, 'RIFF') && asciiAt(b, 8, 'WEBP') },
  { format: 'bmp', kind: MEDIA_KINDS.IMAGE, mime: 'image/bmp', test: (b) => startsWithAscii(b, 'BM') },
  // ISO-BMFF: bytes 4..8 hold 'ftyp'. Covers mp4/mov/m4v.
  { format: 'mp4', kind: MEDIA_KINDS.VIDEO, mime: 'video/mp4', test: (b) => b.length > 12 && asciiAt(b, 4, 'ftyp') },
  { format: 'webm', kind: MEDIA_KINDS.VIDEO, mime: 'video/webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { format: 'wav', kind: MEDIA_KINDS.AUDIO, mime: 'audio/wav', test: (b) => startsWithAscii(b, 'RIFF') && asciiAt(b, 8, 'WAVE') },
  { format: 'mp3', kind: MEDIA_KINDS.AUDIO, mime: 'audio/mpeg', test: (b) => (b.length > 3 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || startsWithAscii(b, 'ID3') },
  { format: 'ogg', kind: MEDIA_KINDS.AUDIO, mime: 'audio/ogg', test: (b) => startsWithAscii(b, 'OggS') },
  { format: 'flac', kind: MEDIA_KINDS.AUDIO, mime: 'audio/flac', test: (b) => startsWithAscii(b, 'fLaC') },
]

function startsWithAscii(bytes, text) {
  if (bytes.length < text.length) return false
  for (let i = 0; i < text.length; i += 1) if (bytes[i] !== text.charCodeAt(i)) return false
  return true
}

function asciiAt(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i += 1) if (bytes[offset + i] !== text.charCodeAt(i)) return false
  return true
}

/** Identify a container from its bytes. Returns null when nothing matches. */
export function sniffMedia(bytes) {
  const view = toBytes(bytes)
  for (const signature of SIGNATURES) {
    if (signature.test(view)) return { format: signature.format, kind: signature.kind, mime: signature.mime }
  }
  return null
}

/** Detect text/HTML/JSON masquerading as media (a common provider error path). */
export function looksLikeTextPayload(bytes) {
  const view = toBytes(bytes)
  const head = view.subarray(0, Math.min(512, view.length))
  if (!head.length) return false
  const text = Buffer.from(head).toString('utf8')
  return /^\s*(\{|<|\[|error|<!doctype)/i.test(text)
}

/**
 * Validate a generated media artifact.
 *
 * @param {object} input
 * @param {ArrayBuffer|Uint8Array|Buffer} input.bytes
 * @param {string} input.expectedKind        MEDIA_KINDS value
 * @param {string} [input.claimedContentType] what the provider asserted
 * @param {number} [input.minBytes]
 * @param {number} [input.maxBytes]
 * @returns {{valid:boolean, reasons:string[], format?:string, mime?:string, byteLength:number, contentTypeMatches:boolean}}
 */
export function validateMedia({ bytes, expectedKind, claimedContentType = null, minBytes = 1, maxBytes = 512 * 1024 * 1024 }) {
  const view = toBytes(bytes)
  const reasons = []

  if (!view || view.byteLength === 0) reasons.push('payload is empty')
  if (view.byteLength < minBytes) reasons.push(`payload ${view.byteLength}B is below the ${minBytes}B minimum`)
  if (view.byteLength > maxBytes) reasons.push(`payload ${view.byteLength}B exceeds the ${maxBytes}B maximum`)

  const sniffed = view.byteLength ? sniffMedia(view) : null
  if (!sniffed) {
    reasons.push('no recognised media container signature in payload')
    if (looksLikeTextPayload(view)) reasons.push('payload appears to be text/JSON/HTML, not media (likely a provider error body)')
  } else if (sniffed.kind !== expectedKind) {
    reasons.push(`payload is ${sniffed.format} (${sniffed.kind}), but ${expectedKind} was requested`)
  }

  let contentTypeMatches = false
  if (claimedContentType && sniffed) {
    const claimedBase = String(claimedContentType).split(';')[0].trim().toLowerCase()
    // Accept the sniffed mime, or a compatible alias (video/quicktime for mp4).
    const aliases = new Set([sniffed.mime])
    if (sniffed.format === 'mp4') aliases.add('video/quicktime').add('video/mp4')
    if (sniffed.format === 'jpeg') aliases.add('image/jpg').add('image/jpeg')
    contentTypeMatches = aliases.has(claimedBase)
    if (!contentTypeMatches) reasons.push(`provider claimed '${claimedBase}' but bytes are ${sniffed.mime}`)
  }

  return {
    valid: reasons.length === 0,
    reasons,
    format: sniffed?.format ?? null,
    kind: sniffed?.kind ?? null,
    mime: sniffed?.mime ?? null,
    byteLength: view.byteLength,
    contentTypeMatches,
  }
}

/**
 * Reject a "video" that is really a still image or a tiny stub. This is the
 * specific guard the directive requires: a single-frame JPEG or a 2 KB placeholder
 * must not be reported as a completed generated video.
 */
export function assertGenuineVideo(validation, { minBytes = 8 * 1024 } = {}) {
  const problems = []
  if (!validation.valid) problems.push(...validation.reasons)
  if (validation.kind === MEDIA_KINDS.IMAGE) {
    problems.push(`received a still ${validation.format} image, not a video — this is not a completed video generation`)
  }
  if (validation.valid && validation.byteLength < minBytes) {
    problems.push(`video payload is only ${validation.byteLength}B (< ${minBytes}B); too small to be a genuine generated clip`)
  }
  return { genuine: problems.length === 0, problems }
}

/** Decode a b64_json image response into bytes. */
export function decodeBase64Media(value) {
  if (typeof value !== 'string' || !value) return null
  const buffer = Buffer.from(value, 'base64')
  return buffer.byteLength ? new Uint8Array(buffer) : null
}

/** Resolve an image-generation `data[]` entry into bytes, handling url|b64_json. */
export function extractImageBytes(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (typeof entry.b64_json === 'string') return decodeBase64Media(entry.b64_json)
  return null // 'url' entries must be fetched by the caller through the egress guard
}

/**
 * Measure an MP4/MOV's duration from its own `moov/mvhd` box.
 *
 * A provider's duration in a JSON response is a claim; the file is the artifact. This walks the
 * ISO-BMFF box tree, bounds every read by the box it is reading, and returns `null` when the
 * duration is absent rather than guessing zero. It is deliberately not a full media probe.
 */
export function probeMp4(bytes) {
  const view = toBytes(bytes)
  if (!view.length || !asciiAt(view, 4, 'ftyp')) return null
  const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
  const boxes = (start, end) => {
    const found = []
    let offset = start
    while (offset + 8 <= end) {
      let size = buf.readUInt32BE(offset)
      const type = buf.toString('latin1', offset + 4, offset + 8)
      let header = 8
      if (size === 1) {
        if (offset + 16 > end) break
        const large = buf.readBigUInt64BE(offset + 8)
        if (large > BigInt(end - offset)) break
        size = Number(large)
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) break
      found.push({ type, start: offset, end: offset + size, header })
      offset += size
    }
    return found
  }
  const moov = boxes(0, buf.length).find((box) => box.type === 'moov')
  if (!moov) return null
  const mvhd = boxes(moov.start + moov.header, moov.end).find((box) => box.type === 'mvhd')
  if (!mvhd) return null
  const payload = mvhd.start + mvhd.header
  if (payload + 4 > mvhd.end) return null
  const version = buf[payload]
  let timescale
  let duration
  if (version === 0 && payload + 20 <= mvhd.end) {
    timescale = buf.readUInt32BE(payload + 12)
    duration = buf.readUInt32BE(payload + 16)
  } else if (version === 1 && payload + 32 <= mvhd.end) {
    timescale = buf.readUInt32BE(payload + 20)
    const raw = buf.readBigUInt64BE(payload + 24)
    duration = raw > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(raw)
  } else {
    return null
  }
  if (!timescale || duration === null || duration === 0) return { durationSeconds: null, timescale: timescale || null }
  return { durationSeconds: Math.round((duration / timescale) * 1000) / 1000, timescale }
}

function toBytes(value) {
  if (!value) return new Uint8Array(0)
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  return new Uint8Array(0)
}
