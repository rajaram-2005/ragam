// Image and video workflows.
//
// Phase 8 of the adaptive-intelligence directive. The two things this module adds to what the
// repository already had are the two the directive's rules actually bite on:
//
//   1. **A request is routed, not attempted.** `generate()` asks the provider fabric (Phase 6)
//      for a provider that can serve `image.generate` or `video.generate`, and a request nothing
//      can serve is refused with the fabric's own reason — which provider exists, why it is not
//      eligible, what is missing. There is no code path that produces "a picture" from whatever
//      is lying around.
//
//   2. **An artifact is measured before it is described.** The job queue already refuses bytes
//      that are not the modality they claim, and already refuses a still image presented as a
//      video. This layer adds the measurements the caller was promised: the image is the size
//      that was asked for, the video is at least as long as was asked for, and the digest of the
//      bytes is recorded. When a property cannot be measured — a container this build does not
//      parse — the result says `verified: 'partial'` and names what was not measured. Nothing
//      here reports `verified: 'full'` for a property it did not check.
//
// Sending a prompt to an external image provider is an egress action, so when the chosen provider
// is external the call goes through the authority broker (Phase 7): an action named by a user
// turn, with the prompt as its justification. A tool's output cannot authorise the next
// generation, and neither can the workflow's own enthusiasm.
//
// This build has no image or video provider registered, so `describe()` reports both modalities
// unavailable and `generate()` refuses by name. That is the honest state, and it is what the
// product shows. The workflow itself is exercised by tests against providers that return real
// minimal containers.

import { createHash } from 'node:crypto'
import { validateMedia, MEDIA_KINDS } from './validate.mjs'
import { TRUST, provenanceOf } from '../mcp/authority.mjs'

export const MODALITY = Object.freeze({ IMAGE: 'image', VIDEO: 'video' })

/** The capability tag each modality is routed on. */
export const MODALITY_CAPABILITY = Object.freeze({
  [MODALITY.IMAGE]: 'image.generate',
  [MODALITY.VIDEO]: 'video.generate',
})

/** What a delivered artifact's verification covers. Never a boolean, because "verified" alone hides what it covered. */
export const VERIFICATION = Object.freeze({ FULL: 'full', PARTIAL: 'partial' })

const IMAGE_FORMATS = new Set(['png', 'jpeg', 'gif'])
const VIDEO_FORMATS = new Set(['mp4'])

export class MediaWorkflowError extends Error {
  constructor(message, code = 'media_error', detail = {}) {
    super(message)
    this.name = 'MediaWorkflowError'
    this.code = code
    this.detail = detail
  }
}

const clampInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

// --- measurement -----------------------------------------------------------------------
//
// Header parsing, not decoding: the point is to report what the bytes say about themselves, so a
// provider that returns 512×512 for a 1024×1024 request is caught rather than described as 1024.

/** Width and height from a PNG, GIF or JPEG header. Returns null when the format is not parsed here. */
export function measureImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  // PNG: signature(8) length(4) 'IHDR'(4) width(4) height(4), big-endian.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  // GIF: 'GIF8' then width(2) height(2), little-endian.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) }
  }
  // JPEG: walk the segment chain to a start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < b.length) {
      if (b[offset] !== 0xff) return null
      const marker = b[offset + 1]
      // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
        return { format: 'jpeg', height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      const length = (b[offset + 2] << 8) | b[offset + 3]
      if (length < 2) return null
      offset += 2 + length
    }
  }
  return null
}

