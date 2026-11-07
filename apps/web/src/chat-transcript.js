// Local-only Chat transcript helpers. No provider calls, credentials, model
// weights, binary attachment bytes, or backend state are handled here.

const MAX_SEARCH_LENGTH = 200
const MAX_HIGHLIGHT_SEGMENTS = 400
let messageSequence = 0

export const CHAT_TRANSCRIPT_SEARCH_LIMIT = MAX_SEARCH_LENGTH

const oneLine = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 160)

const toPinnedSet = (pinnedIds) => {
  if (pinnedIds instanceof Set) return new Set(pinnedIds)
  return new Set(Array.isArray(pinnedIds) ? pinnedIds.filter(Boolean) : [])
}

export function normalizeSearchQuery(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH)
}

export function nextMessageId() {
  messageSequence += 1
  const random = globalThis.crypto?.randomUUID?.()
  return random ? `msg-${random}` : `msg-${Date.now().toString(36)}-${messageSequence}`
}

export function withMessageId(message) {
  const base = message && typeof message === 'object' && !Array.isArray(message) ? message : { content: message }
  return base.id ? base : { ...base, id: nextMessageId() }
}

export function replaceLastMessage(messages, patch) {
  const last = messages[messages.length - 1]
  if (!last) return messages
  return [...messages.slice(0, -1), { ...last, ...patch, id: last.id ?? nextMessageId() }]
}

export function replaceLastTurn(messages, userPatch, assistantPatch) {
  const user = messages[messages.length - 2]
  const assistant = messages[messages.length - 1]
  if (!user || !assistant) return messages
  return [
    ...messages.slice(0, -2),
    { ...user, ...userPatch, id: user.id ?? nextMessageId() },
    { ...assistant, ...assistantPatch, id: assistant.id ?? nextMessageId() },
  ]
}

export function cleanPinnedIds(pinnedIds, messages) {
  const valid = new Set(messages.map((message) => message?.id).filter(Boolean))
  const current = toPinnedSet(pinnedIds)
  return new Set([...current].filter((id) => valid.has(id)))
}

export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  return ''
}

export function searchableText(message) {
  const parts = [messageText(message)]
  if (Array.isArray(message?.attachments)) {
    for (const file of message.attachments) {
      if (file && typeof file === 'object') parts.push(oneLine(file.name), oneLine(file.kind))
    }
  }
  const meta = message?.meta
  if (meta && typeof meta === 'object') {
    for (const key of ['engine', 'provider', 'modelId', 'providerModel', 'tier']) parts.push(oneLine(meta[key]))
  }
  return parts.filter(Boolean).join('\n')
}

export function selectVisibleMessages(messages, { query = '', pinnedOnly = false, pinnedIds = new Set() } = {}) {
  const needle = normalizeSearchQuery(query).toLocaleLowerCase()
  const pinned = toPinnedSet(pinnedIds)
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      if (pinnedOnly && !pinned.has(message?.id)) return false
      return !needle || searchableText(message).toLocaleLowerCase().includes(needle)
    })
}

export function highlightSegments(text, query) {
  const value = typeof text === 'string' ? text : ''
  const needle = normalizeSearchQuery(query).toLocaleLowerCase()
  if (!needle) return [{ text: value, match: false }]
  const haystack = value.toLocaleLowerCase()
  const segments = []
  let cursor = 0
  while (cursor < value.length) {
    if (segments.length >= MAX_HIGHLIGHT_SEGMENTS) {
      segments.push({ text: value.slice(cursor), match: false })
      break
    }
    const found = haystack.indexOf(needle, cursor)
    if (found < 0) {
      segments.push({ text: value.slice(cursor), match: false })
      break
    }
    if (found > cursor) segments.push({ text: value.slice(cursor, found), match: false })
    segments.push({ text: value.slice(found, found + needle.length), match: true })
    cursor = found + needle.length
  }
  return segments
}

function codeFence(text) {
  const longest = (text.match(/`+/g) ?? []).reduce((size, run) => Math.max(size, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

export function transcriptToMarkdown(messages, { query = '', pinnedOnly = false, pinnedIds = new Set() } = {}) {
  const normalizedQuery = normalizeSearchQuery(query)
  const pinned = toPinnedSet(pinnedIds)
  const lines = [
    '# RAGAM Chat transcript',
    '',
    'Exported from the current visible transcript. Binary attachment bytes are not included.',
    '',
  ]
  if (normalizedQuery) lines.push(`Search filter: \`${normalizedQuery.replace(/`/g, '\\`')}\``, '')
  if (pinnedOnly) lines.push('Filter: pinned messages only.', '')
  let count = 0
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) continue
    count += 1
    const role = message.role === 'user'
      ? 'You'
      : oneLine(message.meta?.engine ? 'Klyvaron Processor' : message.meta?.modelId, 'Assistant')
    const heading = `## ${count}. ${role}${pinned.has(message.id) ? ' · pinned' : ''}`
    lines.push(heading, '')
    if (message.historical) lines.push('*Earlier saved session.*', '')
    if (message.failed) lines.push('*Not completed.*', '')
    const attachments = Array.isArray(message.attachments)
      ? message.attachments
        .filter((file) => file && typeof file.name === 'string')
        .map((file) => `${oneLine(file.kind, 'file')} ${oneLine(file.name)}`)
        .join(', ')
      : ''
    if (attachments) lines.push(`Attachments: ${attachments}`, '')
    const evidence = []
    if (message.meta?.engine) evidence.push(message.meta.engine)
    if (message.meta?.provider) evidence.push(`provider ${oneLine(message.meta.provider)}`)
    if (message.meta?.modelId) evidence.push(`model ${oneLine(message.meta.modelId)}`)
    if (evidence.length) lines.push(`Evidence: ${evidence.join(' · ')}`, '')
    const text = messageText(message) || '(no text)'
    const fence = codeFence(text)
    lines.push(fence, text, fence, '')
  }
  if (!count) lines.push('No visible messages.', '')
  return `${lines.join('\n').trimEnd()}\n`
}

export function downloadMarkdownFile(markdown, filename = 'ragam-chat-transcript.md') {
  if (typeof document === 'undefined' || typeof Blob === 'undefined'
      || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false
  try {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return true
  } catch {
    return false
  }
}

export function validateStructuredOutput(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty reply' }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object') return { ok: false, error: 'JSON value is not an object or array' }
    return { ok: true, kind: Array.isArray(value) ? 'array' : 'object' }
  } catch (error) {
    return { ok: false, error: oneLine(error instanceof Error ? error.message : 'invalid JSON', 'invalid JSON') }
  }
}

const tokenLabel = (value) => {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? `${count.toLocaleString('en-US')} tokens` : 'unknown'
}

export function contextLimitLabel(evidence) {
  return tokenLabel(evidence?.capabilities?.contextTokens)
}

export function outputLimitLabel(evidence) {
  return tokenLabel(evidence?.capabilities?.maxOutputTokens)
}

export function isSearchShortcut(event) {
  return Boolean(event && !event.altKey && !event.shiftKey
    && (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k')
}

export function isStopShortcut(event) {
  return Boolean(event && !event.altKey && event.shiftKey
    && (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's')
}

export function isClearSearchKey(event) {
  return Boolean(event && event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey)
}
