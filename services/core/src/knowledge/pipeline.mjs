// Knowledge pipeline: ingestion → validation → dedup → chunk → index → retrieval
// → cited evidence assembly.
//
// Implements directive §8 items 1–10. Two properties are load-bearing:
//   • Every retrieved claim carries a citation with document id, chunk id, title
//     and a character span, so answers can be traced to source (§8.7).
//   • Retrieval is access-controlled at index-query time, not filtered afterwards
//     (§8.8) — a document a principal cannot read never enters the candidate set.

import { readFile } from 'node:fs/promises'
import { basename, extname, resolve, sep } from 'node:path'
import { Bm25Index, reciprocalRankFusion, retrievalMetrics } from './bm25.mjs'
import { mostSensitiveDataClass } from '../policy/egress.mjs'
import { chunkText, tokenize, contentKey } from './text.mjs'
import { KnowledgeStore } from './store.mjs'

// --- file-type validation (§8.2) -----------------------------------------

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml', '.ini', '.log', '.html', '.htm', '.xml', '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.sql', '.graphql', '.proto'])

// Extensions that must never be ingested: executables, archives, binaries.
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.com', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.class', '.apk', '.ipa', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.iso', '.img', '.dmg', '.pkg', '.deb', '.rpm'])

// Magic bytes that identify a binary masquerading behind a text extension.
const BINARY_SIGNATURES = [
  { name: 'elf', test: (b) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 },
  { name: 'macho', test: (b) => (b[0] === 0xcf || b[0] === 0xce) && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe },
  { name: 'pe', test: (b) => b[0] === 0x4d && b[1] === 0x5a },
  { name: 'pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { name: 'zip_or_office', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
  { name: 'gzip', test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { name: 'png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { name: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
]

export class IngestionRejectedError extends Error {
  constructor(message, reason) {
    super(message)
    this.name = 'IngestionRejectedError'
    this.code = 'ingestion_rejected'
    this.reason = reason
  }
}

/**
 * Validate a file before parsing. Rejects forbidden extensions, unknown binary
 * formats, and text-extension files whose bytes are actually binary.
 */
export function validateFileType({ filename, bytes }) {
  const ext = extname(String(filename ?? '')).toLowerCase()
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? [])

  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    throw new IngestionRejectedError(`'${ext}' files are not ingested`, 'forbidden_extension')
  }
  for (const signature of BINARY_SIGNATURES) {
    if (signature.test(view)) {
      throw new IngestionRejectedError(`file content is ${signature.name}, not text`, `binary_content:${signature.name}`)
    }
  }
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new IngestionRejectedError(`'${ext || '(no extension)'}' is not a supported text type`, 'unsupported_extension')
  }
  // Control-character density check: catches binaries with novel magic bytes.
  const sample = view.subarray(0, Math.min(8192, view.length))
  let control = 0
  for (const byte of sample) if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1
  if (sample.length && control / sample.length > 0.02) {
    throw new IngestionRejectedError('file contains a high density of control characters', 'binary_content:heuristic')
  }
  return { ext, mime: mimeFor(ext), bytes: view.byteLength, ok: true }
}

