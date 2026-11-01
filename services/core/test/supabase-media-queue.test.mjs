import test from 'node:test'
import assert from 'node:assert/strict'
import { SupabaseMediaQueue } from '../src/storage/supabase-media-queue.mjs'

const ACCOUNT = '74007a44-19b0-4ba7-a9a6-a417338b0182'
const OTHER = '84007a44-19b0-4ba7-a9a6-a417338b0182'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z4QAAAABJRU5ErkJggg==', 'base64')

function fixture() {
  const jobs = new Map(), artifacts = new Map(), objects = new Map(), calls = []
  const client = {
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options })
      const [pathname, queryString = ''] = endpoint.split('?')
      const params = new URLSearchParams(options.query || queryString)
      if (pathname === 'rest/v1/ragam_media_jobs' && options.method === 'POST') {
        jobs.set(options.body.id, { ...options.body })
        return [structuredClone(options.body)]
      }
      if (pathname === 'rest/v1/ragam_media_jobs' && options.method === 'PATCH') {
        const id = params.get('id')?.slice(3), owner = params.get('account_id')?.slice(3)
        const row = jobs.get(id)
        if (!row || row.account_id !== owner) return []
        Object.assign(row, options.body)
        return [structuredClone(row)]
      }
      if (pathname === 'rest/v1/ragam_media_jobs' && options.method === 'GET') {
        const id = params.get('id')?.slice(3), owner = params.get('account_id')?.slice(3)
        const rows = [...jobs.values()].filter((row) => (!id || row.id === id) && (!owner || row.account_id === owner))
        return rows.slice(0, Number(params.get('limit') || 50)).map((row) => structuredClone(row))
      }
      if (pathname === 'rest/v1/ragam_media_artifacts' && options.method === 'POST') {
        artifacts.set(options.body.id, { ...options.body })
        return [structuredClone(options.body)]
      }
      if (pathname === 'rest/v1/ragam_media_artifacts' && options.method === 'GET') {
        const owner = params.get('account_id')?.slice(3)
        const filter = params.get('id')
        const selected = filter?.startsWith('in.(') ? filter.slice(4, -1).split(',') : []
        return [...artifacts.values()].filter((row) => row.account_id === owner && selected.includes(row.id)).map((row) => structuredClone(row))
      }
      if (pathname === 'rest/v1/ragam_media_artifacts' && options.method === 'DELETE') {
        const id = params.get('id')?.slice(3)
        artifacts.delete(id)
        return null
      }
      if (pathname.startsWith('storage/v1/object/ragam-media/') && options.method === 'POST') {
        objects.set(decodeURIComponent(pathname.split('/').slice(4).join('/')), new Uint8Array(options.body))
        return null
      }
      if (pathname.startsWith('storage/v1/object/ragam-media/') && options.method === 'GET') {
        return objects.get(decodeURIComponent(pathname.split('/').slice(4).join('/')))
      }
      if (pathname === 'storage/v1/object/ragam-media' && options.method === 'DELETE') {
        for (const key of options.body.prefixes) objects.delete(key)
        return null
      }
      if (pathname === 'rest/v1/ragam_media_jobs' && options.method === 'DELETE') {
        jobs.delete(params.get('id')?.slice(3))
        return null
      }
      throw new Error(`Unexpected ${options.method || 'GET'} ${endpoint}`)
    },
  }
  return { client, jobs, artifacts, objects, calls }
}

test('media output is run synchronously, validated, stored privately and scoped to its account', async () => {
  const db = fixture()
  const queue = new SupabaseMediaQueue({ client: db.client, accountId: ACCOUNT, now: () => 1_800_000_000_000 })
  const job = await queue.enqueue({ kind: 'image', params: { prompt: 'a red circle' }, run: async () => ({ bytes: PNG, contentType: 'image/png' }) })
  assert.equal(job.state, 'succeeded')
  assert.equal(job.terminal, true)
  assert.equal(job.artifact.byteLength, PNG.byteLength)
  assert.equal(await queue.has(job.id), true)
  assert.equal((await queue.list({ kind: 'image' })).length, 1)
  const fetched = await queue.readArtifact(job.id)
  assert.deepEqual(Buffer.from(fetched.bytes), PNG)
  assert.equal(fetched.artifact.sha256, job.artifact.sha256)
  assert.equal(db.objects.size, 1)

  const otherQueue = new SupabaseMediaQueue({ client: db.client, accountId: OTHER })
  assert.equal(await otherQueue.has(job.id), false)
  await assert.rejects(otherQueue.get(job.id), (error) => error.code === 'media_job_not_found' && error.status === 404)

  assert.deepEqual(await queue.remove(job.id), { removed: true, id: job.id })
  assert.equal(await queue.has(job.id), false)
  assert.equal(db.objects.size, 0)
  assert.equal(db.artifacts.size, 0)
})

test('abandoned running jobs are finalized as timed out on a later request', async () => {
  const db = fixture()
  let now = 1_800_000_000_000
  const queue = new SupabaseMediaQueue({ client: db.client, accountId: ACCOUNT, now: () => now, timeoutMs: 1_000 })
  const job = await queue.enqueue({ kind: 'image', run: async () => ({ bytes: PNG, contentType: 'image/png' }) })
  const record = db.jobs.get(job.id)
  record.state = 'running'
  record.finished_at = null
  record.updated_at = now - 20_000
  const stale = await queue.get(job.id)
  assert.equal(stale.state, 'timed_out')
  assert.equal(stale.errorCode, 'media_function_interrupted')
  assert.equal(stale.terminal, true)
})

test('media failures are recorded as terminal failures without leaking provider error text', async () => {
  const db = fixture()
  const queue = new SupabaseMediaQueue({ client: db.client, accountId: ACCOUNT })
  const job = await queue.enqueue({ kind: 'image', run: async () => { throw new Error('provider secret response') } })
  assert.equal(job.state, 'failed')
  assert.equal(job.errorCode, 'provider_failed')
  assert.equal(job.error.includes('provider secret response'), false)
  assert.equal(db.artifacts.size, 0)
})

test('client disconnect aborts provider work and persists a cancelled terminal job', async () => {
  const db = fixture()
  const queue = new SupabaseMediaQueue({ client: db.client, accountId: ACCOUNT })
  const controller = new AbortController()
  controller.abort(new Error('caller left'))
  const job = await queue.enqueue({ kind: 'image', signal: controller.signal, run: async ({ signal }) => {
    if (signal.aborted) throw signal.reason
    return { bytes: PNG, contentType: 'image/png' }
  } })
  assert.equal(job.state, 'cancelled')
  assert.equal(job.errorCode, 'media_request_aborted')
  assert.equal(db.objects.size, 0)
})

test('media output validation rejects non-image data and oversized artifacts', async () => {
  const db = fixture()
  const queue = new SupabaseMediaQueue({ client: db.client, accountId: ACCOUNT, maxArtifactBytes: 1024 })
  const invalid = await queue.enqueue({ kind: 'image', run: async () => ({ bytes: Buffer.from('not an image') }) })
  assert.equal(invalid.state, 'failed')
  assert.equal(invalid.errorCode, 'media_validation_failed')
  const huge = await queue.enqueue({ kind: 'image', run: async () => ({ bytes: Buffer.alloc(2048) }) })
  assert.equal(huge.state, 'failed')
  assert.equal(huge.errorCode, 'media_output_too_large')
})
