import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SupabaseKnowledgeStore } from '../src/storage/supabase-knowledge-store.mjs'

const ACCOUNT = 'a7f83961-b0cd-4af4-903b-8c2a551fa489'
const OTHER = 'b7f83961-b0cd-4af4-903b-8c2a551fa489'
const DOCUMENT = 'c7f83961-b0cd-4af4-903b-8c2a551fa489'
const CHUNK = 'd7f83961-b0cd-4af4-903b-8c2a551fa489'

function documentRow(overrides = {}) {
  return {
    id: DOCUMENT, account_id: ACCOUNT, title: 'Runbook', source_label: null, mime: 'text/plain',
    sha256: 'a'.repeat(64), content_key: 'runbook text', size_bytes: 12, classification: 'internal',
    status: 'active', chunk_count: 1, ingested_at: 100, updated_at: 100, meta: {}, ...overrides,
  }
}

function chunkRow(overrides = {}) {
  return {
    id: CHUNK, account_id: ACCOUNT, document_id: DOCUMENT, idx: 0, text: 'Runbook text',
    start_offset: 0, end_offset: 12, token_count: 2, ...overrides,
  }
}

function fakeClient(respond) {
  const calls = []
  return {
    calls,
    request: async (endpoint, options) => {
      calls.push({ endpoint, options })
      return respond(endpoint, options, calls.length - 1)
    },
  }
}

test('document listing always filters the owning account, bounds results, and maps schema fields', async () => {
  const client = fakeClient(() => [documentRow()])
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT })
  const listed = await store.listDocuments({ limit: 25 })
  assert.equal(listed[0].id, DOCUMENT)
  assert.equal(listed[0].owner, ACCOUNT)
  assert.equal(listed[0].sourcePath, null)
  const query = new URLSearchParams(client.calls[0].options.query)
  assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
  assert.equal(query.get('status'), 'eq.active')
  assert.equal(query.get('order'), 'ingested_at.desc')
  assert.equal(query.get('limit'), '25')

  const leaking = new SupabaseKnowledgeStore({ client: fakeClient(() => [documentRow({ account_id: OTHER })]), accountId: ACCOUNT })
  await assert.rejects(leaking.listDocuments(), { code: 'supabase_knowledge_rows_invalid' })
})

test('document identity and deduplication reads are account-scoped and reject duplicate primary matches', async () => {
  const client = fakeClient((_endpoint, options) => {
    const query = new URLSearchParams(options.query)
    assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
    return [documentRow()]
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT })
  assert.equal((await store.getDocument(DOCUMENT)).sha256, 'a'.repeat(64))
  assert.equal((await store.findBySha256('a'.repeat(64))).id, DOCUMENT)
  assert.equal((await store.findByContentKey('runbook text')).id, DOCUMENT)
  await assert.rejects(new SupabaseKnowledgeStore({ client: fakeClient(() => [documentRow(), documentRow({ id: CHUNK })]), accountId: ACCOUNT }).getDocument(DOCUMENT), {
    code: 'supabase_knowledge_rows_limit',
  })
})

test('document, chunks and ACL grants are inserted by one atomic RPC with calculated digest and immutable ownership', async () => {
  const text = 'Runbook text'
  const client = fakeClient((endpoint, options) => {
    assert.equal(endpoint, 'rest/v1/rpc/ragam_knowledge_insert_document')
    const body = options.body
    assert.equal(body.p_account_id, ACCOUNT)
    assert.equal(body.p_now, 900)
    assert.equal(body.p_document.sha256, createHash('sha256').update(text).digest('hex'))
    assert.equal(body.p_document.size_bytes, Buffer.byteLength(text))
    assert.equal(body.p_document.chunk_count, 1)
    assert.equal(body.p_chunks.length, 1)
    assert.equal(body.p_principals[0], ACCOUNT)
    return { ok: true, duplicate: false, document: { ...body.p_document, account_id: ACCOUNT }, chunk_ids: [body.p_chunks[0].id] }
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT, now: () => 900 })
  const result = await store.insertDocument({
    title: ' Runbook ', text, contentKey: 'runbook text', owner: ACCOUNT, principals: [ACCOUNT, ACCOUNT],
    chunks: [{ index: 0, text, start: 0, end: text.length, tokenCount: 2 }],
  })
  assert.equal(result.duplicate, false)
  assert.equal(result.document.title, 'Runbook')
  assert.equal(result.document.owner, ACCOUNT)
  assert.equal(result.chunkIds.length, 1)
  await assert.rejects(store.insertDocument({ title: 'Runbook', text, contentKey: 'x', owner: OTHER, chunks: [{ index: 0, text }] }), {
    code: 'supabase_knowledge_owner_invalid',
  })
  assert.equal(client.calls.length, 1, 'invalid ownership must fail before a network write')
})

