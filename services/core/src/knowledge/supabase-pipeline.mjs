import { readFile } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'
import { Bm25Index, retrievalMetrics } from './bm25.mjs'
import { chunkText, contentKey, tokenize } from './text.mjs'
import { IngestionRejectedError, longestCommonTokenRun, validateFileType } from './pipeline-utils.mjs'
import { mostSensitiveDataClass } from '../policy/egress.mjs'

const MAX_DOCUMENT_CHARS = 20 * 1024 * 1024
const MAX_TOP_K = 100

function matchesPrincipal(granted, requested) {
  if (!requested) return false
  if (granted === requested || granted === '*') return true
  if (Array.isArray(requested)) return requested.includes(granted)
  if (requested && typeof requested === 'object') {
    if (requested.id === granted) return true
    return Array.isArray(requested.groups) && requested.groups.includes(granted)
  }
  return false
}

function topKValue(value, fallback = 8) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TOP_K) throw new TypeError('topK must be an integer from 1 to 100')
  return value
}

/** Async counterpart of KnowledgePipeline backed by a durable account-scoped repository. */
export class SupabaseKnowledgePipeline {
  constructor({ store, ledger = null, chunking = {}, defaultPrincipal } = {}) {
    if (!store || !['allChunks', 'allAcl', 'insertDocument', 'getChunks', 'purgeDocument', 'stats', 'recordIndexRun'].every((method) => typeof store[method] === 'function')) {
      throw new TypeError('SupabaseKnowledgePipeline requires an account-scoped knowledge store')
    }
    if (typeof defaultPrincipal !== 'string' || !defaultPrincipal || (store.accountId && store.accountId !== defaultPrincipal)) {
      throw new TypeError('defaultPrincipal must match the authenticated store account id')
    }
    this.store = store
    this.ledger = ledger
    this.defaultPrincipal = defaultPrincipal
    this.chunking = { targetChars: 1200, maxChars: 2000, overlapChars: 160, ...chunking }
    this.index = new Bm25Index()
    this.chunks = new Map()
    this.documents = new Map()
    this.aclByDocument = new Map()
    this.initialized = false
  }

  async initialize() {
    return this.rebuildIndex({ kind: 'startup' })
  }

  async #loadCorpus() {
    const [rows, aclRows] = await Promise.all([this.store.allChunks(), this.store.allAcl()])
    const index = new Bm25Index()
    const chunks = new Map()
    const documents = new Map()
    const aclByDocument = new Map()

    for (const row of rows) {
      const documentId = row.document_id
      if (typeof documentId !== 'string' || typeof row.text !== 'string' || typeof row.title !== 'string') {
        throw Object.assign(new Error('knowledge corpus row is invalid'), { code: 'knowledge_corpus_invalid' })
      }
      index.add(row.id, row.text, {
        documentId,
        chunkIdx: row.idx,
        title: row.title,
        classification: row.classification,
        sourcePath: row.source_path,
        mime: row.mime,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
        sha256: row.sha256,
      })
      chunks.set(row.id, row)
      documents.set(documentId, {
        id: documentId,
        title: row.title,
        sourcePath: row.source_path ?? null,
        mime: row.mime ?? null,
        classification: row.classification,
        sha256: row.sha256,
      })
    }
    for (const grant of aclRows) {
      if (!aclByDocument.has(grant.document_id)) aclByDocument.set(grant.document_id, [])
      aclByDocument.get(grant.document_id).push(grant)
    }

