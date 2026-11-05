import { createHash } from 'node:crypto'
import { contentTokens, splitSentences } from '../knowledge/text.mjs'

export const KLYVARON_PROCESSOR_PROFILES = Object.freeze({
  lite: Object.freeze({
    id: 'lite', label: 'Lite', contextChars: 16_000, maxTasks: 2, processingDepth: 2,
    maxSummarySentences: 4, retrievalTopK: 4, maxMemoryItems: 4, maxMemoryChars: 4_000,
    parallelTasks: 1, resourceClass: 'low',
  }),
  pro: Object.freeze({
    id: 'pro', label: 'Pro', contextChars: 64_000, maxTasks: 5, processingDepth: 5,
    maxSummarySentences: 8, retrievalTopK: 8, maxMemoryItems: 8, maxMemoryChars: 16_000,
    parallelTasks: 3, resourceClass: 'medium',
  }),
  max: Object.freeze({
    id: 'max', label: 'Max', contextChars: 100_000, maxTasks: 8, processingDepth: 8,
    maxSummarySentences: 12, retrievalTopK: 12, maxMemoryItems: 16, maxMemoryChars: 32_000,
    parallelTasks: 4, resourceClass: 'high',
  }),
})

export const KLYVARON_PROCESSOR_TASKS = Object.freeze([
  'inspect', 'summarize', 'extract', 'outline', 'compare', 'calculate', 'retrieve', 'answer',
])

