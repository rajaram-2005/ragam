import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateMedia, assertGenuineVideo, sniffMedia, looksLikeTextPayload, decodeBase64Media, extractImageBytes, MEDIA_KINDS } from '../src/media/validate.mjs'
import { MediaJobQueue, JOB_STATES } from '../src/media/jobs.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

// --- real fixture bytes ---------------------------------------------------

/** A minimal ISO-BMFF header ('ftyp' at offset 4) padded to a believable size. */
function fakeMp4(bytes = 16 * 1024) {
  const buffer = Buffer.alloc(bytes)
  if (bytes >= 4) buffer.writeUInt32BE(Math.min(32, bytes), 0) // box size
  if (bytes >= 8) buffer.write('ftyp', 4, 'ascii')
  if (bytes >= 12) buffer.write('isom', 8, 'ascii') // major brand
  if (bytes >= 16) buffer.writeUInt32BE(512, 12) // minor version
  if (bytes >= 20) buffer.write('moov', 16, 'ascii')
  // Non-zero filler so it is not an all-zero stub.
  for (let i = 32; i < bytes; i += 1) buffer[i] = (i * 7) % 251
  return new Uint8Array(buffer)
}

/** Fixtures guard their header offsets so a deliberately tiny buffer still builds. */
function fakePng(bytes = 4096) {
  const buffer = Buffer.alloc(bytes)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  signature.copy(buffer, 0, 0, Math.min(signature.length, bytes))
  if (bytes >= 16) buffer.write('IHDR', 12, 'ascii')
  for (let i = 32; i < bytes; i += 1) buffer[i] = (i * 11) % 251
  return new Uint8Array(buffer)
}

function fakeJpeg(bytes = 4096) {
  const buffer = Buffer.alloc(bytes)
  buffer[0] = 0xff
  buffer[1] = 0xd8
  buffer[2] = 0xff
  buffer[3] = 0xe0
  for (let i = 4; i < bytes; i += 1) buffer[i] = (i * 13) % 251
  return new Uint8Array(buffer)
}

function fakeWebm(bytes = 16 * 1024) {
  const buffer = Buffer.alloc(bytes)
  const signature = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
  signature.copy(buffer, 0, 0, Math.min(signature.length, bytes))
  for (let i = 4; i < bytes; i += 1) buffer[i] = (i * 5) % 251
  return new Uint8Array(buffer)
}

// --- validation -----------------------------------------------------------

test('container sniffing identifies real formats from bytes alone', () => {
  assert.equal(sniffMedia(fakeMp4()).format, 'mp4')
  assert.equal(sniffMedia(fakeMp4()).kind, MEDIA_KINDS.VIDEO)
  assert.equal(sniffMedia(fakePng()).format, 'png')
  assert.equal(sniffMedia(fakeJpeg()).format, 'jpeg')
  assert.equal(sniffMedia(fakeWebm()).format, 'webm')
  assert.equal(sniffMedia(fakeWebm()).kind, MEDIA_KINDS.VIDEO)
  assert.equal(sniffMedia(new TextEncoder().encode('{"error":"quota"}')), null)
})

test('a valid MP4 passes video validation', () => {
  const result = validateMedia({ bytes: fakeMp4(), expectedKind: MEDIA_KINDS.VIDEO, claimedContentType: 'video/mp4' })
  assert.equal(result.valid, true, result.reasons.join('; '))
  assert.equal(result.format, 'mp4')
  assert.equal(result.mime, 'video/mp4')
  assert.equal(result.contentTypeMatches, true)
  assert.equal(result.byteLength, 16 * 1024)
})

test('a PNG is accepted as an image and rejected as a video', () => {
  const asImage = validateMedia({ bytes: fakePng(), expectedKind: MEDIA_KINDS.IMAGE, claimedContentType: 'image/png' })
  assert.equal(asImage.valid, true)
  const asVideo = validateMedia({ bytes: fakePng(), expectedKind: MEDIA_KINDS.VIDEO, claimedContentType: 'video/mp4' })
  assert.equal(asVideo.valid, false)
  assert.ok(asVideo.reasons.some((reason) => /png \(image\), but video/.test(reason)))
})