test('a database deduplication match is returned as-is without pretending a new document was inserted', async () => {
  const client = fakeClient((_endpoint, options) => ({ ok: true, duplicate: true, reason: 'identical content hash', document: { ...options.body.p_document, id: DOCUMENT, account_id: ACCOUNT } }))
  const result = await new SupabaseKnowledgeStore({ client, accountId: ACCOUNT }).insertDocument({
    title: 'Runbook', text: 'Runbook text', contentKey: 'runbook text', owner: ACCOUNT,
    chunks: [{ index: 0, text: 'Runbook text' }],
  })
  assert.equal(result.duplicate, true)
  assert.equal(result.document.id, DOCUMENT)
  assert.equal(result.reason, 'identical content hash')
  assert.deepEqual(result.chunkIds, [])
})

test('chunk reads filter by both account and document, and reject over-limit partial scans', async () => {
  const client = fakeClient((endpoint, options) => {
    assert.equal(endpoint, 'rest/v1/ragam_knowledge_chunks')
    const query = new URLSearchParams(options.query)
    assert.equal(query.get('account_id'), `eq.${ACCOUNT}`)
    assert.equal(query.get('document_id'), `eq.${DOCUMENT}`)
    assert.equal(query.get('order'), 'idx.asc')
    return [chunkRow()]
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT })
  assert.equal((await store.getChunks(DOCUMENT))[0].text, 'Runbook text')
  const leaking = new SupabaseKnowledgeStore({ client: fakeClient(() => [chunkRow({ account_id: OTHER })]), accountId: ACCOUNT })
  await assert.rejects(leaking.getChunks(DOCUMENT), { code: 'supabase_knowledge_chunks_invalid' })
})

test('index hydration selects only active documents and preserves citation metadata', async () => {
  const client = fakeClient((_endpoint, options) => {
    const params = new URLSearchParams(options.query)
    assert.equal(params.get('account_id'), `eq.${ACCOUNT}`)
    assert.equal(params.get('ragam_knowledge_documents.status'), 'eq.active')
    assert.match(params.get('select'), /ragam_knowledge_documents!inner/)
    return [{ ...chunkRow(), ragam_knowledge_documents: { title: 'Runbook', classification: 'internal', source_label: 'guide.md', mime: 'text/plain', status: 'active', sha256: 'a'.repeat(64) } }]
  })
  const rows = await new SupabaseKnowledgeStore({ client, accountId: ACCOUNT }).allChunks()
  assert.equal(rows[0].title, 'Runbook')
  assert.equal(rows[0].source_path, 'guide.md')
  assert.equal(rows[0].owner, ACCOUNT)
})

test('ACL grants, revocations and access checks stay scoped to this account', async () => {
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('/ragam_knowledge_acl') && options.method === 'POST') {
      assert.equal(options.body.account_id, ACCOUNT)
      assert.equal(options.body.document_id, DOCUMENT)
      return [{ account_id: ACCOUNT }]
    }
    if (endpoint.endsWith('/ragam_knowledge_acl') && options.method === 'GET') return [
      { account_id: ACCOUNT, document_id: DOCUMENT, principal: ACCOUNT, permission: 'admin', granted_at: 10 },
    ]
    if (endpoint.endsWith('/ragam_knowledge_acl') && options.method === 'DELETE') return [{ document_id: DOCUMENT }]
    throw new Error(`unexpected endpoint ${endpoint}`)
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT, now: () => 100 })
  assert.equal(await store.grant(DOCUMENT, ACCOUNT, 'admin'), true)
  assert.equal(await store.canRead(DOCUMENT, ACCOUNT), true)
  assert.equal(await store.canRead(DOCUMENT, OTHER), false)
  assert.equal(await store.revoke(DOCUMENT, OTHER), true)
  assert.ok(client.calls.every((call) => !call.options.query || new URLSearchParams(call.options.query).get('account_id') === `eq.${ACCOUNT}` || call.options.method === 'POST'))
})

