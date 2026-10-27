import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnowledgePipeline, validateFileType, IngestionRejectedError, longestCommonTokenRun } from '../src/knowledge/pipeline.mjs'
import { Bm25Index, reciprocalRankFusion, retrievalMetrics } from '../src/knowledge/bm25.mjs'
import { chunkText, tokenize, stemTokens, contentKey, splitSentences } from '../src/knowledge/text.mjs'
import { AuditLedger } from '../src/audit/ledger.mjs'

const POLICY_DOC = `Battery Management System Safety Policy

Section 1 — Thermal runaway threshold.
The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius.
This threshold is mandatory for all EV converter platforms shipped after 2025.

Section 2 — Isolation monitoring.
Isolation resistance must remain above 500 ohms per volt. A reading below 100 ohms per volt
requires an immediate service shutdown and a documented root cause analysis.

Section 3 — Firmware release approval.
No firmware may be flashed to a production vehicle without sign-off from the safety board.
The sign-off record must reference the test report identifier and the build checksum.`

const API_DOC = `REST API Reference

POST /v1/charge/sessions starts a charging session. The request body requires a vehicle
identifier and a connector identifier. The response contains a session identifier.

GET /v1/charge/sessions/{id} returns the session state, energy delivered in kilowatt hours,
and the last heartbeat timestamp. Sessions expire after 30 minutes without a heartbeat.`

// --- BM25 correctness ----------------------------------------------------

test('BM25 ranks a document containing the query terms first', () => {
  const index = new Bm25Index()
  index.add('a', 'the cat sat on the mat')
  index.add('b', 'dogs are loyal animals')
  index.add('c', 'cat behaviour and cat nutrition')
  const results = index.search('cat')
  assert.equal(results[0].docId, 'c', 'the doc with higher term frequency should win')
  assert.equal(results[1].docId, 'a')
  assert.equal(results.find((entry) => entry.docId === 'b'), undefined)
})

test('BM25 IDF penalises ubiquitous terms and rewards rare ones', () => {
  const index = new Bm25Index()
  index.add('d1', 'alpha common common common')
  index.add('d2', 'beta common common')
  index.add('d3', 'gamma common')
  // 'common' appears in all 3 → low IDF; 'alpha' appears in 1 → high IDF.
  assert.ok(index.idf('common') < index.idf('alpha'), 'rare terms must carry more information')
  assert.ok(index.idf('alpha') > 0)
})

test('BM25 is deterministic and length-normalised', () => {
  const index = new Bm25Index()
  index.add('short', 'contactor threshold')
  index.add('long', `contactor threshold ${'filler words '.repeat(200)}`)
  const first = index.search('contactor threshold')
  const second = index.search('contactor threshold')
  assert.deepEqual(first.map((r) => r.docId), second.map((r) => r.docId), 'repeated queries must return identical ranking')
  assert.equal(first[0].docId, 'short', 'b=0.75 length normalisation should favour the concise doc')
})

test('BM25 add() is idempotent per docId and remove() cleans postings', () => {
  const index = new Bm25Index()
  index.add('x', 'unique term here')
  index.add('x', 'completely different content')
  assert.equal(index.size, 1)
  assert.equal(index.search('unique').length, 0, 're-indexing must drop the old terms')
  assert.ok(index.df.has('different'))
  index.remove('x')
  assert.equal(index.size, 0)
  assert.equal(index.df.size, 0, 'no dangling document frequencies')
  assert.equal(index.totalLength, 0)
})

test('BM25 search returns nothing for an empty query or empty corpus', () => {
  const index = new Bm25Index()
  index.add('a', 'content')
  assert.deepEqual(index.search(''), [])
  assert.deepEqual(index.search('   '), [])
  assert.deepEqual(new Bm25Index().search('content'), [])
})

