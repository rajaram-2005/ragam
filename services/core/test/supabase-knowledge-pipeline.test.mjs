import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { SupabaseKnowledgeStore } from '../src/storage/supabase-knowledge-store.mjs'
import { SupabaseKnowledgePipeline } from '../src/knowledge/supabase-pipeline.mjs'
import { createSupabaseContextStoreFactory } from '../src/online/supabase-context.mjs'

const ACCOUNT = 'a7f83961-b0cd-4af4-903b-8c2a551fa489'

function createHarness() {
  const state = { documents: [], chunks: [], acl: [], indexRuns: [], deletions: [] }
  const calls = []
  const client = {
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options })
      const params = new URLSearchParams(options.query)
      if (endpoint === 'rest/v1/rpc/ragam_knowledge_insert_document') {
        const { p_account_id: accountId, p_document: document, p_chunks: chunks, p_principals: principals } = options.body
        const prior = state.documents.find((row) => row.account_id === accountId && row.status === 'active'
          && (row.sha256 === document.sha256 || row.content_key === document.content_key))
        if (prior) return { ok: true, duplicate: true, reason: prior.sha256 === document.sha256 ? 'identical content hash' : 'identical normalized content', document: { ...prior }, chunk_ids: [] }
        const row = { ...document, account_id: accountId }
        state.documents.push(row)
        const created = chunks.map((chunk) => ({ ...chunk, account_id: accountId, document_id: row.id }))
        state.chunks.push(...created)
        for (const principal of principals) state.acl.push({
          account_id: accountId, document_id: row.id, principal, permission: 'read', granted_at: row.ingested_at,
        })
        return { ok: true, duplicate: false, document: { ...row }, chunk_ids: created.map((chunk) => chunk.id) }
      }
      if (endpoint === 'rest/v1/rpc/ragam_knowledge_stats') {
        const accountId = options.body.p_account_id
        const documents = state.documents.filter((row) => row.account_id === accountId && row.status === 'active')
        const ids = new Set(documents.map((row) => row.id))
        return {
          documents: documents.length,
          chunks: state.chunks.filter((row) => row.account_id === accountId && ids.has(row.document_id)).length,
          embeddings: 0,
          aclRows: state.acl.filter((row) => row.account_id === accountId).length,
          deletions: state.deletions.filter((row) => row.account_id === accountId).length,
          bytesIndexed: documents.reduce((sum, row) => sum + row.size_bytes, 0),
        }
      }
      if (endpoint === 'rest/v1/rpc/ragam_knowledge_purge_document') {
        const { p_account_id: accountId, p_document_id: documentId, p_reason: reason, p_requested_by: requestedBy, p_now: at } = options.body
        const index = state.documents.findIndex((row) => row.account_id === accountId && row.id === documentId)
        if (index < 0) return { deleted: false, documentId, chunks: 0, aclRows: 0, embeddings: 0 }
        state.documents.splice(index, 1)
        const chunks = state.chunks.filter((row) => row.account_id === accountId && row.document_id === documentId).length
        const aclRows = state.acl.filter((row) => row.account_id === accountId && row.document_id === documentId).length
        state.chunks = state.chunks.filter((row) => row.document_id !== documentId)
        state.acl = state.acl.filter((row) => row.document_id !== documentId)
        state.deletions.push({ account_id: accountId, document_id: documentId, chunks, acl_rows: aclRows, reason, requested_by: requestedBy, at })
        return { deleted: true, documentId, chunks, aclRows, embeddings: 0 }
      }
      if (endpoint === 'rest/v1/ragam_knowledge_index_runs' && options.method === 'POST') {
        state.indexRuns.push({ ...options.body })
        return [{ ...options.body }]
      }
      if (endpoint === 'rest/v1/ragam_knowledge_chunks' && options.method === 'GET') {
        const data = state.chunks.filter((row) => row.account_id === ACCOUNT
          && (!params.has('document_id') || row.document_id === params.get('document_id').slice(3)))
        if (!params.get('select')?.includes('ragam_knowledge_documents!inner')) return data.map((row) => ({ ...row }))
        return data.filter((row) => state.documents.some((doc) => doc.account_id === row.account_id && doc.id === row.document_id && doc.status === 'active'))
          .map((row) => {
            const doc = state.documents.find((item) => item.id === row.document_id)
            return {
              ...row,
              ragam_knowledge_documents: {
                title: doc.title, classification: doc.classification, source_label: doc.source_label,
                mime: doc.mime, status: doc.status, sha256: doc.sha256,
              },
            }
          })
      }
      if (endpoint === 'rest/v1/ragam_knowledge_acl' && options.method === 'GET') {
        const accountFilter = params.get('account_id')
        const docFilter = params.get('document_id')
        return state.acl.filter((row) => row.account_id === (accountFilter?.slice(3) ?? ACCOUNT)
          && (!docFilter || row.document_id === docFilter.slice(3))).map((row) => ({ ...row }))
      }
      if (endpoint === 'rest/v1/ragam_knowledge_documents' && options.method === 'GET') {
        return state.documents.filter((row) => row.account_id === ACCOUNT
          && (!params.has('id') || row.id === params.get('id').slice(3))
          && (!params.has('status') || row.status === params.get('status').slice(3))).map((row) => ({ ...row }))
      }
      throw new Error(`unexpected request: ${options.method} ${endpoint}`)
    },
  }
  return { state, calls, client }
}