test('a lying Content-Type is caught by comparing header claim to bytes', () => {
  const result = validateMedia({ bytes: fakeJpeg(), expectedKind: MEDIA_KINDS.IMAGE, claimedContentType: 'video/mp4' })
  // The bytes are a valid image, but the provider's claim is wrong.
  assert.equal(result.contentTypeMatches, false)
  assert.ok(result.reasons.some((reason) => /claimed 'video\/mp4' but bytes are image\/jpeg/.test(reason)))
})

test('an error body masquerading as media is refused', () => {
  const errorBody = new TextEncoder().encode(JSON.stringify({ error: { message: 'quota exceeded', type: 'rate_limit_error' } }))
  assert.equal(looksLikeTextPayload(errorBody), true)
  const result = validateMedia({ bytes: errorBody, expectedKind: MEDIA_KINDS.IMAGE })
  assert.equal(result.valid, false)
  assert.ok(result.reasons.some((reason) => /no recognised media container/.test(reason)))
  assert.ok(result.reasons.some((reason) => /appears to be text\/JSON\/HTML/.test(reason)))
})

test('an HTML error page is refused as an image', () => {
  const html = new TextEncoder().encode('<!doctype html><html><body>502 Bad Gateway</body></html>')
  const result = validateMedia({ bytes: html, expectedKind: MEDIA_KINDS.IMAGE })
  assert.equal(result.valid, false)
  assert.ok(looksLikeTextPayload(html))
})

test('empty and undersized payloads are refused', () => {
  assert.equal(validateMedia({ bytes: new Uint8Array(0), expectedKind: MEDIA_KINDS.IMAGE }).valid, false)
  assert.ok(validateMedia({ bytes: new Uint8Array(0), expectedKind: MEDIA_KINDS.IMAGE }).reasons.includes('payload is empty'))
  const tiny = validateMedia({ bytes: fakePng(4), expectedKind: MEDIA_KINDS.IMAGE, minBytes: 1024 })
  assert.equal(tiny.valid, false)
  assert.ok(tiny.reasons.some((reason) => /below the 1024B minimum/.test(reason)))
})

test('oversized payloads are refused', () => {
  const result = validateMedia({ bytes: fakeMp4(2048), expectedKind: MEDIA_KINDS.VIDEO, maxBytes: 1024 })
  assert.equal(result.valid, false)
  assert.ok(result.reasons.some((reason) => /exceeds the 1024B maximum/.test(reason)))
})

test('THE KEY GUARD: a still image is never accepted as a generated video', () => {
  const validation = validateMedia({ bytes: fakeJpeg(), expectedKind: MEDIA_KINDS.IMAGE, claimedContentType: 'image/jpeg' })
  assert.equal(validation.valid, true, 'it is a perfectly good image')
  const verdict = assertGenuineVideo(validation)
  assert.equal(verdict.genuine, false)
  assert.ok(verdict.problems.some((problem) => /still jpeg image, not a video/.test(problem)))
})

test('a too-small video stub is rejected as not genuine', () => {
  // Passes signature validation but is only 64 bytes: not a real clip.
  const tiny = validateMedia({ bytes: fakeMp4(64), expectedKind: MEDIA_KINDS.VIDEO, claimedContentType: 'video/mp4', minBytes: 1 })
  assert.equal(tiny.valid, true)
  const verdict = assertGenuineVideo(tiny, { minBytes: 8 * 1024 })
  assert.equal(verdict.genuine, false)
  assert.ok(verdict.problems.some((problem) => /too small to be a genuine generated clip/.test(problem)))
})

test('a real-sized MP4 is accepted as a genuine video', () => {
  const validation = validateMedia({ bytes: fakeMp4(64 * 1024), expectedKind: MEDIA_KINDS.VIDEO, claimedContentType: 'video/mp4' })
  const verdict = assertGenuineVideo(validation)
  assert.equal(verdict.genuine, true, verdict.problems.join('; '))
  assert.deepEqual(verdict.problems, [])
})

test('base64 image decoding works and rejects junk', () => {
  const b64 = Buffer.from(fakePng(2048)).toString('base64')
  const decoded = decodeBase64Media(b64)
  assert.equal(decoded.byteLength, 2048)
  assert.equal(sniffMedia(decoded).format, 'png')
  assert.equal(decodeBase64Media(''), null)
  assert.equal(decodeBase64Media(null), null)
})