/** Duration from an MP4 `mvhd` box. Returns null when the container is WebM or not parsed here. */
export function measureVideo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])
  if (b.length < 16) return null
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const ascii = (offset) => String.fromCharCode(b[offset], b[offset + 1], b[offset + 2], b[offset + 3])
  if (ascii(0) === '\x1aE\xdf\xa3') return { format: 'webm', durationMs: null, durationBecause: 'the WebM duration lives in an EBML tree this build does not parse' }

  const boxesIn = (start, end) => {
    const boxes = []
    let offset = start
    while (offset + 8 <= end) {
      const size = view.getUint32(offset)
      if (size < 8 || offset + size > end) break
      boxes.push({ start: offset, size, type: ascii(offset + 4) })
      offset += size
    }
    return boxes
  }

  const top = b.length >= 8 && ascii(4) === 'ftyp' ? boxesIn(0, b.length) : []
  const moov = top.find((box) => box.type === 'moov')
  if (!moov) return { format: 'mp4', durationMs: null, durationBecause: 'no moov box in the payload' }
  const mvhd = boxesIn(moov.start + 8, moov.start + moov.size).find((box) => box.type === 'mvhd')
  if (!mvhd) return { format: 'mp4', durationMs: null, durationBecause: 'no mvhd box in moov' }

  const version = b[mvhd.start + 8]
  const payload = mvhd.start + 12 // past version(1) + flags(3)
  let timescale
  let duration
  if (version === 1) {
    if (mvhd.start + payload + 32 > b.length) return null
    timescale = view.getUint32(payload + 16)
    duration = Number(view.getBigUint64(payload + 20))
  } else {
    if (mvhd.start + payload + 16 > b.length) return null
    timescale = view.getUint32(payload + 8)
    duration = view.getUint32(payload + 12)
  }
  if (!timescale) return { format: 'mp4', durationMs: null, durationBecause: 'mvhd declares a zero timescale' }
  return { format: 'mp4', durationMs: Math.round((duration / timescale) * 1000), timescale, duration, durationBecause: null }
}

export function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes ?? [])).digest('hex')
}

/** The provider contract this workflow expects: bytes, and whatever the provider claims about them. */
function bytesFrom(result) {
  if (!result) return null
  const candidate = result.bytes ?? result.video ?? result.buffer ?? result.data ?? null
  if (candidate === null) return null
  if (candidate instanceof Uint8Array) return candidate
  if (Buffer.isBuffer(candidate)) return new Uint8Array(candidate)
  if (candidate instanceof ArrayBuffer) return new Uint8Array(candidate)
  if (Array.isArray(candidate)) return Uint8Array.from(candidate)
  return null
}

export class MediaWorkflow {
  /**
   * @param {object} options
   * @param {object} options.fabric     ProviderFabric from Phase 6
   * @param {object} [options.jobs]     MediaJobQueue; when given, work is queued, timed out and stored through it
   * @param {object} [options.broker]   AuthorityBroker from Phase 7; required for external providers
   * @param {object} [options.ledger]   audit ledger
   * @param {() => number} [options.now]
   */
  constructor({ fabric, jobs = null, broker = null, ledger = null, allowExternal = false, now = () => Date.now() } = {}) {
    if (!fabric) throw new TypeError('MediaWorkflow requires a provider fabric')
    this.fabric = fabric
    this.jobs = jobs
    this.broker = broker
    this.ledger = ledger
    // The installation's opt-in, not the caller's: it says this deployment is allowed to send a
    // prompt to a cloud provider at all. Whether *this* request may is a separate question, and
    // the answer to it is an authority minted from a user turn.
    this.allowExternal = allowExternal === true
    this.now = now
  }