function createPipeline(harness, ledger = null) {
  const store = new SupabaseKnowledgeStore({ client: harness.client, accountId: ACCOUNT, now: () => 1_800_000_000_000 })
  return new SupabaseKnowledgePipeline({ store, ledger, defaultPrincipal: ACCOUNT })
}

const policyText = 'Emergency response procedures require operators to record the incident identifier, notify the safety lead, and preserve the original audit evidence before recovery begins.'

test('async pipeline initializes, persists documents, and returns grounded citations with stable source offsets', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  const startup = await pipeline.initialize()
  assert.equal(startup.chunks, 0)
  const ingested = await pipeline.ingestText({ title: 'Emergency response', text: policyText, sourcePath: 'policies/incident.md', classification: 'confidential' })
  assert.equal(ingested.duplicate, false)
  assert.equal(ingested.chunks, 1)
  const result = await pipeline.search({ query: 'incident identifier safety lead', topK: 4 })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].text, policyText)
  assert.deepEqual(result.results[0].citation, {
    documentId: ingested.documentId,
    chunkId: ingested.chunkIds[0],
    title: 'Emergency response',
    sourcePath: 'policies/incident.md',
    chunkIndex: 0,
    startOffset: 0,
    endOffset: policyText.length,
    classification: 'confidential',
    sha256: createHash('sha256').update(policyText).digest('hex'),
  })
  assert.equal(result.accessControlled, true)
  assert.equal(result.method, 'bm25')
  assert.equal(harness.state.documents[0].account_id, ACCOUNT)
})

test('fresh search snapshots observe writes from another warm serverless instance', async () => {
  const harness = createHarness()
  const first = createPipeline(harness)
  const second = createPipeline(harness)
  await Promise.all([first.initialize(), second.initialize()])
  assert.equal((await second.search({ query: 'incident identifier safety lead' })).results.length, 0)
  await first.ingestText({ title: 'Emergency response', text: policyText })
  assert.equal((await second.search({ query: 'incident identifier safety lead' })).results.length, 1)
})

test('bulk ACL filtering and classification restrictions fail closed for ungranted principals', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  await pipeline.ingestText({ title: 'Shared procedure', text: policyText, classification: 'internal', principals: ['team:ops', 'team:write'] })
  await pipeline.ingestText({ title: 'Account-only procedure', text: 'The incident bridge is opened by the duty coordinator.', classification: 'restricted' })
  harness.state.acl.find((grant) => grant.principal === 'team:write').permission = 'write'
  assert.equal((await pipeline.search({ query: 'incident procedure', principal: 'team:ops' })).results.length, 1)
  assert.equal((await pipeline.search({ query: 'incident procedure', principal: 'untrusted:user' })).results.length, 0)
  assert.equal((await pipeline.search({ query: 'incident procedure', principal: 'team:write' })).results.length, 0, 'write-only ACLs do not grant read access')
  const restricted = await pipeline.search({ query: 'incident procedure', classifications: ['restricted'] })
  assert.equal(restricted.results.length, 1)
  assert.equal(restricted.results[0].citation.classification, 'restricted')
  const aclReads = harness.calls.filter((call) => call.endpoint === 'rest/v1/ragam_knowledge_acl' && call.options.method === 'GET')
  assert.ok(aclReads.every((call) => new URLSearchParams(call.options.query).get('account_id') === `eq.${ACCOUNT}`))
  assert.ok(aclReads.length >= 3, 'search filtering uses one bounded bulk ACL scan, never a per-chunk request')
})

test('deduplication reports the existing document and does not claim newly inserted chunks', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  const first = await pipeline.ingestText({ title: 'Emergency response', text: policyText })
  const duplicate = await pipeline.ingestText({ title: 'Copied emergency response', text: policyText })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.documentId, first.documentId)
  assert.equal(duplicate.reason, 'identical content hash')
  assert.equal(harness.state.documents.length, 1)
  assert.equal(harness.state.chunks.length, 1)
})