test('extractImageBytes handles b64_json and defers url entries', () => {
  const entry = { b64_json: Buffer.from(fakePng(1024)).toString('base64') }
  assert.equal(extractImageBytes(entry).byteLength, 1024)
  // A url entry must be fetched by the caller through the egress guard, not here.
  assert.equal(extractImageBytes({ url: 'https://cdn.example.com/a.png' }), null)
  assert.equal(extractImageBytes(null), null)
})

// --- job queue ------------------------------------------------------------

async function withQueue(fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'aetheris-media-'))
  const ledger = new AuditLedger(':memory:')
  const events = []
  const queue = new MediaJobQueue({ storageDir: dir, ledger, onEvent: (event) => events.push(event), ...options })
  try {
    return await fn({ queue, dir, ledger, events })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a successful image job validates, stores and hashes the artifact', async () => {
  await withQueue(async ({ queue, dir, ledger }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.IMAGE,
      params: { prompt: 'a diagram' },
      run: async ({ progress }) => {
        progress(50, 'generating')
        return { bytes: fakePng(4096), contentType: 'image/png' }
      },
    })
    // A free worker picks the job up synchronously, so it is already running by the
    // time enqueue() returns; what matters is that it is not yet terminal.
    assert.ok([JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.VALIDATING].includes(job.state), `unexpected initial state ${job.state}`)
    assert.equal(job.terminal, false)
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.SUCCEEDED)
    assert.equal(finished.progress, 100)
    assert.equal(finished.artifact.format, 'png')
    assert.equal(finished.artifact.mime, 'image/png')
    assert.equal(finished.artifact.byteLength, 4096)
    assert.match(finished.artifact.sha256, /^[0-9a-f]{64}$/)
    assert.equal(finished.validation.valid, true)

    // The bytes really are on disk and really are the ones we produced.
    const onDisk = new Uint8Array(await readFile(join(dir, finished.artifact.path)))
    assert.equal(onDisk.byteLength, 4096)
    assert.equal(sniffMedia(onDisk).format, 'png')

    // readArtifact round-trips.
    const read = await queue.readArtifact(job.id)
    assert.equal(read.bytes.byteLength, 4096)

    assert.ok(ledger.query({ category: 'media' }).some((event) => event.action === 'succeed:image'))
  })
})

test('a job returning a JSON error body fails validation and is never marked succeeded', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.IMAGE,
      run: async () => ({ bytes: new TextEncoder().encode('{"error":{"message":"provider down"}}'), contentType: 'image/png' }),
    })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.FAILED)
    assert.match(finished.error, /output validation failed/)
    assert.equal(finished.artifact, null, 'nothing may be stored for an invalid artifact')
  })
})

test('a video job that receives a still image fails rather than lying', async () => {
  await withQueue(async ({ queue, ledger }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.VIDEO,
      run: async () => ({ video: fakeJpeg(64 * 1024), contentType: 'image/jpeg' }),
    })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.FAILED)
    assert.match(finished.error, /no recognised media container|png \(image\), but video|still jpeg image|jpeg \(image\), but video/)
    assert.equal(finished.artifact, null)
    assert.ok(ledger.query({ category: 'media' }).some((event) => event.action === 'reject:video'))
  })
})

test('a genuine MP4 passes the video pipeline', async () => {
  await withQueue(async ({ queue }) => {
    const bytes = fakeMp4(96 * 1024)
    const job = queue.enqueue({
      kind: MEDIA_KINDS.VIDEO,
      run: async ({ progress }) => {
        progress(10, 'submitted')
        progress(80, 'awaiting provider')
        return { video: bytes, contentType: 'video/mp4', platform: 'pollinations', modelId: 'nova-reel' }
      },
    })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.SUCCEEDED, finished.error ?? '')
    assert.equal(finished.artifact.format, 'mp4')
    assert.equal(finished.artifact.mime, 'video/mp4')
    assert.equal(finished.artifact.byteLength, bytes.byteLength)
  })
})