test('embeddings round-trip exact float32 bytes and account ownership', async () => {
  const vector = [0.25, -1.5, 3.75]
  const client = fakeClient((endpoint, options) => {
    if (options.method === 'POST') {
      assert.equal(endpoint, 'rest/v1/ragam_knowledge_embeddings')
      assert.equal(options.body.account_id, ACCOUNT)
      assert.ok(options.body.vector.startsWith('\\x'))
      return null
    }
    return [{ account_id: ACCOUNT, chunk_id: CHUNK, model: 'test-embedder', dim: 3, vector: `\\x${Buffer.from(new Float32Array(vector).buffer).toString('hex')}` }]
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT, now: () => 100 })
  assert.equal(await store.putEmbedding(CHUNK, 'test-embedder', vector), true)
  const stored = await store.getEmbeddings('test-embedder')
  assert.equal(stored[0].chunkId, CHUNK)
  assert.deepEqual([...stored[0].vector], vector)
})

test('purge and retention use the transactional deletion RPC with the account identifier', async () => {
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('ragam_knowledge_documents')) return [documentRow()]
    assert.equal(endpoint, 'rest/v1/rpc/ragam_knowledge_purge_document')
    assert.equal(options.body.p_account_id, ACCOUNT)
    assert.equal(options.body.p_now, 1000)
    return { deleted: true, documentId: DOCUMENT, chunks: 1, aclRows: 1, embeddings: 0 }
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT, now: () => 1000 })
  assert.equal((await store.purgeDocument(DOCUMENT)).deleted, true)
  const retained = await store.applyRetention({ olderThanMs: 100 })
  assert.equal(retained.purged, 1)
  assert.equal(retained.cutoff, 900)
  assert.equal(client.calls.filter((call) => call.endpoint.endsWith('ragam_knowledge_purge_document')).length, 2)
})

test('index runs and exact account statistics use bounded insert and a dedicated count RPC', async () => {
  const client = fakeClient((endpoint, options) => {
    if (endpoint.endsWith('/ragam_knowledge_index_runs') && options.method === 'POST') {
      assert.equal(options.body.account_id, ACCOUNT)
      return [{ ...options.body }]
    }
    if (endpoint.endsWith('ragam_knowledge_stats')) {
      assert.equal(options.body.p_account_id, ACCOUNT)
      return { documents: 1, chunks: 2, embeddings: 0, aclRows: 1, deletions: 0, bytesIndexed: 20 }
    }
    return [{ account_id: ACCOUNT, id: DOCUMENT, at: 100, kind: 'rebuild' }]
  })
  const store = new SupabaseKnowledgeStore({ client, accountId: ACCOUNT, now: () => 100 })
  assert.match(await store.recordIndexRun({ kind: 'rebuild', documents: 1, chunks: 2, durationMs: 3, outcome: 'success' }), /^[0-9a-f-]{36}$/)
  assert.equal((await store.indexRuns())[0].kind, 'rebuild')
  assert.equal((await store.stats()).bytesIndexed, 20)
})

test('invalid account, row ids, classifications, and malformed remote records fail closed', async () => {
  assert.throws(() => new SupabaseKnowledgeStore({ client: fakeClient(() => []), accountId: 'not-an-id' }), { code: 'supabase_account_id_invalid' })
  const store = new SupabaseKnowledgeStore({ client: fakeClient(() => [documentRow({ classification: 'secret' })]), accountId: ACCOUNT })
  await assert.rejects(store.getDocument(DOCUMENT), { code: 'supabase_knowledge_document_invalid' })
  await assert.rejects(store.getDocument('../other-account'), { code: 'supabase_knowledge_id_invalid' })
  await assert.rejects(store.listDocuments({ status: 'deleted' }), { code: 'supabase_knowledge_status_invalid' })
})
