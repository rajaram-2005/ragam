// Text normalisation, tokenisation and chunking for the knowledge pipeline.
// Deterministic: the same input always produces the same chunks and tokens, so
// retrieval results are reproducible and index rebuilds are auditable.

// Keep citation offsets accurate by tracking source position.
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
}

// A small English stopword list. Deliberately conservative: domain terms must not
// be dropped, because in company documentation they are the discriminating signal.
// Standard English stopwords. Removing them is a retrieval-quality decision, not a
// cosmetic one: without it a query word like "all" or "must" matches nearly every
// document in a policy corpus and drowns the discriminating domain terms.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are aren as at be because been
     before being below between both but by can cannot could couldn did didn do does
     doesn doing don down during each few for from further had hadn has hasn have
     haven having he her here hers herself him himself his how i if in into is isn it
     its itself just let me might more most must my myself no nor not now of off on
     once only or other ought our ours ourselves out over own same shan she should
     shouldn so some such than that the their theirs them themselves then there these
     they this those through to too under until up upon very was wasn we were weren
     what when where which while who whom why will with within without won would
     wouldn you your yours yourself yourselves`
    .split(/\s+/)
    .filter(Boolean),
)

/** Lowercase word tokens with their offsets, so citations can point at real spans. */
export function tokenize(text, { keepOffsets = false } = {}) {
  const source = normalizeText(text)
  const tokens = []
  const re = /[A-Za-z0-9_][A-Za-z0-9_'-]*/g
  let match
  while ((match = re.exec(source)) !== null) {
    const raw = match[0]
    const token = raw.toLowerCase()
    if (token.length < 2 && !/[0-9]/.test(token)) continue
    if (keepOffsets) tokens.push({ token, start: match.index, end: match.index + raw.length })
    else tokens.push(token)
  }
  return tokens
}

export function contentTokens(text) {
  return tokenize(text).filter((token) => !STOPWORDS.has(token))
}

/** Naive but real stemmer: strips common English suffixes. Not a replacement for a model. */
export function stem(token) {
  let t = token
  if (t.length > 4) {
    for (const suffix of ['ational', 'iveness', 'fulness', 'ousness', 'ization', 'isation']) {
      if (t.endsWith(suffix)) return t.slice(0, -suffix.length) + 'e'
    }
  }
  if (t.length > 3) {
    for (const suffix of ['ing', 'edly', 'ies', 'ied']) {
      if (t.endsWith(suffix)) return t.slice(0, -suffix.length)
    }
    if (t.endsWith('es') && t.length > 4) return t.slice(0, -1)
    if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1)
  }
  return t
}

export function stemTokens(text) {
  return contentTokens(text).map(stem)
}

/**
 * Sentence-aware chunking with overlap.
 *
 * @param {string} text
 * @param {object} options
 * @param {number} [options.targetChars]  soft chunk size
 * @param {number} [options.maxChars]     hard cap
 * @param {number} [options.overlapChars] context carried between chunks
 * @returns {Array<{text:string, start:number, end:number, index:number}>}
 */
export function chunkText(text, { targetChars = 1200, maxChars = 2000, overlapChars = 160 } = {}) {
  const source = normalizeText(text)
  if (!source.trim()) return []
  if (source.length <= maxChars) return [{ text: source, start: 0, end: source.length, index: 0 }]

  const sentences = splitSentences(source)
  const chunks = []
  let current = ''
  let currentStart = 0
  let nextStart = 0

  for (const sentence of sentences) {
    if (!current) {
      current = sentence.text
      currentStart = sentence.start
    } else if (current.length + sentence.text.length + 1 <= targetChars) {
      current += ` ${sentence.text}`
    } else {
      chunks.push({ text: current.trim(), start: currentStart, end: sentence.start, index: chunks.length })
      // Carry overlap from the tail of the finished chunk so a query matching a
      // boundary phrase still retrieves context.
      const overlap = overlapChars > 0 ? current.slice(Math.max(0, current.length - overlapChars)) : ''
      current = overlap ? `${overlap.trim()} ${sentence.text}` : sentence.text
      currentStart = overlap ? Math.max(currentStart, sentence.start - overlap.length) : sentence.start
    }
    nextStart = sentence.end
    // Hard-split a single sentence that exceeds maxChars (long code lines, tables).
    while (current.length > maxChars) {
      const head = current.slice(0, maxChars)
      chunks.push({ text: head.trim(), start: currentStart, end: currentStart + maxChars, index: chunks.length })
      current = current.slice(Math.max(0, maxChars - overlapChars))
      currentStart += maxChars - overlapChars
    }
  }
  if (current.trim()) {
    chunks.push({ text: current.trim(), start: currentStart, end: nextStart, index: chunks.length })
  }
  return chunks.filter((chunk) => chunk.text.length > 0)
}

export function splitSentences(text) {
  const source = normalizeText(text)
  const sentences = []
  // Split on sentence-final punctuation followed by whitespace, and on blank lines.
  const re = /[^.!?\n]+[.!?]+["')\]]*|[^.!?\n]+$/g
  let match
  while ((match = re.exec(source)) !== null) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (!trimmed) continue
    sentences.push({ text: trimmed, start: match.index + (raw.length - raw.trimStart().length), end: match.index + raw.trimEnd().length })
  }
  if (!sentences.length && source.trim()) sentences.push({ text: source.trim(), start: 0, end: source.length })
  return sentences
}

/**
 * Deterministic content hash used for deduplication.
 * Whitespace-normalised so trivial reformatting does not create a duplicate.
 */
export function contentKey(text) {
  return normalizeText(text).replace(/\s+/g, ' ').trim().toLowerCase()
}