const TASKS = new Set(KLYVARON_PROCESSOR_TASKS)
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const URL = /\bhttps?:\/\/[^\s<>"')]+/gi
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g
const NUMBER = /(?<![\w.])(?:[$€£₹]\s*)?-?\d+(?:,\d{3})*(?:\.\d+)?\s*%?/g
const MARKDOWN_HEADING = /^#{1,6}\s+(.+)$/gm
const BULLET = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/gm

function fail(message, code = 'invalid_processing_request') {
  const error = new Error(message)
  error.code = code
  error.status = 400
  return error
}

function cleanString(value, name, maxChars, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return ''
  if (typeof value !== 'string') throw fail(`${name} must be text`)
  if (value.length > maxChars) throw fail(`${name} exceeds the ${maxChars.toLocaleString()}-character limit`, 'processing_input_too_large')
  return value
}

function unique(values) { return [...new Set(values)] }
function captures(text, pattern) { return unique([...text.matchAll(pattern)].map((match) => match[1] ?? match[0])) }

function sourceSentences(text) {
  const sentences = []
  const pattern = /[^.!?\r\n]+[.!?]+["')\]]*|[^.!?\r\n]+$/gm
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const leading = raw.length - raw.trimStart().length
    const sentence = raw.trim()
    if (sentence) sentences.push({ text: sentence, start: match.index + leading, end: match.index + raw.trimEnd().length })
  }
  if (!sentences.length && text.trim()) {
    const leading = text.length - text.trimStart().length
    sentences.push({ text: text.trim(), start: leading, end: text.trimEnd().length })
  }
  return sentences
}

function sentenceSummary(text, limit) {
  const sentences = sourceSentences(text)
  if (!sentences.length) return { method: 'extractive', sentences: [] }
  const sentenceTokens = sentences.map((sentence) => contentTokens(sentence.text))
  const frequencies = new Map()
  for (const tokens of sentenceTokens) for (const token of new Set(tokens)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  const ranked = sentences.map((sentence, index) => {
    const tokens = sentenceTokens[index]
    const lexical = tokens.reduce((sum, token) => sum + Math.log(1 + sentences.length / (frequencies.get(token) ?? 1)), 0)
    const position = 1 / (1 + index * 0.08)
    const score = tokens.length ? Number((lexical / Math.sqrt(tokens.length) + position).toFixed(6)) : position
    return { text: sentence.text, start: sentence.start, end: sentence.end, score, originalIndex: index }
  })
  const selected = ranked.toSorted((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .slice(0, limit)
    .toSorted((a, b) => a.originalIndex - b.originalIndex)
    .map(({ text: sentence, start, end, score }) => ({ sentence, start, end, score }))
  return { method: 'extractive', sentences: selected }
}

function inspect(text) {
  const headings = captures(text, MARKDOWN_HEADING)
  const words = contentTokens(text)
  const lines = text.split(/\r?\n/)
  return {
    characters: text.length,
    words: words.length,
    sentences: splitSentences(text).length,
    lines: lines.length,
    headings,
    codeBlocks: (text.match(/```/g) ?? []).length >> 1,
    sha256: createHash('sha256').update(text).digest('hex'),
    detectedStructure: headings.length ? 'markdown_headings' : /```/.test(text) ? 'fenced_code' : 'plain_text',
  }
}

function extract(text, { maxItems = 16 } = {}) {
  return {
    emails: captures(text, EMAIL).slice(0, maxItems),
    urls: captures(text, URL).slice(0, maxItems),
    isoDates: captures(text, ISO_DATE).slice(0, maxItems),
    numbers: captures(text, NUMBER).slice(0, maxItems),
    headings: captures(text, MARKDOWN_HEADING).slice(0, maxItems),
    listItems: captures(text, BULLET).slice(0, maxItems),
    codeBlockCount: (text.match(/```/g) ?? []).length >> 1,
    note: 'Pattern-based extraction only; names, entities and meaning are not inferred.',
  }
}

function outline(text, { maxItems = 16 } = {}) {
  const headings = []
  for (const match of text.matchAll(MARKDOWN_HEADING)) headings.push({ heading: match[1].trim(), offset: match.index })
  const bullets = captures(text, BULLET)
  if (headings.length || bullets.length) return { method: 'markdown_structure', headings: headings.slice(0, maxItems), bullets: bullets.slice(0, maxItems) }
  const summary = sentenceSummary(text, maxItems)
  return { method: 'extractive_sentence_starts', items: summary.sentences.map((item) => item.sentence) }
}

function compare(left, right) {
  const a = unique(contentTokens(left))
  const b = unique(contentTokens(right))
  const aSet = new Set(a), bSet = new Set(b)
  const shared = a.filter((token) => bSet.has(token)).sort()
  const onlyInFirst = a.filter((token) => !bSet.has(token)).sort()
  const onlyInSecond = b.filter((token) => !aSet.has(token)).sort()
  const union = new Set([...a, ...b]).size
  return {
    method: 'lexical_token_set',
    uniqueTokenCounts: { first: a.length, second: b.length },
    sharedTerms: shared,
    onlyInFirst,
    onlyInSecond,
    jaccardSimilarity: union ? Number((shared.length / union).toFixed(4)) : 1,
    note: 'Lexical overlap is not semantic equivalence or a judgement of correctness.',
  }
}

function calculate(expression) {
  if (expression.length > 512) throw fail('calculation expression exceeds 512 characters')
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) ?? []
  if (!tokens.length || tokens.join('') !== expression.replace(/\s+/g, '')) throw fail('calculation accepts only numbers, parentheses, +, -, *, and /')
  if (tokens.length > 128) throw fail('calculation exceeds 128 tokens')
  let index = 0
  const peek = () => tokens[index]
  const take = () => tokens[index++]
  const primary = () => {
    const token = take()
    if (token === '+') return primary()
    if (token === '-') return -primary()
    if (token === '(') {
      const value = addSubtract()
      if (take() !== ')') throw fail('calculation has an unmatched parenthesis')
      return value
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) throw fail('calculation expected a number')
    return Number(token)
  }
  const multiplyDivide = () => {
    let value = primary()
    while (peek() === '*' || peek() === '/') {
      const operator = take()
      const right = primary()
      if (operator === '/' && right === 0) throw fail('division by zero is not allowed', 'division_by_zero')
      value = operator === '*' ? value * right : value / right
      if (!Number.isFinite(value)) throw fail('calculation result is outside the supported numeric range')
    }
    return value
  }
  const addSubtract = () => {
    let value = multiplyDivide()
    while (peek() === '+' || peek() === '-') {
      const operator = take()
      const right = multiplyDivide()
      value = operator === '+' ? value + right : value - right
      if (!Number.isFinite(value)) throw fail('calculation result is outside the supported numeric range')
    }
    return value
  }
  const value = addSubtract()
  if (index !== tokens.length) throw fail('calculation contains an unexpected token')
  return { expression, value }
}

function formatTaskResult(task, result) {
  if (task === 'inspect') return `Input inspection: ${result.words} words, ${result.sentences} sentences, ${result.characters} characters; SHA-256 ${result.sha256}.`
  if (task === 'summarize') return result.sentences.length
    ? `Extractive summary (selected original sentences):\n${result.sentences.map((entry) => `• ${entry.sentence}`).join('\n')}`
    : 'There is no text to summarize.'
  if (task === 'extract') return `Pattern-based extraction:\n${JSON.stringify(result, null, 2)}`
  if (task === 'outline') return result.method === 'markdown_structure'
    ? `Document outline:\n${[...result.headings.map((item) => `# ${item.heading}`), ...result.bullets.map((item) => `• ${item}`)].join('\n') || 'No headings or list items found.'}`
    : `Extractive outline:\n${result.items.map((item) => `• ${item}`).join('\n') || 'No sentences found.'}`
  if (task === 'compare') return `Lexical comparison: ${result.sharedTerms.length} shared terms; Jaccard token-set similarity ${result.jaccardSimilarity}. This is not semantic comparison.`
  if (task === 'calculate') return `${result.expression} = ${result.value}`
  if (task === 'retrieve' || task === 'answer') {
    const evidence = result.results.map((item, index) => `[E${index + 1}] ${item.citation?.title ?? item.citation?.documentId ?? 'local source'}${item.citation?.sourcePath ? ` (${item.citation.sourcePath})` : ''}\n${item.text}`)
    const memories = result.memories.map((item, index) => `[M${index + 1}] ${item.text}`)
    const excerpts = [...evidence, ...memories]
    return excerpts.length
      ? `Retrieved ${evidence.length} knowledge excerpt(s) and ${memories.length} memory item(s). These are source records, not a generated answer:\n${excerpts.join('\n\n')}`
      : 'No matching knowledge or approved memories were found. Add or select relevant source material; no answer has been inferred.'
  }
  return 'Completed.'
}

async function runTask(task, { input, comparisonInput, knowledge, memory, principal, profile, useKnowledge, useMemory, signal }) {
  if (signal?.aborted) throw Object.assign(new Error('Processing cancelled.'), { name: 'AbortError', code: 'cancelled', status: 499 })
  const depthBudget = Math.max(1, profile.processingDepth * 2)
  if (task === 'inspect') return inspect(input)
  if (task === 'summarize') return sentenceSummary(input, Math.min(profile.maxSummarySentences, depthBudget))
  if (task === 'extract') return extract(input, { maxItems: depthBudget })
  if (task === 'outline') return outline(input, { maxItems: depthBudget })
  if (task === 'compare') {
    if (!comparisonInput.trim()) throw fail('compare requires comparisonInput text')
    return compare(input, comparisonInput)
  }
  if (task === 'calculate') return calculate(input)
  if (task === 'retrieve' || task === 'answer') {
    const results = useKnowledge && knowledge
      ? knowledge.search({ query: input, principal, topK: Math.min(profile.retrievalTopK, depthBudget), useNeural: false }).results
      : []
    const memories = useMemory && memory
      ? await memory.searchMemories(input, { topK: Math.min(profile.maxMemoryItems, depthBudget) })
      : []
    let remainingMemoryChars = profile.maxMemoryChars
    const boundedMemories = memories.map((item) => {
      const text = String(item.memory.text ?? '').slice(0, remainingMemoryChars)
      remainingMemoryChars = Math.max(0, remainingMemoryChars - text.length)
      return { text, id: item.memory.id, kind: item.memory.kind, subject: item.memory.subject, tags: item.memory.tags }
    }).filter((item) => item.text.length > 0)
    return {
      results: results.map((item) => ({ text: item.text, citation: item.citation, score: item.score })),
      memories: boundedMemories,
      evidenceCount: results.length,
      memoryCount: boundedMemories.length,
      method: 'local_bm25',
    }
  }
  throw fail(`unsupported task '${task}'`)
}

async function runBounded(tasks, limit, handler) {
  const output = new Array(tasks.length)
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const index = nextIndex++
      if (index >= tasks.length) return
      output[index] = await handler(tasks[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return output
}

/** A deterministic, model-independent local processing pipeline. It never calls a model or network. */
export async function processKlyvaronInput({
  tier = 'lite', input, tasks = ['summarize'], comparisonInput = '',
  knowledge = null, memory = null, principal = null, useKnowledge = false, useMemory = false,
  saveToKnowledge = false, title = 'User-supplied Klyvaron note', signal, ...unknownFields
} = {}) {
  if (Object.keys(unknownFields).length) throw fail(`unknown processing fields: ${Object.keys(unknownFields).join(', ')}`)
  const profile = KLYVARON_PROCESSOR_PROFILES[tier]
  if (!profile) throw fail('tier must be lite, pro or max')
  const text = cleanString(input, 'input', profile.contextChars)
  if (!text.trim()) throw fail('input must not be empty')
  const compareText = cleanString(comparisonInput, 'comparisonInput', profile.contextChars, { optional: true })
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > profile.maxTasks
    || tasks.some((task) => typeof task !== 'string' || !TASKS.has(task))) {
    throw fail(`${profile.label} accepts 1-${profile.maxTasks} named tasks: ${KLYVARON_PROCESSOR_TASKS.join(', ')}`)
  }
  if (new Set(tasks).size !== tasks.length) throw fail('workflow task names must be unique')
  if ([useKnowledge, useMemory, saveToKnowledge].some((flag) => typeof flag !== 'boolean')) throw fail('knowledge, memory and save options must be explicit booleans')
  if (saveToKnowledge && (!knowledge || typeof knowledge.ingestText !== 'function')) throw fail('the account knowledge store is unavailable')
  if (signal?.aborted) throw Object.assign(new Error('Processing cancelled.'), { name: 'AbortError', code: 'cancelled', status: 499 })

  const results = await runBounded(tasks, profile.parallelTasks, async (task) => ({
    task,
    result: await runTask(task, {
      input: task === 'calculate' ? text.trim() : text,
      comparisonInput: compareText,
      knowledge, memory, principal, profile, useKnowledge, useMemory, signal,
    }),
  }))
  let saved = null
  if (saveToKnowledge) {
    saved = await knowledge.ingestText({
      title: cleanString(title, 'title', 200),
      text,
      mime: 'text/plain',
      classification: 'internal',
      owner: principal,
      principals: principal ? [principal] : [],
      meta: { source: 'explicit_user_save', processor: 'klyvaron-deterministic-v1' },
    })
  }
  return {
    schema: 'klyvaron.deterministic-processing.v1',
    tier,
    profile: { ...profile },
    engine: 'klyvaron-deterministic-v1',
    modelUsed: false,
    weightsUsed: false,
    networkUsed: false,
    persistence: saved ? { requested: true, duplicate: saved.duplicate, documentId: saved.documentId ?? saved.document?.id } : { requested: false },
    results,
    text: results.map(({ task, result }) => `[${task}] ${formatTaskResult(task, result)}`).join('\n\n'),
    limitations: [
      'This engine uses deterministic parsing, ranking, retrieval and arithmetic; it does not provide learned open-ended language reasoning.',
      'Summaries are extractive, answers return matching local evidence, and extraction is pattern-based.',
      'Images, audio and video require text supplied or extracted by a separate explicitly selected tool; this endpoint does not interpret binary media.',
    ],
  }
}
