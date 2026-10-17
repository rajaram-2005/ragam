// Phase 8: image and video workflows.
//
// The acceptance criteria this phase is held to are derived from the standing rules rather than
// invented for the tests:
//
//   1. "Do not falsely advertise a capability that the available model or hardware cannot
//      deliver." → a modality nothing can serve is reported unavailable and refused by name.
//   2. "Do not represent a still image, static preview or synthetic placeholder as a completed
//      generated video." → a video request answered with an image is refused, always.
//   3. "Do not report success without execution evidence." → a delivered artifact's properties
//      are measured from its bytes, and anything not measured is named as unverified.
//
// The fixtures below are real containers — a PNG with correct chunk CRCs and an MP4 with a real
// `ftyp`/`moov`/`mvhd` — built in the test, so the measurement code is reading actual headers
// rather than a mock of one. The *provider* is a stub: this build has none, which is the point of
// criterion 1 and is stated in the docs rather than implied.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

import { MediaWorkflow, MediaWorkflowError, measureImage, measureVideo, MODALITY, VERIFICATION } from '../src/media/workflow.mjs'
import { MediaJobQueue } from '../src/media/jobs.mjs'
import { AuthorityBroker, TRUST } from '../src/mcp/authority.mjs'
import { ProviderFabric, PROVIDER_KINDS } from '../src/adaptive/providers.mjs'
import { createEgressGuard, RUNTIME_POLICIES } from '../src/policy/egress.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

// --- real fixtures ---------------------------------------------------------------------

/** A PNG with correct CRCs. Not a pretty picture; a well-formed one. */
function png(width, height) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour + alpha
  // One row of zeroed scanlines is enough for a header test and keeps the fixture honest:
  // the bytes after IHDR are real zlib-framed image data as far as the signature is concerned.
  const idat = Buffer.alloc(64, 0)
  return Buffer.from(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

/** An MP4 with a real ftyp + moov/mvhd, padded with a `free` box past the 8 KiB stub threshold. */
function mp4({ durationMs = 3_000, timescale = 1_000, padBytes = 12_000 } = {}) {
  const box = (type, payload) => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(payload.length + 8)
    header.write(type, 4, 'ascii')
    return Buffer.concat([header, payload])
  }
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isom', 'ascii'))
  const mvhdPayload = Buffer.alloc(100)
  mvhdPayload[0] = 0 // version 0
  // version+flags(4) creation(4) modification(4) timescale(4) duration(4) — offsets from the payload.
  mvhdPayload.writeUInt32BE(timescale, 12)
  mvhdPayload.writeUInt32BE(Math.round((durationMs / 1000) * timescale), 16)
  const moov = box('moov', box('mvhd', mvhdPayload))
  const free = box('free', Buffer.alloc(padBytes, 0))
  return Buffer.from(Buffer.concat([ftyp, moov, free]))
}

const IMAGE_ONLY = ['image.generate']
const VIDEO_ONLY = ['video.generate']

const guard = () => createEgressGuard({ policy: RUNTIME_POLICIES.STRICT_OFFLINE })

/** A fabric with one local provider whose output is whatever the test says. */
function fabricWith({ id, kind = PROVIDER_KINDS.IN_PROCESS, capabilities, output, privacy = null, calls = [] } = {}) {
  const fabric = new ProviderFabric({ guard: guard() })
  fabric.register({
    id,
    kind,
    capabilities,
    ...(privacy ? { privacy } : {}),
    provider: { probe: async () => ({ availability: 'ready', detail: 'test double' }) },
    invoke: async (request) => {
      calls.push(request)
      return typeof output === 'function' ? output(request) : output
    },
  })
  return { fabric, calls }
}

async function workflowWith(options) {
  const { fabric, calls } = fabricWith(options)
  await fabric.probe()
  return { workflow: new MediaWorkflow({ fabric, ledger: options.ledger }), calls }
}

const PNG_512 = png(512, 512)

// ---------------------------------------------------------------------------------------
// 1. Acceptance: what cannot be served is refused by name, not approximated.
// ---------------------------------------------------------------------------------------