test('purge removes persistent content and the refreshed index stops citing the document', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  const ingested = await pipeline.ingestText({ title: 'Emergency response', text: policyText })
  const deleted = await pipeline.purgeDocument(ingested.documentId, { reason: 'user requested removal' })
  assert.equal(deleted.deleted, true)
  assert.equal((await pipeline.search({ query: 'incident identifier safety lead' })).results.length, 0)
  assert.equal(harness.state.chunks.length, 0)
  assert.equal(harness.state.deletions.length, 1)
  assert.equal(harness.state.deletions[0].requested_by, ACCOUNT)
  assert.equal(harness.state.deletions[0].reason, 'user requested removal')
})

test('grounded context preserves evidence-only instructions and the highest evidence classification', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  await pipeline.ingestText({ title: 'Emergency response', text: policyText, classification: 'confidential' })
  const context = await pipeline.buildGroundedContext({ query: 'incident identifier safety lead' })
  assert.equal(context.hasEvidence, true)
  assert.equal(context.evidenceCount, 1)
  assert.equal(context.dataClass, 'confidential')
  assert.match(context.promptContext, /Use ONLY the evidence blocks/)
  assert.match(context.promptContext, /\[E1\]/)
  assert.equal(context.citations[0].ref, 'E1')
  const empty = await pipeline.buildGroundedContext({ query: 'unrelated astronomy question' })
  assert.equal(empty.hasEvidence, false)
  assert.match(empty.promptContext, /do not invent procedure/)
})

test('statistics stay exact and the explicit index rebuild is recorded as persistent run metadata', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  await pipeline.ingestText({ title: 'Emergency response', text: policyText })
  const result = await pipeline.rebuildIndex({ kind: 'manual' })
  const stats = await pipeline.stats()
  assert.equal(result.chunks, 1)
  assert.equal(stats.store.documents, 1)
  assert.equal(stats.store.chunks, 1)
  assert.equal(stats.store.bytesIndexed, Buffer.byteLength(policyText))
  assert.equal(stats.index.documents, 1)
  assert.equal(harness.state.indexRuns.at(-1).kind, 'manual')
  assert.equal(harness.state.indexRuns.at(-1).outcome, 'success')
})

test('ingestion rejects wrong account ownership and malformed principals before any persistence write', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  await assert.rejects(pipeline.ingestText({ title: 'Nope', text: policyText, owner: randomUUID() }), { code: 'supabase_knowledge_owner_invalid' })
  await assert.rejects(pipeline.ingestText({ title: 'Nope', text: policyText, principals: ['ok', 4] }), /principals must be a list/)
  await assert.rejects(pipeline.ingestText({ title: 'Nope', text: '  ' }), { reason: 'empty_document' })
  assert.equal(harness.state.documents.length, 0)
})

test('search validates query, classifications, and topK instead of returning ambiguous partial answers', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  await assert.rejects(pipeline.search({ query: ' ' }), /non-empty query/)
  await assert.rejects(pipeline.search({ query: 'words', topK: 0 }), /topK must be an integer/)
  await assert.rejects(pipeline.search({ query: 'words', classifications: 'confidential' }), /classifications must be a list/)
})

test('OnlineApp context factory receives durable account stores after async index initialization', async () => {
  const harness = createHarness()
  let mediaAccount = null
  const factory = createSupabaseContextStoreFactory({
    client: harness.client,
    mediaFactory: async ({ accountId }) => {
      mediaAccount = accountId
      return { enqueue() {}, has() { return false }, readArtifact() {}, close() {} }
    },
  })
  const context = await factory({ accountId: ACCOUNT })
  assert.equal(context.accountId, ACCOUNT)
  assert.ok(context.memory)
  assert.ok(context.knowledge instanceof SupabaseKnowledgePipeline)
  assert.equal(context.knowledge.initialized, true)
  assert.equal(mediaAccount, ACCOUNT)
  assert.equal(harness.state.indexRuns.length, 1)
  assert.equal(harness.state.indexRuns[0].kind, 'startup')
  await context.memory.close()
  await context.knowledge.close()

  assert.throws(() => createSupabaseContextStoreFactory({ client: harness.client }), /mediaFactory must provide/)
})

test('retrieval evaluation returns deterministic ranking metrics from the real index', async () => {
  const harness = createHarness()
  const pipeline = createPipeline(harness)
  await pipeline.initialize()
  const inserted = await pipeline.ingestText({ title: 'Emergency response', text: policyText })
  const result = await pipeline.evaluateRetrieval([{ query: 'incident identifier safety lead', relevant: [inserted.documentId] }], { k: 3 })
  assert.equal(result.summary.cases, 1)
  assert.equal(result.summary.recallAtK, 1)
  assert.equal(result.summary.mrr, 1)
  assert.equal(result.perCase[0].reciprocalRank, 1)
})