test('a tiny video stub is rejected as not genuine', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.VIDEO, run: async () => ({ video: fakeMp4(200), contentType: 'video/mp4' }) })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.FAILED)
    assert.match(finished.error, /not a genuine generated video/)
    assert.match(finished.error, /too small/)
  })
})

test('cancelling a running job aborts the provider call and records the cancellation', async () => {
  await withQueue(async ({ queue, ledger }) => {
    let abortSeen = false
    const job = queue.enqueue({
      kind: MEDIA_KINDS.VIDEO,
      run: async ({ signal }) => {
        // Simulate a provider that holds the request open for minutes.
        await new Promise((resolvePromise, reject) => {
          const timer = setTimeout(resolvePromise, 30_000)
          signal.addEventListener('abort', () => {
            abortSeen = true
            clearTimeout(timer)
            const error = new Error('aborted')
            error.code = 'aborted'
            reject(error)
          })
        })
        return { video: fakeMp4() }
      },
    })
    // Let it start running.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    assert.equal(queue.get(job.id).state, JOB_STATES.RUNNING)

    const cancelled = queue.cancel(job.id, 'user changed their mind')
    assert.equal(cancelled.cancelled, true)
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.CANCELLED)
    assert.equal(finished.artifact, null, 'a cancelled job must not produce an artifact')
    assert.equal(abortSeen, true, 'the AbortSignal must actually reach the provider call')
    assert.ok(ledger.query({ category: 'media' }).some((event) => event.action === 'cancel:video'))
  })
})

test('a job stays QUEUED while the single worker is busy', async () => {
  await withQueue(async ({ queue }) => {
    const blocker = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => { await new Promise((r) => setTimeout(r, 150)); return { bytes: fakePng(2048), contentType: 'image/png' } } })
    const waiting = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => ({ bytes: fakePng(2048), contentType: 'image/png' }) })
    assert.equal(queue.get(blocker.id).state, JOB_STATES.RUNNING)
    assert.equal(queue.get(waiting.id).state, JOB_STATES.QUEUED, 'a queued job must be observably queued')
    await queue.waitFor(waiting.id, { timeoutMs: 5000 })
    assert.equal(queue.get(waiting.id).state, JOB_STATES.SUCCEEDED)
  }, { concurrency: 1 })
})

test('cancelling a queued job prevents it from ever running', async () => {
  await withQueue(async ({ queue }) => {
    let ran = false
    // Occupy the single worker.
    const blocker = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => { await new Promise((r) => setTimeout(r, 120)); ran = true; return { bytes: fakePng(2048), contentType: 'image/png' } } })
    const waiting = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => { ran = true; return { bytes: fakePng(2048), contentType: 'image/png' } } })
    assert.equal(queue.get(waiting.id).state, JOB_STATES.QUEUED)
    const result = queue.cancel(waiting.id)
    assert.equal(result.cancelled, true)
    await queue.waitFor(blocker.id, { timeoutMs: 5000 })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
    assert.equal(queue.get(waiting.id).state, JOB_STATES.CANCELLED)
    assert.equal(ran, true, 'the blocker did run; the cancelled job did not')
  }, { concurrency: 1 })
})

test('cancelling an already-terminal job is a no-op, not an error', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => ({ bytes: fakePng(2048), contentType: 'image/png' }) })
    await queue.waitFor(job.id, { timeoutMs: 5000 })
    const result = queue.cancel(job.id)
    assert.equal(result.cancelled, false)
    assert.match(result.reason, /already terminal/)
  })
})

test('a job that exceeds its timeout is marked timed_out', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.VIDEO,
      timeoutMs: 80,
      run: async () => { await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)); return { video: fakeMp4() } },
    })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.TIMED_OUT)
    assert.match(finished.error, /exceeded 80ms/)
  })
})

test('a provider error is surfaced with its code and retry hint', async () => {
  await withQueue(async ({ queue, ledger }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.IMAGE,
      run: async () => {
        const error = new Error('quota_exceeded')
        error.code = 'quota_exceeded'
        error.status = 429
        error.retryAfterMs = 60_000
        throw error
      },
    })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.FAILED)
    assert.equal(finished.errorCode, 'quota_exceeded')
    assert.equal(finished.retryAfterMs, 60_000)
    assert.ok(ledger.query({ category: 'media' }).some((event) => event.action === 'fail:image'))
  })
})