test('acceptance: a modality nothing can serve is reported unavailable and refused by name', async () => {
  // The real state of this build: no image or video provider is registered.
  const empty = new ProviderFabric({ guard: guard() })
  const workflow = new MediaWorkflow({ fabric: empty })

  const readiness = workflow.describe()
  assert.equal(readiness.image.available, false)
  assert.equal(readiness.video.available, false)
  assert.equal(readiness.image.code, 'no_capability')
  assert.match(readiness.image.because, /image\.generate/)
  assert.match(readiness.video.because, /video\.generate/)
  assert.match(readiness.note, /never approximated/)

  for (const modality of [MODALITY.IMAGE, MODALITY.VIDEO]) {
    await assert.rejects(
      () => workflow.generate({ modality, prompt: 'a lighthouse at dusk' }),
      (error) => error instanceof MediaWorkflowError
        && error.code === 'unavailable'
        && error.detail.fabricCode === 'no_capability'
        && /will not substitute/.test(error.message),
    )
  }

  // A request that is only *partly* servable is refused too: an image provider does not answer
  // a video request, and nothing is substituted.
  const { workflow: imageOnly } = await workflowWith({ id: 'local.painter', capabilities: IMAGE_ONLY, output: () => ({ bytes: PNG_512 }) })
  await assert.rejects(
    () => imageOnly.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk' }),
    (error) => error.code === 'unavailable' && error.detail.fabricCode === 'no_capability',
  )
  assert.equal(imageOnly.describe().image.available, true)
  assert.equal(imageOnly.describe().video.available, false)
})

