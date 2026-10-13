// A real Okapi BM25 index.
//
//   score(D,Q) = Σ_qi IDF(qi) · (f(qi,D)·(k1+1)) / (f(qi,D) + k1·(1 − b + b·|D|/avgdl))
//   IDF(qi)    = ln(1 + (N − n(qi) + 0.5) / (n(qi) + 0.5))
//
// This is the retrieval baseline Aetheris Lite is measured against
// (docs/06-benchmarks.md). It is implemented here rather than pulled from sparsiz,
// whose knowledge/memory modules contain no real scoring (docs/01-audit.md §2.2).
//
// Pure JS, no dependencies, deterministic given the same corpus.

import { stemTokens } from './text.mjs'

export class Bm25Index {
  /**
   * @param {object} [options]
   * @param {number} [options.k1] term-frequency saturation, typically 1.2–2.0
   * @param {number} [options.b]  length normalisation, 0 = none, 1 = full
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    /** @type {Map<string, {tokens:string[], length:number, meta:object}>} */
    this.docs = new Map()
    /** @type {Map<string, Map<string, number>>} term → docId → frequency */
    this.postings = new Map()
    /** @type {Map<string, number>} term → document frequency */
    this.df = new Map()
    this.totalLength = 0
    this.version = 1
  }

  get size() {
    return this.docs.size
  }

  get avgdl() {
    return this.docs.size ? this.totalLength / this.docs.size : 0
  }

  /** Index (or re-index) a document. Idempotent per docId. */
  add(docId, text, meta = {}) {
    if (this.docs.has(docId)) this.remove(docId)
    const tokens = stemTokens(text)
    const freq = new Map()
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1)

    this.docs.set(docId, { tokens, length: tokens.length, meta })
    this.totalLength += tokens.length
    for (const [term, count] of freq) {
      if (!this.postings.has(term)) this.postings.set(term, new Map())
      this.postings.get(term).set(docId, count)
      this.df.set(term, (this.df.get(term) ?? 0) + 1)
    }
    this.version += 1
    return { docId, tokens: tokens.length, terms: freq.size }
  }

  remove(docId) {
    const doc = this.docs.get(docId)
    if (!doc) return false
    this.totalLength -= doc.length
    const seen = new Set()
    for (const token of doc.tokens) {
      if (seen.has(token)) continue
      seen.add(token)
      const posting = this.postings.get(token)
      if (posting) {
        posting.delete(docId)
        if (!posting.size) this.postings.delete(token)
      }
      const next = (this.df.get(token) ?? 1) - 1
      if (next <= 0) this.df.delete(token)
      else this.df.set(token, next)
    }
    this.docs.delete(docId)
    this.version += 1
    return true
  }

  idf(term) {
    const n = this.df.get(term) ?? 0
    const N = this.docs.size
    return Math.log(1 + (N - n + 0.5) / (n + 0.5))
  }

  /**
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.topK]
   * @param {(docId:string, meta:object)=>boolean} [options.filter] access-control predicate
   * @returns {Array<{docId:string, score:number, meta:object, matchedTerms:string[]}>}
   */
  search(query, { topK = 10, filter = null } = {}) {
    const terms = [...new Set(stemTokens(query))]
    if (!terms.length || !this.docs.size) return []
    const avgdl = this.avgdl || 1
    const scores = new Map()
    const matched = new Map()

    for (const term of terms) {
      const posting = this.postings.get(term)
      if (!posting) continue
      const idf = this.idf(term)
      for (const [docId, f] of posting) {
        const doc = this.docs.get(docId)
        if (!doc) continue
        if (filter && !filter(docId, doc.meta)) continue
        const denom = f + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl)
        const contribution = idf * ((f * (this.k1 + 1)) / denom)
        scores.set(docId, (scores.get(docId) ?? 0) + contribution)
        if (!matched.has(docId)) matched.set(docId, [])
        matched.get(docId).push(term)
      }
    }

    return [...scores.entries()]
      .map(([docId, score]) => ({ docId, score, meta: this.docs.get(docId).meta, matchedTerms: matched.get(docId) }))
      .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
      .slice(0, Math.max(1, Number(topK) || 10))
  }

  /** Corpus statistics, recorded with every retrieval evaluation for reproducibility. */
  stats() {
    return {
      documents: this.docs.size,
      uniqueTerms: this.df.size,
      totalTokens: this.totalLength,
      avgdl: round(this.avgdl),
      k1: this.k1,
      b: this.b,
      version: this.version,
    }
  }

  /** Serialise for persistence / integrity hashing. */
  toJSON() {
    return {
      k1: this.k1,
      b: this.b,
      version: this.version,
      docs: [...this.docs.entries()].map(([docId, doc]) => ({ docId, length: doc.length, meta: doc.meta, tokens: doc.tokens })),
    }
  }

  static fromJSON(data) {
    const index = new Bm25Index({ k1: data.k1, b: data.b })
    for (const doc of data.docs ?? []) {
      index.docs.set(doc.docId, { tokens: doc.tokens, length: doc.length, meta: doc.meta })
      index.totalLength += doc.length
      const freq = new Map()
      for (const token of doc.tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
      for (const [term, count] of freq) {
        if (!index.postings.has(term)) index.postings.set(term, new Map())
        index.postings.get(term).set(doc.docId, count)
        index.df.set(term, (index.df.get(term) ?? 0) + 1)
      }
    }
    index.version = data.version ?? 1
    return index
  }
}

/**
 * Reciprocal Rank Fusion — combine BM25 with a dense/neural ranking when one is
 * available (Aetheris Lite retriever). RRF is rank-based, so it needs no score
 * normalisation between incomparable scales.
 *
 * @param {Array<Array<{docId:string}>>} rankings
 * @param {number} [k] standard RRF constant (60)
 */
export function reciprocalRankFusion(rankings, k = 60) {
  const fused = new Map()
  for (const ranking of rankings) {
    if (!Array.isArray(ranking)) continue
    ranking.forEach((entry, rank) => {
      const id = entry?.docId ?? entry
      if (!id) return
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return [...fused.entries()]
    .map(([docId, score]) => ({ docId, score: round(score) }))
    .sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
}

/** Standard retrieval metrics, used by the evaluation harness. */
export function retrievalMetrics(results, relevantIds, { k = 10 } = {}) {
  const relevant = new Set(relevantIds)
  const topK = results.slice(0, k)
  const hits = topK.filter((entry) => relevant.has(entry.docId))
  const recall = relevant.size ? hits.length / relevant.size : 0
  const precision = topK.length ? hits.length / topK.length : 0

  // Average precision
  let ap = 0
  let found = 0
  topK.forEach((entry, index) => {
    if (relevant.has(entry.docId)) {
      found += 1
      ap += found / (index + 1)
    }
  })
  ap = relevant.size ? ap / Math.min(relevant.size, k) : 0

  // Reciprocal rank of the first relevant hit
  const firstHit = topK.findIndex((entry) => relevant.has(entry.docId))
  const rr = firstHit >= 0 ? 1 / (firstHit + 1) : 0

  return {
    k,
    recall: round(recall),
    precision: round(precision),
    averagePrecision: round(ap),
    reciprocalRank: round(rr),
    hits: hits.length,
    relevantCount: relevant.size,
    returnedCount: topK.length,
  }
}

function round(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6
}