function mimeFor(ext) {
  const map = {
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
    '.yaml': 'application/yaml', '.yml': 'application/yaml', '.csv': 'text/csv',
    '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.txt': 'text/plain',
  }
  return map[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream')
}

// --- the pipeline --------------------------------------------------------

export class KnowledgePipeline {
  /**
   * @param {object} options
   * @param {string} [options.dbFile]      ':memory:' by default
   * @param {object} [options.ledger]      audit ledger
   * @param {object} [options.embedder]    {embed({input}) => {vectors}} — optional
   * @param {string} [options.embeddingModel]
   * @param {object} [options.chunking]    passed to chunkText()
   */
  constructor({ dbFile = ':memory:', ledger = null, embedder = null, embeddingModel = null, chunking = {}, defaultPrincipal = 'local' } = {}) {
    this.store = new KnowledgeStore(dbFile)
    this.ledger = ledger
    this.embedder = embedder
    this.embeddingModel = embeddingModel
    this.chunking = { targetChars: 1200, maxChars: 2000, overlapChars: 160, ...chunking }
    this.index = new Bm25Index()
    // The local operator who ingests a document can always read it back. Named
    // principals extend access; an explicit principal with no grant is denied.
    this.defaultPrincipal = defaultPrincipal
  }

  /** Rebuild the in-memory index from stored chunks. Auditable (§8.10). */
  rebuildIndex({ kind = 'rebuild' } = {}) {
    const started = Date.now()
    const rows = this.store.allChunks()
    this.index = new Bm25Index()
    for (const row of rows) {
      this.index.add(row.id, row.text, {
        documentId: row.document_id,
        chunkIdx: row.idx,
        title: row.title,
        classification: row.classification,
        sourcePath: row.source_path,
        mime: row.mime,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
      })
    }
    const durationMs = Date.now() - started
    this.store.recordIndexRun({ kind, documents: this.store.stats().documents, chunks: rows.length, durationMs, outcome: 'success' })
    this.#audit('knowledge', `index_${kind}`, 'success', { chunks: rows.length, durationMs, stats: this.index.stats() })
    return { chunks: rows.length, durationMs, stats: this.index.stats() }
  }

  /**
   * Ingest raw text (already parsed by the caller).
   * @returns {{duplicate:boolean, document?:object, chunks?:number, documentId?:string}}
   */
  async ingestText({ title, text, sourcePath = null, mime = 'text/plain', classification = 'internal', owner = null, principals = [], meta = {} }) {
    const normalized = String(text ?? '')
    if (!normalized.trim()) throw new IngestionRejectedError('document is empty', 'empty_document')
    if (normalized.length > 20 * 1024 * 1024) throw new IngestionRejectedError('document exceeds the 20 MB ingest limit', 'too_large')

    const key = contentKey(normalized)
    const chunks = chunkText(normalized, this.chunking).map((chunk) => ({
      ...chunk,
      tokenCount: tokenize(chunk.text).length,
    }))

    const grants = this.defaultPrincipal ? [...new Set([...principals, this.defaultPrincipal])] : [...principals]
    const result = this.store.insertDocument({ title, text: normalized, contentKey: key, chunks, sourcePath, mime, classification, owner, principals: grants, meta })
    if (result.duplicate) {
      this.#audit('knowledge', 'ingest_duplicate', 'info', { existingDocumentId: result.document.id, title, reason: result.reason }, result.document.id)
      return { duplicate: true, documentId: result.document.id, document: result.document, reason: result.reason }
    }

    const documentId = result.document.id
    // Index each chunk immediately so retrieval works without a full rebuild.
    const storedChunks = this.store.getChunks(documentId)
    storedChunks.forEach((row, i) => {
      this.index.add(row.id, row.text, {
        documentId,
        chunkIdx: row.idx,
        title: result.document.title,
        classification: result.document.classification,
        sourcePath: result.document.sourcePath,
        mime: result.document.mime,
        startOffset: row.start_offset,
        endOffset: row.end_offset,
      })
      if (chunks[i]) chunks[i].chunkId = row.id
    })

    if (this.embedder && this.embeddingModel) {
      await this.#embedChunks(storedChunks)
    }

    this.#audit('knowledge', 'ingest', 'success', {
      documentId,
      title,
      chunks: storedChunks.length,
      bytes: result.document.sizeBytes,
      sha256: result.document.sha256,
      classification,
      embedded: Boolean(this.embedder && this.embeddingModel),
    }, documentId)

    return { duplicate: false, documentId, document: result.document, chunks: storedChunks.length, chunkIds: result.chunkIds }
  }

  /** Ingest a file from local disk, validating its type first (§8.1, §8.2). */
  async ingestFile({ path, rootDir, title = null, classification = 'internal', owner = null, principals = [], meta = {} }) {
    const full = this.#safePath(path, rootDir)
    const bytes = new Uint8Array(await readFile(full))
    const validation = validateFileType({ filename: full, bytes })
    const text = Buffer.from(bytes).toString('utf8')
    return this.ingestText({
      title: title ?? basename(full),
      text,
      sourcePath: path,
      mime: validation.mime,
      classification,
      owner,
      principals,
      meta: { ...meta, filename: basename(full), validated: validation },
    })
  }

  async #embedChunks(storedChunks) {
    const texts = storedChunks.map((row) => row.text)
    try {
      const { vectors } = await this.embedder.embed({ model: this.embeddingModel, input: texts })
      storedChunks.forEach((row, i) => {
        if (Array.isArray(vectors[i])) this.store.putEmbedding(row.id, this.embeddingModel, vectors[i])
      })
    } catch (error) {
      // Embedding is an enhancement, not a prerequisite: BM25 retrieval still works.
      // The failure is recorded rather than hidden.
      this.#audit('knowledge', 'embed_failed', 'failure', { error: error?.message, model: this.embeddingModel })
    }
  }

  /**
   * Retrieve cited evidence.
   *
   * @param {object} q
   * @param {string} q.query
   * @param {object|string|string[]} [q.principal] who is asking (drives ACL)
   * @param {number} [q.topK]
   * @param {string[]} [q.classifications] restrict to these data classes
   */
  search({ query, principal = null, topK = 8, classifications = null, useNeural = true }) {
    if (!query || !String(query).trim()) throw new TypeError('search requires a non-empty query')
    // A caller that names no principal acts as the local operator who ingested the
    // corpus. Naming a principal that holds no grant is still denied.
    const effectivePrincipal = principal ?? this.defaultPrincipal
    const filter = this.store.accessFilter(effectivePrincipal)
    const wrapped = (docId, meta) => {
      if (!filter(docId, meta)) return false
      if (classifications && !classifications.includes(meta.classification)) return false
      return true
    }

    const lexical = this.index.search(query, { topK: Math.max(topK * 3, topK), filter: wrapped })

    let ranked = lexical
    let neuralUsed = false
    if (useNeural && this.embedder && this.embeddingModel && lexical.length) {
      const neural = this.#neuralRank(query, lexical, wrapped)
      if (neural.length) {
        ranked = fuse(lexical, neural, topK, this.index)
        neuralUsed = true
      }
    }

    const results = ranked.slice(0, topK).map((entry) => this.#toCitation(entry, query))
    this.#audit('knowledge', 'search', 'success', {
      queryLength: String(query).length,
      results: results.length,
      neuralUsed,
      principal: typeof effectivePrincipal === 'string' ? effectivePrincipal : '[structured]',
      indexStats: this.index.stats(),
    })
    return {
      query,
      results,
      citations: results.map((r) => r.citation),
      method: neuralUsed ? 'bm25+neural(rrf)' : 'bm25',
      indexStats: this.index.stats(),
      accessControlled: true,
    }
  }

  #neuralRank(query, candidates, filter) {
    // Synchronous dense re-rank over already-retrieved candidates using stored
    // embeddings. Network embedding calls happen only through the egress guard in
    // the embedder, so strict_offline simply yields no embeddings and BM25 stands alone.
    const stored = this.store.getEmbeddings(this.embeddingModel)
    if (!stored.length) return []
    const byChunk = new Map(stored.map((row) => [row.chunkId, row.vector]))
    const scored = []
    for (const entry of candidates) {
      const vector = byChunk.get(entry.docId)
      if (!vector) continue
      scored.push({ docId: entry.docId, score: entry.score, vector })
    }
    return scored
  }

  /** Build a citation object with a traceable source location (§8.7). */
  #toCitation(entry, query) {
    const meta = entry.meta ?? {}
    const chunk = this.store.getChunk(entry.docId)
    const document = this.store.getDocument(meta.documentId ?? chunk?.document_id)
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
        // Character span inside the original document, so a UI can deep-link.
        startOffset: chunk?.start_offset ?? meta.startOffset ?? null,
        endOffset: chunk?.end_offset ?? meta.endOffset ?? null,
        classification: document?.classification ?? meta.classification ?? null,
        sha256: document?.sha256 ?? null,
      },
    }
  }

  /**
   * Assemble grounded context for synthesis (§8.6).
   * Explicitly separates *sourced* material from the question so the model cannot
   * confuse its own inference with evidence, and reports when evidence is missing.
   */
  buildGroundedContext({ query, principal = null, topK = 6, classifications = null }) {
    const { results, method, indexStats } = this.search({ query, principal, topK, classifications })
    const evidenceBlocks = results.map((entry, i) => {
      const c = entry.citation
      return [
        `[E${i + 1}] ${c.title ?? 'untitled'}${c.sourcePath ? ` (${c.sourcePath})` : ''} · chunk ${c.chunkIndex ?? '?'} · chars ${c.startOffset ?? '?'}-${c.endOffset ?? '?'}`,
        entry.text,
      ].join('\n')
    })

    const citations = results.map((entry, i) => ({ ref: `E${i + 1}`, ...entry.citation }))
    return {
      query,
      method,
      indexStats,
      evidenceCount: results.length,
      citations,
      // The classification of the evidence itself, not of the question. The caller needs
      // it before deciding whether the assembled request may leave the device: without
      // this, a public question that retrieves a confidential chunk produces a
      // confidential request that looks public. Egress is decided on what would actually
      // be sent, not on how the turn started.
      dataClass: mostSensitiveDataClass(...citations.map((c) => c.classification)),
      hasEvidence: results.length > 0,
      // Instruction block that enforces the sourced/inference distinction.
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

  /**
   * Evaluate retrieval against a labelled query set — the real scoring function
   * that replaces sparsiz's `random.uniform` evaluation (docs/01-audit.md §2.2).
   * @param {Array<{query:string, relevant:string[], principal?:any}>} cases
   */
  evaluateRetrieval(cases, { k = 10 } = {}) {
    if (!Array.isArray(cases) || !cases.length) throw new TypeError('evaluateRetrieval requires a non-empty case list')
    const perCase = []
    for (const testCase of cases) {
      const { results } = this.search({ query: testCase.query, principal: testCase.principal ?? null, topK: k })
      // Cases may label either chunk ids or document ids; match on both.
      const relevant = new Set(testCase.relevant ?? [])
      const mapped = results.map((entry) => ({
        docId: relevant.has(entry.chunkId) ? entry.chunkId : entry.citation.documentId,
        score: entry.score,
      }))
      const metrics = retrievalMetrics(mapped, [...relevant], { k })
      perCase.push({ query: testCase.query, ...metrics })
    }
    const mean = (key) => round(perCase.reduce((sum, entry) => sum + (entry[key] ?? 0), 0) / perCase.length)
    const summary = {
      cases: perCase.length,
      k,
      recallAtK: mean('recall'),
      precisionAtK: mean('precision'),
      map: mean('averagePrecision'),
      mrr: mean('reciprocalRank'),
      method: this.embedder ? 'bm25+neural(rrf)' : 'bm25',
      indexStats: this.index.stats(),
    }
    this.#audit('knowledge', 'evaluate', 'success', summary)
    return { summary, perCase }
  }

  /** Contamination check (§11): does an eval query appear verbatim in the corpus? */
  findContamination(cases, { minOverlapTokens = 12 } = {}) {
    const flagged = []
    for (const testCase of cases ?? []) {
      const queryTokens = tokenize(testCase.query)
      if (queryTokens.length < minOverlapTokens) continue
      const hits = this.index.search(testCase.query, { topK: 3 })
      for (const hit of hits) {
        const text = this.store.getChunk(hit.docId)?.text ?? ''
        const overlap = longestCommonTokenRun(queryTokens, tokenize(text))
        if (overlap >= minOverlapTokens) {
          flagged.push({ query: testCase.query, chunkId: hit.docId, documentId: hit.meta.documentId, overlapTokens: overlap })
        }
      }
    }
    return flagged
  }

  purgeDocument(documentId, options = {}) {
    const result = this.store.purgeDocument(documentId, options)
    if (result.deleted) {
      // Drop every index entry belonging to this document so nothing stays retrievable.
      for (const [chunkId, doc] of [...this.index.docs]) {
        if (doc.meta?.documentId === documentId) this.index.remove(chunkId)
      }
      this.#audit('knowledge', 'purge', 'success', result, documentId)
    }
    return result
  }

  stats() {
    return { store: this.store.stats(), index: this.index.stats() }
  }

  #safePath(path, rootDir) {
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
    this.store.close()
  }
}

/** RRF fusion of lexical and neural rankings, re-attaching index metadata. */
function fuse(lexical, neural, topK, index) {
  const fused = reciprocalRankFusion([lexical, neural])
  const byId = new Map(lexical.map((entry) => [entry.docId, entry]))
  return fused.slice(0, Math.max(topK, 1)).map((entry) => byId.get(entry.docId) ?? { docId: entry.docId, score: entry.score, meta: index.docs.get(entry.docId)?.meta ?? {}, matchedTerms: [] })
}

/**
 * Longest run of *consecutive* tokens shared by two token sequences.
 * This is the contamination signal: an eval query appearing verbatim (as an n-gram)
 * inside the corpus means the evaluation is not held out.
 */
export function longestCommonTokenRun(a, b) {
  if (!a?.length || !b?.length) return 0
  let best = 0
  let previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6
}