test('the refusal is audited, with the fabric code that caused it', async () => {
  const ledger = new AuditLedger()
  const empty = new ProviderFabric({ guard: guard() })
  const workflow = new MediaWorkflow({ fabric: empty, ledger })
  await assert.rejects(() => workflow.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse', subject: 'turn-9' }))
  const rows = ledger.query({ category: 'media.workflow', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'generate:image')
  assert.equal(rows[0].outcome, 'denied')
  assert.equal(rows[0].detail.code, 'no_capability')
  assert.equal(rows[0].subject, 'turn-9')
})

// ---------------------------------------------------------------------------------------
// 2. Acceptance: a still image is never delivered as a video.
// ---------------------------------------------------------------------------------------

test('acceptance: a video request answered with a still image is refused, never delivered', async () => {
  const { workflow } = await workflowWith({ id: 'local.liar', capabilities: VIDEO_ONLY, output: () => ({ bytes: PNG_512, contentType: 'video/mp4' }) })
  await assert.rejects(
    () => workflow.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk', durationMs: 3_000 }),
    (error) => error instanceof MediaWorkflowError
      && error.code === 'still_image_substitution'
      && /a still png image; a still image is not a video/i.test(error.message)
      && /not offered as one/.test(error.message),
  )

  // The same guard through the job queue, which has its own video check: two independent layers
  // refuse, and the workflow's error says which layer's code it is carrying.
  const dir = mkdtempSync(join(tmpdir(), 'media-workflow-'))
  try {
    const { fabric } = fabricWith({ id: 'local.liar', capabilities: VIDEO_ONLY, output: () => ({ bytes: PNG_512 }) })
    await fabric.probe()
    const jobs = new MediaJobQueue({ storageDir: dir, ledger: null })
    const queued = new MediaWorkflow({ fabric, jobs })
    await assert.rejects(
      () => queued.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk', durationMs: 3_000 }),
      (error) => ['output_not_verified', 'still_image_substitution', 'provider_failed'].includes(error.code)
        && /video|still|genuine/i.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stub too small to be a clip is refused as a stub, not measured as a video', async () => {
  const tiny = mp4({ padBytes: 0 })
  const { workflow } = await workflowWith({ id: 'local.stub', capabilities: VIDEO_ONLY, output: () => ({ bytes: tiny }) })
  await assert.rejects(
    () => workflow.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk' }),
    (error) => error.code === 'output_too_small' && /too small to be a generated video/.test(error.message),
  )
})

// ---------------------------------------------------------------------------------------
// 3. Acceptance: what is delivered was measured, and what was not measured is named.
// ---------------------------------------------------------------------------------------

test('acceptance: a delivered artifact is measured before it is described', async () => {
  const { workflow } = await workflowWith({ id: 'local.painter', capabilities: IMAGE_ONLY, output: () => ({ bytes: PNG_512, contentType: 'image/png' }) })
  const artifact = await workflow.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk', width: 512, height: 512 })

  assert.equal(artifact.modality, 'image')
  assert.equal(artifact.format, 'png')
  assert.equal(artifact.mime, 'image/png')
  assert.equal(artifact.width, 512)
  assert.equal(artifact.height, 512)
  assert.equal(artifact.byteLength, PNG_512.byteLength)
  assert.match(artifact.digest, /^[0-9a-f]{64}$/)
  assert.equal(artifact.verified, VERIFICATION.FULL, 'every property the caller asked for was measured')
  assert.deepEqual(artifact.unverified, [])
  assert.equal(artifact.provider.id, 'local.painter')
  assert.equal(artifact.provider.privacy, 'local-only')
  assert.deepEqual(artifact.requested, { width: 512, height: 512, durationMs: null })

  // The digest is the digest of the bytes, so two calls that return the same bytes are the same
  // artifact id — a property the caller can check without trusting this module.
  const again = await workflow.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk' })
  assert.equal(again.digest, artifact.digest)
  assert.equal(again.id, artifact.id)
})

test('an artifact of the wrong size is refused, not quietly delivered as the requested size', async () => {
  const { workflow } = await workflowWith({ id: 'local.painter', capabilities: IMAGE_ONLY, output: () => ({ bytes: png(256, 256) }) })
  await assert.rejects(
    () => workflow.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse', width: 512, height: 512 }),
    (error) => error.code === 'dimensions_mismatch'
      && error.detail.axis === 'width'
      && /asked for width 512 and the artifact is 256px wide/.test(error.message),
  )
  // With no size asked for, the measured size is reported rather than invented.
  const measured = await workflow.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse' })
  assert.equal(measured.width, 256)
  assert.equal(measured.height, 256)
})

test('a video is measured for duration, and a short clip is refused', async () => {
  const { workflow } = await workflowWith({ id: 'local.filmer', capabilities: VIDEO_ONLY, output: () => ({ bytes: mp4({ durationMs: 1_000 }) }) })
  await assert.rejects(
    () => workflow.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk', durationMs: 5_000 }),
    (error) => error.code === 'duration_short' && error.detail.measured === 1_000,
  )
  const clip = await workflow.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk', durationMs: 1_000 })
  assert.equal(clip.durationMs, 1_000)
  assert.equal(clip.verified, VERIFICATION.FULL)
})

test('a property this build cannot measure is reported as unverified, never assumed', async () => {
  // A WebM header is recognised as a video but its duration lives in an EBML tree this build does
  // not parse. The deliverable says so instead of reporting `verified: full`.
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(9_000, 1)])
  const { workflow } = await workflowWith({ id: 'local.filmer', capabilities: VIDEO_ONLY, output: () => ({ bytes: webm }) })
  const clip = await workflow.generate({ modality: MODALITY.VIDEO, prompt: 'a lighthouse at dusk', durationMs: 2_000 })
  assert.equal(clip.format, 'webm')
  assert.equal(clip.verified, VERIFICATION.PARTIAL)
  assert.equal(clip.durationMs, null)
  assert.equal(clip.unverified.length, 1)
  assert.match(clip.unverified[0], /duration/)
  assert.match(clip.unverified[0], /EBML/)
})

// ---------------------------------------------------------------------------------------
// 4. The rules that make the workflow safe to point at a cloud provider.
// ---------------------------------------------------------------------------------------

test('an external provider needs an authority minted from a user turn', async () => {
  const online = createEgressGuard({ policy: RUNTIME_POLICIES.ONLINE_ENABLED, onlineAllowlist: ['*'] })
  const fabric = new ProviderFabric({ guard: online, policy: RUNTIME_POLICIES.ONLINE_ENABLED })
  fabric.register({
    id: 'cloud.painter',
    kind: PROVIDER_KINDS.EXTERNAL,
    capabilities: IMAGE_ONLY,
    provider: { probe: async () => ({ availability: 'ready', detail: 'stub endpoint' }) },
    invoke: async () => ({ bytes: PNG_512 }),
  })
  await fabric.probe({ allowExternal: true })

  const broker = new AuthorityBroker({})
  // Without the installation's opt-in the cloud provider is not eligible, and the reason says so.
  const closed = new MediaWorkflow({ fabric, broker })
  assert.equal(closed.describe().image.available, false)
  await assert.rejects(
    () => closed.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk' }),
    (error) => error.code === 'unavailable' && error.detail.fabricCode === 'no_eligible_provider',
  )

  // With the opt-in the provider is eligible — and still needs a grant for every request.
  const wf = new MediaWorkflow({ fabric, broker, allowExternal: true })
  assert.equal(wf.describe().image.available, true)
  assert.equal(wf.describe().image.requiresAuthority, true)
  await assert.rejects(
    () => wf.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk' }),
    (error) => error.code === 'authority_required' && /sending the prompt off this machine/.test(error.message),
  )

  // With a user-turn authority naming the action, the call proceeds and the prompt is the
  // justification. A grant that does not name 'media.generate' is refused by the broker.
  const turn = { id: 'turn-8', source: TRUST.USER_TURN, text: 'draw me a lighthouse' }
  const wrongGrant = broker.grant({ turn, request: 'something else', actions: ['fs.read'], riskCeiling: 'external' })
  await assert.rejects(
    () => wf.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk', authority: wrongGrant, subject: 'turn-8' }),
    (error) => error.code === 'action_not_granted',
  )
  const grant = broker.grant({ turn, request: 'draw me a lighthouse', actions: ['media.generate'], riskCeiling: 'external' })
  const artifact = await wf.generate({ modality: MODALITY.IMAGE, prompt: 'a lighthouse at dusk', authority: grant, subject: 'turn-8' })
  assert.equal(artifact.provider.privacy, 'external')
  assert.equal(artifact.width, 512)
})

test('a malformed request is refused by field, before anything is routed or run', async () => {
  const { workflow, calls } = await workflowWith({ id: 'local.painter', capabilities: IMAGE_ONLY, output: () => ({ bytes: PNG_512 }) })
  const cases = [
    [{ modality: 'audio', prompt: 'a lighthouse' }, /modality/],
    [{ modality: 'image', prompt: '  ' }, /prompt/],
    [{ modality: 'image', prompt: 'a lighthouse', width: 32 }, /width/],
    [{ modality: 'image', prompt: 'a lighthouse', height: 8_192 }, /height/],
    [{ modality: 'image', prompt: 'a lighthouse', count: 4 }, /count/],
  ]
  for (const [request, pattern] of cases) {
    await assert.rejects(
      () => workflow.generate(request),
      (error) => error.code === 'invalid_request' && pattern.test(error.message),
      JSON.stringify(request),
    )
  }
  assert.deepEqual(calls, [], 'an invalid request must not reach the provider')
})

// --- the measurement helpers, at their edges ------------------------------------------

test('header measurement reports what the bytes say, and nothing when it cannot', () => {
  assert.deepEqual(measureImage(png(640, 480)), { format: 'png', width: 640, height: 480 })
  // A JPEG carrying a SOF0 segment: height at +5, width at +7 of the marker.
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, // SOF0, height 480, width 640
    0x00, 0x00, 0x00, 0x00,
  ])
  assert.deepEqual(measureImage(jpeg), { format: 'jpeg', width: 640, height: 480 })
  assert.equal(measureImage(Buffer.from('not an image')), null)
  assert.equal(measureImage(Buffer.alloc(0)), null)

  const clip = measureVideo(mp4({ durationMs: 2_500 }))
  assert.equal(clip.format, 'mp4')
  assert.equal(clip.durationMs, 2_500)
  assert.equal(measureVideo(Buffer.from('nope'))?.durationMs ?? null, null)
  const webm = measureVideo(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]))
  assert.equal(webm.format, 'webm')
  assert.equal(webm.durationMs, null)
  assert.match(webm.durationBecause, /EBML/)
})