test('a job returning nothing fails with a clear reason', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => null })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    assert.equal(finished.state, JOB_STATES.FAILED)
    assert.match(finished.error, /no media bytes/)
  })
})

test('concurrency is bounded', async () => {
  await withQueue(async ({ queue }) => {
    let inFlight = 0
    let peak = 0
    const jobs = Array.from({ length: 6 }, () =>
      queue.enqueue({
        kind: MEDIA_KINDS.IMAGE,
        run: async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
          inFlight -= 1
          return { bytes: fakePng(2048), contentType: 'image/png' }
        },
      }),
    )
    await Promise.all(jobs.map((job) => queue.waitFor(job.id, { timeoutMs: 10_000 })))
    assert.equal(peak, 2, 'concurrency must be capped at the configured value')
    assert.equal(jobs.every((job) => queue.get(job.id).state === JOB_STATES.SUCCEEDED), true)
  }, { concurrency: 2 })
})

test('the stored path cannot escape the media directory', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => ({ bytes: fakePng(2048), contentType: 'image/png' }) })
    await queue.waitFor(job.id, { timeoutMs: 5000 })
    // Corrupt the record to simulate a traversal attempt.
    queue.jobs.get(job.id).artifact.path = '../../../etc/passwd'
    await assert.rejects(() => queue.readArtifact(job.id), /escapes the media storage directory/)
  })
})

test('artifact deletion removes the file from disk', async () => {
  await withQueue(async ({ queue, dir }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => ({ bytes: fakePng(2048), contentType: 'image/png' }) })
    const finished = await queue.waitFor(job.id, { timeoutMs: 5000 })
    const path = join(dir, finished.artifact.path)
    await readFile(path) // exists
    const result = await queue.deleteArtifact(job.id)
    assert.equal(result.deleted, true)
    await assert.rejects(() => readFile(path))
    assert.equal(queue.get(job.id).artifact, null)
    assert.equal((await queue.deleteArtifact(job.id)).deleted, false)
  })
})

test('the public job view never exposes the AbortController', async () => {
  await withQueue(async ({ queue }) => {
    const job = queue.enqueue({ kind: MEDIA_KINDS.IMAGE, run: async () => ({ bytes: fakePng(2048), contentType: 'image/png' }) })
    const view = queue.get(job.id)
    const serialized = JSON.stringify(view)
    assert.equal(serialized.includes('AbortController'), false)
    assert.equal(serialized.includes('controller'), false)
    assert.equal(view.terminal, false)
    assert.ok(Array.isArray(view.history))
  })
})

test('invalid job specs are rejected at enqueue', async () => {
  await withQueue(async ({ queue }) => {
    assert.throws(() => queue.enqueue({ kind: 'audio', run: async () => {} }), /invalid media kind/)
    assert.throws(() => queue.enqueue({ kind: MEDIA_KINDS.IMAGE }), /requires a run\(\) function/)
    assert.throws(() => queue.get('does-not-exist'), /unknown media job/)
    assert.throws(() => queue.cancel('does-not-exist'), /unknown media job/)
  })
})

test('progress events are emitted and bounded to 0..100', async () => {
  await withQueue(async ({ queue, events }) => {
    const job = queue.enqueue({
      kind: MEDIA_KINDS.IMAGE,
      run: async ({ progress }) => {
        progress(-50, 'negative')
        progress(500, 'overflow')
        progress(42, 'real')
        return { bytes: fakePng(2048), contentType: 'image/png' }
      },
    })
    await queue.waitFor(job.id, { timeoutMs: 5000 })
    const progressEvents = events.filter((event) => event.type === 'job_progress' && event.jobId === job.id)
    assert.ok(progressEvents.length >= 3)
    assert.ok(progressEvents.every((event) => event.progress >= 0 && event.progress <= 100))
    assert.equal(progressEvents[0].progress, 0)
    assert.equal(progressEvents[1].progress, 100)
    assert.equal(progressEvents[2].progress, 42)
  })
})