test('hyphenated identifiers are findable by their parts', () => {
  // Regression: the tokenizer keeps `zephyr-9` as one token, so a part-only
  // query used to miss the document entirely (live E2E: memory search for
  // `ZEPHYR` found nothing). stemTokens now indexes the parts too.
  const index = new Bm25Index()
  index.add('memo', 'The E2E project codename is ZEPHYR-9.')
  index.add('other', 'Unrelated notes about gardening tools and soil.')
  assert.deepEqual(index.search('ZEPHYR').map((hit) => hit.docId), ['memo'])
  assert.deepEqual(index.search('zephyr-9').map((hit) => hit.docId), ['memo'])
  assert.deepEqual(stemTokens('klyvaron-pro-lm'), ['klyvaron-pro-lm', 'klyvaron', 'pro', 'lm'])
  // Citation offsets are untouched: tokenize still yields whole tokens.
  assert.deepEqual(tokenize('ZEPHYR-9'), ['zephyr-9'])
})

test('BM25 serialises and restores with identical results', () => {
  const index = new Bm25Index()
  index.add('a', POLICY_DOC.slice(0, 400))
  index.add('b', API_DOC.slice(0, 400))
  const before = index.search('contactor threshold').map((r) => [r.docId, r.score])
  const restored = Bm25Index.fromJSON(JSON.parse(JSON.stringify(index.toJSON())))
  const after = restored.search('contactor threshold').map((r) => [r.docId, r.score])
  assert.deepEqual(after, before)
  assert.deepEqual(restored.stats(), index.stats())
})

test('RRF fuses two rankings without needing comparable score scales', () => {
  const lexical = [{ docId: 'a', score: 12.5 }, { docId: 'b', score: 9.1 }, { docId: 'c', score: 3.2 }]
  const neural = [{ docId: 'c', score: 0.91 }, { docId: 'a', score: 0.88 }, { docId: 'd', score: 0.4 }]
  const fused = reciprocalRankFusion([lexical, neural])
  // 'a' is rank 0 and 1; 'c' is rank 2 and 0; 'a' should edge out 'c'.
  assert.equal(fused[0].docId, 'a')
  assert.equal(fused[1].docId, 'c')
  assert.ok(fused.some((entry) => entry.docId === 'd'), 'a doc present in only one ranking still appears')
  assert.ok(fused[0].score > fused[1].score)
})

test('retrieval metrics compute recall, precision, AP and RR correctly', () => {
  const results = [{ docId: 'a' }, { docId: 'b' }, { docId: 'c' }, { docId: 'd' }]
  const metrics = retrievalMetrics(results, ['a', 'c'], { k: 4 })
  assert.equal(metrics.recall, 1)
  assert.equal(metrics.precision, 0.5)
  assert.equal(metrics.reciprocalRank, 1)
  // AP = (1/1 + 2/3) / 2
  assert.ok(Math.abs(metrics.averagePrecision - (1 + 2 / 3) / 2) < 1e-6)
  const none = retrievalMetrics(results, ['zzz'], { k: 4 })
  assert.equal(none.recall, 0)
  assert.equal(none.reciprocalRank, 0)
  assert.equal(none.averagePrecision, 0)
})

// --- chunking & tokenising ------------------------------------------------