    // Only publish the new snapshot after both bounded account-scoped reads validate.
    this.index = index
    this.chunks = chunks
    this.documents = documents
    this.aclByDocument = aclByDocument
    return { chunks: rows.length, documents: documents.size }
  }

  async rebuildIndex({ kind = 'rebuild' } = {}) {
    const started = Date.now()
    const corpus = await this.#loadCorpus()
    const storeStats = await this.store.stats()
    const durationMs = Date.now() - started
    await this.store.recordIndexRun({
      kind, documents: storeStats.documents, chunks: corpus.chunks, durationMs, outcome: 'success',
    })
    this.initialized = true
    const result = { chunks: corpus.chunks, durationMs, stats: this.index.stats() }
    this.#audit('knowledge', `index_${kind}`, 'success', result)
    return result
  }

  async ingestText({ title, text, sourcePath = null, mime = 'text/plain', classification = 'internal', owner = this.defaultPrincipal, principals = [], meta = {} } = {}) {
    const normalized = String(text ?? '')
    if (!normalized.trim()) throw new IngestionRejectedError('document is empty', 'empty_document')
    if (Buffer.byteLength(normalized, 'utf8') > MAX_DOCUMENT_CHARS) throw new IngestionRejectedError('document exceeds the 20 MB ingest limit', 'too_large')
    if (owner !== this.defaultPrincipal) throw Object.assign(new Error('knowledge owner must be the authenticated account'), { code: 'supabase_knowledge_owner_invalid' })

    const key = contentKey(normalized)
    const chunks = chunkText(normalized, this.chunking).map((chunk) => ({
      ...chunk,
      tokenCount: tokenize(chunk.text).length,
    }))
    if (!Array.isArray(principals) || principals.some((principal) => typeof principal !== 'string' || !principal)) {
      throw new TypeError('principals must be a list of non-empty names')
    }
    const grants = [...new Set([...principals, this.defaultPrincipal])]
    const result = await this.store.insertDocument({
      title, text: normalized, contentKey: key, chunks, sourcePath, mime, classification,
      owner: this.defaultPrincipal, principals: grants, meta,
    })

    // Another function instance may have inserted this exact document. Refresh from
    // Postgres in either case so this warm instance cannot keep an older retrieval view.
    await this.#loadCorpus()
    if (result.duplicate) {
      this.#audit('knowledge', 'ingest_duplicate', 'info', {
        existingDocumentId: result.document.id, title, reason: result.reason,
      }, result.document.id)
      return { duplicate: true, documentId: result.document.id, document: result.document, reason: result.reason }
    }

    this.#audit('knowledge', 'ingest', 'success', {
      documentId: result.document.id,
      title,
      chunks: result.chunkIds.length,
      bytes: result.document.sizeBytes,
      sha256: result.document.sha256,
      classification,
      embedded: false,
    }, result.document.id)
    return {
      duplicate: false,
      documentId: result.document.id,
      document: result.document,
      chunks: result.chunkIds.length,
      chunkIds: result.chunkIds,
    }
  }

  async ingestFile({ path, rootDir, title = null, classification = 'internal', principals = [], meta = {} } = {}) {
    const full = this.#safePath(path, rootDir)
    const bytes = new Uint8Array(await readFile(full))
    const validation = validateFileType({ filename: full, bytes })
    const text = Buffer.from(bytes).toString('utf8')
    return this.ingestText({
      title: title ?? basename(full), text, sourcePath: path, mime: validation.mime,
      classification, principals, meta: { ...meta, filename: basename(full), validated: validation },
    })
  }

  async search({ query, principal = null, topK = 8, classifications = null } = {}) {
    if (!query || !String(query).trim()) throw new TypeError('search requires a non-empty query')
    const limit = topKValue(topK)
    if (classifications !== null && (!Array.isArray(classifications) || classifications.some((item) => typeof item !== 'string'))) {
      throw new TypeError('classifications must be a list of strings or null')
    }
    // Refresh each query: a serverless instance may be warm while another invocation
    // writes a document or changes an ACL. The account-wide scan is hard-bounded and
    // explicitly fails when the full corpus no longer fits the supported request work.
    await this.#loadCorpus()
    if (!this.initialized) this.initialized = true
    const effectivePrincipal = principal ?? this.defaultPrincipal
    const canRead = (docId) => {
      const grants = this.aclByDocument.get(this.index.docs.get(docId)?.meta?.documentId) ?? []
      return grants.length === 0 || grants.some((grant) => grant.permission !== 'write' && matchesPrincipal(grant.principal, effectivePrincipal))
    }
    const filter = (docId, meta) => canRead(docId)
      && (!classifications || classifications.includes(meta.classification))
    const ranked = this.index.search(query, { topK: limit, filter })
    const results = ranked.map((entry) => this.#toCitation(entry))
    this.#audit('knowledge', 'search', 'success', {
      queryLength: String(query).length,
      results: results.length,
      neuralUsed: false,
      principal: typeof effectivePrincipal === 'string' ? effectivePrincipal : '[structured]',
      indexStats: this.index.stats(),
    })
    return {
      query,
      results,
      citations: results.map((entry) => entry.citation),
      method: 'bm25',
      indexStats: this.index.stats(),
      accessControlled: true,
    }
  }

  #toCitation(entry) {
    const meta = entry.meta ?? {}
    const chunk = this.chunks.get(entry.docId)
    const document = this.documents.get(meta.documentId ?? chunk?.document_id)
    return {
      chunkId: entry.docId,
      documentId: meta.documentId ?? chunk?.document_id ?? null,
      score: entry.score,
      text: chunk?.text ?? '',
      matchedTerms: entry.matchedTerms ?? [],
      citation: {
        documentId: document?.id ?? null,
        chunkId: entry.docId,
        title: document?.title ?? meta.title ?? null,
        sourcePath: document?.sourcePath ?? meta.sourcePath ?? null,
        chunkIndex: chunk?.idx ?? meta.chunkIdx ?? null,
        startOffset: chunk?.start_offset ?? meta.startOffset ?? null,
        endOffset: chunk?.end_offset ?? meta.endOffset ?? null,
        classification: document?.classification ?? meta.classification ?? null,
        sha256: document?.sha256 ?? meta.sha256 ?? null,
      },
    }
  }

  async buildGroundedContext({ query, principal = null, topK = 6, classifications = null } = {}) {
    const { results, method, indexStats } = await this.search({ query, principal, topK, classifications })
    const evidenceBlocks = results.map((entry, index) => {
      const citation = entry.citation
      return [
        `[E${index + 1}] ${citation.title ?? 'untitled'}${citation.sourcePath ? ` (${citation.sourcePath})` : ''} · chunk ${citation.chunkIndex ?? '?'} · chars ${citation.startOffset ?? '?'}-${citation.endOffset ?? '?'}`,
        entry.text,
      ].join('\n')
    })
    const citations = results.map((entry, index) => ({ ref: `E${index + 1}`, ...entry.citation }))
    return {
      query,
      method,
      indexStats,
      evidenceCount: results.length,
      citations,
      dataClass: mostSensitiveDataClass(...citations.map((citation) => citation.classification)),
      hasEvidence: results.length > 0,
      promptContext: results.length
        ? [
            'Use ONLY the evidence blocks below to answer. Cite them inline as [E1], [E2], …',
            'If the evidence does not contain the answer, say so explicitly — do not infer company procedure.',
            'Distinguish statements supported by evidence from your own reasoning; label the latter "Inference:".',
            '',
            ...evidenceBlocks,
          ].join('\n')
        : 'No indexed evidence matched this query. State that no company source was found and do not invent procedure.',
    }
  }

  async evaluateRetrieval(cases, { k = 10 } = {}) {
    if (!Array.isArray(cases) || !cases.length) throw new TypeError('evaluateRetrieval requires a non-empty case list')
    const perCase = []
    for (const testCase of cases) {
      const { results } = await this.search({ query: testCase.query, principal: testCase.principal ?? null, topK: k })
      const relevant = new Set(testCase.relevant ?? [])
      const mapped = results.map((entry) => ({
        docId: relevant.has(entry.chunkId) ? entry.chunkId : entry.citation.documentId,
        score: entry.score,
      }))
      perCase.push({ query: testCase.query, ...retrievalMetrics(mapped, [...relevant], { k }) })
    }
    const mean = (key) => round(perCase.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) / perCase.length)
    const summary = {
      cases: perCase.length,
      k,
      recallAtK: mean('recall'),
      precisionAtK: mean('precision'),
      map: mean('averagePrecision'),
      mrr: mean('reciprocalRank'),
      method: 'bm25',
      indexStats: this.index.stats(),
    }
    this.#audit('knowledge', 'evaluate', 'success', summary)
    return { summary, perCase }
  }

  async findContamination(cases, { minOverlapTokens = 12 } = {}) {
    await this.#loadCorpus()
    const flagged = []
    for (const testCase of cases ?? []) {
      const queryTokens = tokenize(testCase.query)
      if (queryTokens.length < minOverlapTokens) continue
      const hits = this.index.search(testCase.query, { topK: 3 })
      for (const hit of hits) {
        const text = this.chunks.get(hit.docId)?.text ?? ''
        const overlapTokens = longestCommonTokenRun(queryTokens, tokenize(text))
        if (overlapTokens >= minOverlapTokens) flagged.push({
          query: testCase.query, chunkId: hit.docId, documentId: hit.meta.documentId, overlapTokens,
        })
      }
    }
    return flagged
  }

  async purgeDocument(documentId, options = {}) {
    const result = await this.store.purgeDocument(documentId, { ...options, requestedBy: this.defaultPrincipal })
    if (result.deleted) {
      await this.#loadCorpus()
      this.#audit('knowledge', 'purge', 'success', result, documentId)
    }
    return result
  }

  async stats() {
    const [store] = await Promise.all([this.store.stats(), this.#loadCorpus()])
    this.initialized = true
    return { store, index: this.index.stats() }
  }

  #safePath(path, rootDir) {
    if (typeof path !== 'string' || !path) throw new IngestionRejectedError('choose a file path', 'invalid_path')
    if (!rootDir) return resolve(path)
    const full = resolve(rootDir, path)
    const root = resolve(rootDir)
    if (full !== root && !full.startsWith(root + sep)) {
      throw new IngestionRejectedError('path escapes the configured knowledge root', 'path_escape')
    }
    return full
  }

  #audit(category, action, outcome, detail, subject = null) {
    this.ledger?.record({ category, action, outcome, subject, detail })
  }

  close() {
    this.store.close?.()
  }
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6
}