  #audit(action, outcome, detail, subject = null) {
    this.ledger?.record({ category: 'media.workflow', action, outcome, subject, detail })
  }

  /**
   * What this installation can actually do right now, per modality.
   *
   * Asked of the fabric rather than asserted here, so the answer moves when a provider is
   * registered or a probe fails — and it carries the refusal reason when the answer is no.
   */
  describe() {
    const readiness = (modality) => {
      const capability = MODALITY_CAPABILITY[modality]
      try {
        const routed = this.fabric.route([capability], { allowExternal: this.allowExternal })
        return Object.freeze({
          modality,
          capability,
          available: true,
          provider: routed.chosen.id,
          model: routed.chosen.model ?? null,
          privacy: routed.chosen.privacy,
          // An external provider is reachable and still not usable without a grant, so the
          // readiness view says so rather than implying a request would just work.
          requiresAuthority: routed.chosen.privacy === 'external',
          because: routed.because,
        })
      } catch (error) {
        return Object.freeze({
          modality,
          capability,
          available: false,
          provider: null,
          code: error?.code ?? 'unavailable',
          because: error?.message ?? String(error),
        })
      }
    }
    return Object.freeze({
      image: readiness(MODALITY.IMAGE),
      video: readiness(MODALITY.VIDEO),
      note: 'Readiness is measured against the registered providers, not asserted. A modality reported unavailable is refused by generate(), never approximated.',
    })
  }

  /** Request-shaped checks. Each refusal names the field, because "invalid request" is not actionable. */
  #validateRequest(request) {
    const modality = request?.modality
    if (!Object.values(MODALITY).includes(modality)) {
      throw new MediaWorkflowError(`modality must be 'image' or 'video', not '${modality}'`, 'invalid_request', { field: 'modality' })
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (prompt.length < 3 || prompt.length > 4_000) {
      throw new MediaWorkflowError('prompt must be 3–4000 characters', 'invalid_request', { field: 'prompt' })
    }
    if (request.count !== undefined && request.count !== 1) {
      throw new MediaWorkflowError('this build produces one artifact per request; ask for 1 and repeat the request rather than having the count silently reduced', 'invalid_request', { field: 'count' })
    }
    if (modality === MODALITY.IMAGE) {
      for (const field of ['width', 'height']) {
        if (request[field] !== undefined && !clampInt(request[field], 64, 4096)) {
          throw new MediaWorkflowError(`${field} must be an integer in 64–4096, not ${request[field]}`, 'invalid_request', { field })
        }
      }
    }
    if (modality === MODALITY.VIDEO) {
      if (request.durationMs !== undefined && !clampInt(request.durationMs, 500, 60_000)) {
        throw new MediaWorkflowError(`durationMs must be an integer in 500–60000, not ${request.durationMs}`, 'invalid_request', { field: 'durationMs' })
      }
    }
    return Object.freeze({
      modality,
      capability: MODALITY_CAPABILITY[modality],
      prompt,
      width: request.width ?? null,
      height: request.height ?? null,
      durationMs: request.durationMs ?? null,
      seed: request.seed ?? null,
      subject: request.subject ?? null,
    })
  }

  /** Translate a fabric refusal without flattening it: the code and the fabric's reason are both kept. */
  #unavailable(error, request) {
    this.#audit(`generate:${request.modality}`, 'denied', { code: error?.code, reason: error?.message }, request.subject)
    return new MediaWorkflowError(
      `${request.modality} generation is unavailable: ${error?.message ?? 'no provider could serve the request'}`,
      'unavailable',
      { fabricCode: error?.code ?? null, rejected: error?.detail?.rejected ?? null, missing: error?.detail?.missing ?? null },
    )
  }

  /**
   * Generate one artifact, or refuse.
   *
   * @param {object} request { modality, prompt, width?, height?, durationMs?, seed?, subject?, authority? }
   */
  async generate(request = {}) {
    const spec = this.#validateRequest(request)

    let routed
    try {
      routed = this.fabric.route([spec.capability], { allowExternal: this.allowExternal })
    } catch (error) {
      throw this.#unavailable(error, spec)
    }
    const binding = routed.chosen

    // An external provider means the prompt leaves this machine. That is an egress action and it
    // needs an authority minted from a user turn; the workflow cannot approve itself any more
    // than a tool's output can approve the next step.
    const external = binding.privacy === 'external'
    if (external) {
      if (!spec || request.authority === undefined || request.authority === null) {
        this.#audit(`generate:${spec.modality}`, 'denied', { code: 'authority_required', provider: binding.id }, spec.subject)
        throw new MediaWorkflowError(
          `'${binding.id}' is external, so generating means sending the prompt off this machine; a user turn must authorise it`,
          'authority_required',
          { provider: binding.id },
        )
      }
      if (!this.broker) {
        throw new MediaWorkflowError('an external provider was chosen but no authority broker is configured to verify the grant', 'authority_unverifiable', { provider: binding.id })
      }
    }

    const invoke = async ({ signal, progress } = {}) => {
      progress?.(10, 'requesting')
      const result = await binding.invoke({
        prompt: spec.prompt,
        modality: spec.modality,
        width: spec.width,
        height: spec.height,
        durationMs: spec.durationMs,
        seed: spec.seed,
        signal,
        provider: { id: binding.id, model: binding.model ?? null },
      })
      progress?.(80, 'returned')
      return result
    }

    // One place where the provider is called, whatever the privacy: queued when a queue exists,
    // wrapped in an authority when the provider is external.
    const runProvider = async (context = {}) => {
      // The queue extracts bytes by modality (`bytes` for an image, `video` for a clip), so the
      // provider result is normalised once here rather than the queue learning this workflow's
      // contract or this workflow learning the queue's.
      const call = async () => {
        const result = (await invoke(context)) ?? {}
        const bytes = bytesFrom(result)
        return spec.modality === MODALITY.VIDEO ? { ...result, video: bytes } : { ...result, bytes }
      }
      if (!external) return call()
      const justification = {
        text: spec.prompt,
        provenance: provenanceOf(spec.prompt, { kind: TRUST.USER_TURN, origin: spec.subject ?? 'unnamed-turn' }),
      }
      const { result } = await this.broker.execute({
        authority: request.authority,
        action: 'media.generate',
        risk: 'external',
        justifications: [justification],
        subject: spec.subject,
        invoke: () => call(),
      })
      return result
    }

    let raw
    let jobId = null
    try {
      if (this.jobs) {
        const queued = this.jobs.enqueue({
          kind: spec.modality,
          subject: spec.subject,
          params: { capability: spec.capability, provider: binding.id, width: spec.width, height: spec.height, durationMs: spec.durationMs },
          timeoutMs: spec.modality === MODALITY.VIDEO ? 600_000 : 120_000,
          run: runProvider,
        })
        jobId = queued.id
        const finished = await this.jobs.waitFor(queued.id, { timeoutMs: spec.modality === MODALITY.VIDEO ? 600_000 : 120_000 })
        if (finished.state !== 'succeeded') {
          throw new MediaWorkflowError(
            `the ${spec.modality} job ${finished.state}: ${finished.error ?? 'no reason recorded'}`,
            finished.errorCode === 'media_validation_failed' ? 'output_not_verified' : 'provider_failed',
            { jobId, state: finished.state, validation: finished.validation ?? null, refusedAs: finished.errorCode ?? null },
          )
        }
        raw = await this.jobs.readArtifact(queued.id)
        raw = { bytes: raw.bytes, artifact: raw.artifact }
      } else {
        raw = await runProvider({ progress: () => {} })
      }
    } catch (error) {
      if (error instanceof MediaWorkflowError) throw error
      this.#audit(`generate:${spec.modality}`, 'failure', { provider: binding.id, code: error?.code ?? null, error: error?.message }, spec.subject)
      // An authority refusal is a refusal of *this request*, and its code is the diagnosis the
      // caller needs (`action_not_granted` is actionable; `provider_failed` is not). It travels
      // through unchanged rather than being flattened into a provider error it did not come from.
      if (error?.name === 'AuthorityError' || String(error?.code ?? '').startsWith?.('authority')) {
        throw new MediaWorkflowError(error.message, error.code ?? 'authority_refused', { provider: binding.id, detail: error.detail ?? null })
      }
      throw new MediaWorkflowError(`${spec.modality} generation failed: ${error?.message ?? 'unknown error'}`, error?.code ?? 'provider_failed', { provider: binding.id })
    }

    const bytes = bytesFrom(raw)
    if (!bytes || bytes.byteLength === 0) {
      this.#audit(`verify:${spec.modality}`, 'failure', { provider: binding.id, reason: 'no bytes' }, spec.subject)
      throw new MediaWorkflowError(`${binding.id} returned no media bytes`, 'output_missing', { provider: binding.id })
    }
    if (bytes.byteLength > 512 * 1024 * 1024) {
      throw new MediaWorkflowError(`the artifact is ${bytes.byteLength}B, above the 512 MiB limit`, 'output_too_large', { byteLength: bytes.byteLength })
    }

    const artifact = this.#verify({ spec, binding, bytes, raw, jobId })
    this.#audit(`generate:${spec.modality}`, 'success', {
      provider: binding.id,
      digest: artifact.digest,
      byteLength: artifact.byteLength,
      format: artifact.format,
      verified: artifact.verified,
      unverified: artifact.unverified,
    }, spec.subject)
    return artifact
  }

  /** Measure the artifact and decide whether it may be described as what was asked for. */
  #verify({ spec, binding, bytes, raw, jobId }) {
    const refuse = (code, message, detail = {}) => {
      this.#audit(`verify:${spec.modality}`, 'denied', { provider: binding.id, code, ...detail }, spec.subject)
      return new MediaWorkflowError(message, code, { provider: binding.id, ...detail })
    }

    const expectedKind = spec.modality === MODALITY.VIDEO ? MEDIA_KINDS.VIDEO : MEDIA_KINDS.IMAGE
    // The queue validates too; doing it here as well is deliberate. The queue is optional, and a
    // workflow that trusts "something else checked it" is one refactor away from not checking it.
    const validation = validateMedia({ bytes, expectedKind })
    if (!validation.valid) {
      const justAnImage = validation.kind === MEDIA_KINDS.IMAGE && spec.modality === MODALITY.VIDEO
      throw refuse(
        justAnImage ? 'still_image_substitution' : 'output_not_verified',
        justAnImage
          ? `a video was requested and the provider returned a still ${validation.format} image; a still image is not a video and is not offered as one`
          : `the artifact is not a usable ${spec.modality}: ${validation.reasons.join('; ')}`,
        { reasons: validation.reasons, kind: validation.kind, format: validation.format },
      )
    }

    if (spec.modality === MODALITY.VIDEO && bytes.byteLength < 8 * 1024) {
      throw refuse('output_too_small', `the clip is ${bytes.byteLength}B, which is too small to be a generated video rather than a stub`, { byteLength: bytes.byteLength })
    }

    const unverified = []
    let width = null
    let height = null
    let durationMs = null
    let durationBecause = null

    if (spec.modality === MODALITY.IMAGE) {
      const measured = measureImage(bytes)
      if (!measured) {
        unverified.push(`dimensions (the ${validation.format} header is not parsed by this build)`)
      } else {
        width = measured.width
        height = measured.height
        if (spec.width !== null && width !== spec.width) {
          throw refuse('dimensions_mismatch', `the request asked for width ${spec.width} and the artifact is ${width}px wide`, { requested: spec.width, measured: width, axis: 'width' })
        }
        if (spec.height !== null && height !== spec.height) {
          throw refuse('dimensions_mismatch', `the request asked for height ${spec.height} and the artifact is ${height}px tall`, { requested: spec.height, measured: height, axis: 'height' })
        }
      }
    } else {
      const measured = measureVideo(bytes)
      if (!measured || measured.durationMs === null) {
        durationBecause = measured?.durationBecause ?? 'the container was not parsed'
        unverified.push(`duration (${durationBecause})`)
      } else {
        durationMs = measured.durationMs
        // A clip shorter than asked for is a different answer, not a rounding difference. The
        // tolerance is a quarter-second, which is below any duration a person asked for.
        const tolerance = 250
        if (spec.durationMs !== null && durationMs < spec.durationMs - tolerance) {
          throw refuse('duration_short', `the request asked for ${spec.durationMs}ms and the artifact is ${durationMs}ms`, { requested: spec.durationMs, measured: durationMs })
        }
      }
    }

    const digest = sha256(bytes)
    return Object.freeze({
      id: `media-${digest.slice(0, 16)}`,
      modality: spec.modality,
      prompt: spec.prompt,
      format: validation.format,
      mime: validation.mime,
      byteLength: bytes.byteLength,
      digest,
      width,
      height,
      durationMs,
      requested: Object.freeze({ width: spec.width, height: spec.height, durationMs: spec.durationMs }),
      provider: Object.freeze({ id: binding.id, kind: binding.kind, model: binding.model ?? null, privacy: binding.privacy }),
      verified: unverified.length ? VERIFICATION.PARTIAL : VERIFICATION.FULL,
      unverified: Object.freeze(unverified),
      jobId,
      seed: spec.seed,
      at: this.now(),
    })
  }
}