test('chunking respects the hard cap and preserves coverage', () => {
  const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} describes a distinct engineering requirement.`).join(' ')
  const chunks = chunkText(text, { targetChars: 400, maxChars: 700, overlapChars: 60 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.text.length <= 700 + 1, `chunk exceeded maxChars: ${chunk.text.length}`)
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i), 'indices must be sequential')
  const covered = chunks.map((c) => c.text).join(' ')
  assert.ok(covered.includes('Sentence number 0'))
  assert.ok(covered.includes('Sentence number 199'), 'the tail of the document must not be lost')
})

test('a single over-long line is hard-split rather than dropped', () => {
  const chunks = chunkText('x'.repeat(5000), { targetChars: 500, maxChars: 800, overlapChars: 0 })
  assert.ok(chunks.length >= 6)
  for (const chunk of chunks) assert.ok(chunk.text.length <= 800)
})

test('a short document becomes exactly one chunk', () => {
  const chunks = chunkText('Short note.', { targetChars: 1200, maxChars: 2000 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].text, 'Short note.')
  assert.deepEqual(chunkText('   '), [])
})

test('sentence splitting keeps offsets monotonic', () => {
  const sentences = splitSentences('First one. Second one. Third one.')
  assert.equal(sentences.length, 3)
  for (let i = 1; i < sentences.length; i += 1) assert.ok(sentences[i].start >= sentences[i - 1].start)
})

test('stemming groups morphological variants without collapsing distinct words', () => {
  assert.equal(stemTokens('running runner runs').filter((t) => t.startsWith('run')).length, 3)
  assert.ok(stemTokens('contactor contactors').every((token) => token === 'contactor'))
  // 'us' endings must not be stripped into nonsense.
  assert.ok(stemTokens('status').includes('status'))
})

test('contentKey normalises whitespace and case for deduplication', () => {
  assert.equal(contentKey('Hello   World\n'), contentKey('hello world'))
  assert.notEqual(contentKey('Hello World'), contentKey('Hello Worlds'))
})

test('longestCommonTokenRun measures verbatim overlap', () => {
  assert.equal(longestCommonTokenRun(['a', 'b', 'c'], ['x', 'a', 'b', 'c', 'y']), 3)
  assert.equal(longestCommonTokenRun(['a', 'b'], ['b', 'a']), 1)
  assert.equal(longestCommonTokenRun([], ['a']), 0)
})

// --- file-type validation -------------------------------------------------

test('file-type validation accepts text and refuses binaries', () => {
  const textBytes = new TextEncoder().encode('plain documentation\n')
  assert.equal(validateFileType({ filename: 'notes.md', bytes: textBytes }).ok, true)
  assert.equal(validateFileType({ filename: 'module.py', bytes: textBytes }).mime, 'text/plain')

  const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])
  assert.throws(() => validateFileType({ filename: 'lib.md', bytes: elf }), /content is elf/)
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
  assert.throws(() => validateFileType({ filename: 'doc.txt', bytes: zip }), /zip_or_office/)
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0])
  assert.throws(() => validateFileType({ filename: 'spec.txt', bytes: pdf }), /pdf/)
})

test('forbidden and unsupported extensions are refused by name', () => {
  const bytes = new TextEncoder().encode('x')
  for (const filename of ['payload.exe', 'archive.zip', 'script.ps1', 'image.png']) {
    assert.throws(() => validateFileType({ filename, bytes }), IngestionRejectedError, `${filename} should be refused`)
  }
  assert.throws(() => validateFileType({ filename: 'data.unknownext', bytes }), /not a supported text type/)
})

test('a binary with no known magic is caught by the control-character heuristic', () => {
  const junk = new Uint8Array(200).fill(0x01)
  assert.throws(() => validateFileType({ filename: 'readme.md', bytes: junk }), /control characters/)
})

// --- pipeline -------------------------------------------------------------

function makePipeline(overrides = {}) {
  const ledger = new AuditLedger(':memory:')
  const pipeline = new KnowledgePipeline({ dbFile: ':memory:', ledger, ...overrides })
  return { pipeline, ledger }
}

test('ingestion stores, chunks and makes content retrievable with citations', async () => {
  const { pipeline, ledger } = makePipeline()
  const result = await pipeline.ingestText({ title: 'BMS Safety Policy', text: POLICY_DOC, classification: 'confidential', owner: 'ops' })
  assert.equal(result.duplicate, false)
  assert.ok(result.chunks >= 1)

  const found = pipeline.search({ query: 'thermal runaway contactor threshold' })
  assert.ok(found.results.length > 0, 'the policy must be retrievable')
  const citation = found.results[0].citation
  assert.equal(citation.title, 'BMS Safety Policy')
  assert.ok(citation.documentId)
  assert.ok(citation.chunkId)
  assert.ok(citation.sha256 && citation.sha256.length === 64, 'citation carries a content hash')
  assert.equal(typeof citation.startOffset, 'number')
  assert.equal(typeof citation.endOffset, 'number')
  assert.ok(found.results[0].text.includes('contactor'), 'returned text is the real chunk')

  // Every retrieval is audited.
  const events = ledger.query({ category: 'knowledge', limit: 50 })
  assert.ok(events.some((event) => event.action === 'ingest'))
  assert.ok(events.some((event) => event.action === 'search'))
})

test('exact duplicates are rejected by content hash, not re-indexed', async () => {
  const { pipeline } = makePipeline()
  const first = await pipeline.ingestText({ title: 'Doc', text: POLICY_DOC })
  const second = await pipeline.ingestText({ title: 'Doc again', text: POLICY_DOC })
  assert.equal(second.duplicate, true)
  assert.equal(second.documentId, first.documentId)
  assert.equal(pipeline.store.stats().documents, 1)
  // Whitespace-only variation is still the same content.
  const third = await pipeline.ingestText({ title: 'Doc reformatted', text: POLICY_DOC.replace(/\n/g, '\n\n') })
  assert.equal(third.duplicate, true)
})

test('empty and oversized documents are refused', async () => {
  const { pipeline } = makePipeline()
  await assert.rejects(() => pipeline.ingestText({ title: 'Blank', text: '   ' }), /empty/)
  await assert.rejects(() => pipeline.ingestText({ title: 'Huge', text: 'x'.repeat(21 * 1024 * 1024) }), /20 MB/)
})

test('access control hides documents at query time, not after ranking', async () => {
  const { pipeline } = makePipeline()
  const secret = await pipeline.ingestText({
    title: 'Salary Bands',
    text: 'The senior engineer salary band is confidential and starts at 180000.',
    owner: 'hr',
    principals: ['hr-team'],
    classification: 'confidential',
  })
  const open = await pipeline.ingestText({ title: 'API Reference', text: API_DOC, owner: 'eng', principals: [] })

  // A named principal holding no grant must not see the HR document at all.
  const denied = pipeline.search({ query: 'salary band senior engineer', principal: 'eng-alice' })
  assert.equal(denied.results.some((entry) => entry.citation.documentId === secret.documentId), false, 'ACL must filter candidates, not post-filter')
  assert.equal(denied.accessControlled, true)
  // The same principal cannot read the engineering doc either: ACL applies uniformly,
  // because ingestion records an explicit grant set rather than leaving it empty.
  assert.equal(pipeline.search({ query: 'charging session connector identifier', principal: 'eng-alice' }).results.length, 0)

  // A member of the granted group does see it.
  const allowed = pipeline.search({ query: 'salary band senior engineer', principal: { id: 'hr-bob', groups: ['hr-team'] } })
  assert.ok(allowed.results.some((entry) => entry.citation.documentId === secret.documentId))

  // The owner can read their own document.
  assert.ok(pipeline.search({ query: 'salary band senior engineer', principal: 'hr' }).results.length > 0)

  // The local operator who ingested the corpus can read it with no principal named.
  const local = pipeline.search({ query: 'charging session connector identifier' })
  assert.ok(local.results.some((entry) => entry.citation.documentId === open.documentId))

  // Access can be revoked, and revocation takes effect immediately.
  assert.equal(pipeline.store.revoke(secret.documentId, 'hr-team', 'read'), true)
  const afterRevoke = pipeline.search({ query: 'salary band senior engineer', principal: { id: 'hr-bob', groups: ['hr-team'] } })
  assert.equal(afterRevoke.results.some((entry) => entry.citation.documentId === secret.documentId), false)
})

test('classification filtering narrows retrieval', async () => {
  const { pipeline } = makePipeline()
  await pipeline.ingestText({ title: 'Public FAQ', text: 'Public information about our products and support hours.', classification: 'public' })
  await pipeline.ingestText({ title: 'Internal Runbook', text: 'Internal support runbook describing escalation procedures.', classification: 'internal' })
  const publicOnly = pipeline.search({ query: 'support', classifications: ['public'] })
  assert.ok(publicOnly.results.every((entry) => entry.citation.classification === 'public'))
  assert.ok(publicOnly.results.some((entry) => entry.citation.title === 'Public FAQ'))
})

test('grounded context separates evidence from inference and reports missing evidence', async () => {
  const { pipeline } = makePipeline()
  await pipeline.ingestText({ title: 'BMS Safety Policy', text: POLICY_DOC })

  const grounded = pipeline.buildGroundedContext({ query: 'what is the thermal runaway threshold' })
  assert.equal(grounded.hasEvidence, true)
  assert.ok(grounded.evidenceCount > 0)
  assert.match(grounded.promptContext, /\[E1\]/)
  assert.match(grounded.promptContext, /Do not infer company procedure|do not infer company procedure/i)
  assert.match(grounded.promptContext, /label the latter "Inference:"/)
  assert.ok(grounded.citations[0].ref === 'E1')
  assert.ok(grounded.citations[0].title)

  // No evidence → the context must say so rather than letting the model improvise.
  // The query shares no content token with the corpus (stopwords are stripped).
  const empty = pipeline.buildGroundedContext({ query: 'xylophone zebra ballet umbrella' })
  assert.equal(empty.hasEvidence, false)
  assert.equal(empty.evidenceCount, 0)
  assert.deepEqual(empty.citations, [])
  assert.match(empty.promptContext, /No indexed evidence matched/)
})

test('evaluateRetrieval returns real measured metrics', async () => {
  const { pipeline } = makePipeline()
  await pipeline.ingestText({ title: 'BMS Safety Policy', text: POLICY_DOC })
  const policyDoc = pipeline.store.listDocuments()[0]
  const chunks = pipeline.store.getChunks(policyDoc.id)

  const cases = [
    { query: 'contactor must open within how many milliseconds', relevant: chunks.map((c) => c.id) },
    { query: 'isolation resistance ohms per volt requirement', relevant: chunks.map((c) => c.id) },
    { query: 'firmware release approval safety board sign-off', relevant: chunks.map((c) => c.id) },
  ]
  const { summary, perCase } = pipeline.evaluateRetrieval(cases, { k: 5 })
  assert.equal(summary.cases, 3)
  assert.ok(summary.recallAtK > 0, 'a real index must actually retrieve the seeded documents')
  assert.ok(summary.mrr > 0)
  for (const entry of perCase) {
    assert.ok(entry.recall >= 0 && entry.recall <= 1)
    assert.ok(Number.isFinite(entry.averagePrecision))
  }
  // Two identical runs must produce identical numbers (no random component).
  const again = pipeline.evaluateRetrieval(cases, { k: 5 }).summary
  assert.deepEqual(again, summary)
})

test('contamination check flags verbatim eval/corpus overlap', async () => {
  const { pipeline } = makePipeline()
  await pipeline.ingestText({ title: 'Policy', text: POLICY_DOC })
  const verbatim = 'The pack contactor must open within 250 milliseconds when any cell exceeds 68 degrees Celsius'
  const flagged = pipeline.findContamination([{ query: verbatim }], { minOverlapTokens: 8 })
  assert.ok(flagged.length > 0, 'a verbatim eval query present in the corpus must be flagged')
  assert.ok(flagged[0].overlapTokens >= 8)
  const clean = pipeline.findContamination([{ query: 'what is the airspeed velocity of an unladen swallow' }], { minOverlapTokens: 8 })
  assert.equal(clean.length, 0)
})

test('purge removes chunks, ACL rows and index entries, and is logged', async () => {
  const { pipeline, ledger } = makePipeline()
  const ingested = await pipeline.ingestText({ title: 'Sensitive', text: POLICY_DOC, owner: 'ops', principals: ['ops-team'] })
  const id = ingested.documentId
  assert.ok(pipeline.search({ query: 'contactor threshold' }).results.length > 0)

  const purge = pipeline.purgeDocument(id, { reason: 'gdpr request', requestedBy: 'owner' })
  assert.equal(purge.deleted, true)
  assert.ok(purge.chunks >= 1)
  assert.ok(purge.aclRows >= 2, 'owner + principal grants must both be removed')

  assert.deepEqual(pipeline.search({ query: 'contactor threshold' }).results, [], 'nothing may remain retrievable')
  assert.equal(pipeline.store.getDocument(id), null)
  assert.equal(pipeline.store.getChunks(id).length, 0)
  assert.equal(pipeline.store.aclFor(id).length, 0)

  const log = pipeline.store.deletionLog()
  assert.equal(log.length, 1)
  assert.equal(log[0].reason, 'gdpr request')
  assert.ok(ledger.query({ category: 'knowledge' }).some((event) => event.action === 'purge'))

  // Re-ingesting after a purge must succeed (the sha256 unique index is scoped to active rows).
  const again = await pipeline.ingestText({ title: 'Sensitive restored', text: POLICY_DOC })
  assert.equal(again.duplicate, false)
})

test('retention policy purges by age', async () => {
  const { pipeline } = makePipeline()
  await pipeline.ingestText({ title: 'Old', text: 'old content that should expire' })
  // Nothing is older than 1 hour yet.
  assert.equal(pipeline.store.applyRetention({ olderThanMs: 3600_000 }).purged, 0)
  // Everything is older than 0 ms.
  const result = pipeline.store.applyRetention({ olderThanMs: 0, reason: 'test retention' })
  assert.equal(result.purged, 1)
  assert.equal(pipeline.store.stats().documents, 0)
})

test('file ingestion reads from disk and refuses path escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aetheris-knowledge-'))
  try {
    await writeFile(join(dir, 'guide.md'), API_DOC)
    const { pipeline } = makePipeline()
    const result = await pipeline.ingestFile({ path: 'guide.md', rootDir: dir })
    assert.equal(result.duplicate, false)
    assert.ok(pipeline.search({ query: 'charging session identifier' }).results.length > 0)
    await assert.rejects(() => pipeline.ingestFile({ path: '../../etc/passwd', rootDir: dir }), /escapes the configured knowledge root/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('index rebuild reproduces the same retrieval results', async () => {
  const { pipeline, ledger } = makePipeline()
  await pipeline.ingestText({ title: 'Policy', text: POLICY_DOC })
  await pipeline.ingestText({ title: 'API', text: API_DOC })
  const before = pipeline.search({ query: 'isolation resistance' }).results.map((r) => [r.chunkId, r.score])
  const rebuild = pipeline.rebuildIndex()
  assert.ok(rebuild.chunks >= 2)
  assert.ok(rebuild.durationMs >= 0)
  const after = pipeline.search({ query: 'isolation resistance' }).results.map((r) => [r.chunkId, r.score])
  assert.deepEqual(after, before, 'a rebuild must be reproducible')
  const runs = pipeline.store.indexRuns()
  assert.ok(runs.length >= 1)
  assert.equal(runs[0].outcome, 'success')
  assert.ok(ledger.query({ category: 'knowledge' }).some((event) => event.action === 'index_rebuild'))
})

test('an embedder failure degrades to BM25 and is recorded, not hidden', async () => {
  const { pipeline, ledger } = makePipeline({
    embedder: { embed: async () => { throw new Error('embedding runtime offline') } },
    embeddingModel: 'test-embedder',
  })
  await pipeline.ingestText({ title: 'Policy', text: POLICY_DOC })
  // Retrieval still works.
  assert.ok(pipeline.search({ query: 'contactor threshold' }).results.length > 0)
  assert.ok(ledger.query({ category: 'knowledge' }).some((event) => event.action === 'embed_failed'))
})

test('a working embedder stores vectors and retrieval reports the fused method', async () => {
  // A deterministic toy embedder: hashing bag-of-words. Real, if simple.
  const embedder = {
    embed: async ({ input }) => ({
      vectors: input.map((text) => {
        const vector = new Array(16).fill(0)
        for (const token of tokenize(text)) vector[token.charCodeAt(0) % 16] += 1
        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
        return vector.map((v) => v / norm)
      }),
    }),
  }
  const { pipeline } = makePipeline({ embedder, embeddingModel: 'toy-hash-16' })
  await pipeline.ingestText({ title: 'Policy', text: POLICY_DOC })
  const stored = pipeline.store.getEmbeddings('toy-hash-16')
  assert.ok(stored.length > 0)
  assert.equal(stored[0].dim, 16)
  const found = pipeline.search({ query: 'contactor threshold' })
  assert.equal(found.method, 'bm25+neural(rrf)')
  assert.ok(found.results.length > 0)
})

test('search rejects an empty query', () => {
  const { pipeline } = makePipeline()
  assert.throws(() => pipeline.search({ query: '' }), TypeError)
  assert.throws(() => pipeline.search({ query: '   ' }), TypeError)
})
