import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_TRANSCRIPT_SEARCH_LIMIT,
  cleanPinnedIds,
  contextLimitLabel,
  downloadMarkdownFile,
  highlightSegments,
  isClearSearchKey,
  isSearchShortcut,
  isStopShortcut,
  messageText,
  nextMessageId,
  normalizeSearchQuery,
  outputLimitLabel,
  replaceLastMessage,
  replaceLastTurn,
  searchableText,
  selectVisibleMessages,
  transcriptToMarkdown,
  validateStructuredOutput,
  withMessageId,
} from '../src/chat-transcript.js'

const messages = [
  { id: 'a', role: 'user', content: 'Alpha plan', attachments: [{ name: 'brief.txt', kind: 'text' }] },
  { id: 'b', role: 'assistant', content: 'Beta result', meta: { provider: 'Example', modelId: 'model-b' } },
  { id: 'c', role: 'user', content: 'Gamma question' },
]

test('search queries are bounded and whitespace-normalized', () => {
  assert.equal(normalizeSearchQuery('  alpha\t\n beta  '), 'alpha beta')
  assert.equal(normalizeSearchQuery(42), '')
  assert.equal(normalizeSearchQuery('x'.repeat(500)).length, CHAT_TRANSCRIPT_SEARCH_LIMIT)
})

test('transcript search is case-insensitive and preserves original indices', () => {
  const found = selectVisibleMessages(messages, { query: 'BETA' })
  assert.deepEqual(found.map(({ index }) => index), [1])
  assert.equal(found[0].message.content, 'Beta result')
  assert.match(searchableText(messages[0]), /brief\.txt/)
  assert.match(searchableText(messages[1]), /model-b/)
  assert.doesNotMatch(searchableText({ content: [{ type: 'image', data: 'secret' }] }), /secret/)
})

test('pinned-only filtering combines with search without mutating transcript state', () => {
  const all = selectVisibleMessages(messages, {})
  assert.equal(all.length, 3)
  const pinned = selectVisibleMessages(messages, { pinnedOnly: true, pinnedIds: new Set(['b', 'c']) })
  assert.deepEqual(pinned.map(({ message }) => message.id), ['b', 'c'])
  const narrowed = selectVisibleMessages(messages, { query: 'gamma', pinnedOnly: true, pinnedIds: new Set(['b', 'c']) })
  assert.deepEqual(narrowed.map(({ message }) => message.id), ['c'])
  assert.equal(messages[1].content, 'Beta result')
})

test('highlighting preserves original text and treats regex metacharacters literally', () => {
  const text = 'literal a.* then A.* end'
  const segments = highlightSegments(text, 'a.*')
  assert.equal(segments.map((segment) => segment.text).join(''), text)
  assert.deepEqual(segments.filter((segment) => segment.match).map((segment) => segment.text), ['a.*', 'A.*'])
  assert.deepEqual(highlightSegments(text, ''), [{ text, match: false }])
})

test('Markdown export includes visible metadata but never binary attachment bytes', () => {
  const markdown = transcriptToMarkdown([messages[0], { ...messages[1], content: 'line with ``` fence' }], {
    query: 'beta',
    pinnedOnly: true,
    pinnedIds: ['b'],
  })
  assert.match(markdown, /# RAGAM Chat transcript/)
  assert.match(markdown, /Search filter: `beta`/)
  assert.match(markdown, /Filter: pinned messages only/)
  assert.match(markdown, /Attachments: text brief\.txt/)
  assert.match(markdown, /Evidence: provider Example · model model-b/)
  assert.match(markdown, /· pinned/)
  assert.match(markdown, /````/)
  assert.doesNotMatch(markdown, /base64|data:/)
  assert.equal(downloadMarkdownFile(markdown), false, 'no DOM in Node means the local download guard returns false')
})

test('structured-output validation is opt-in client syntax checking, not a provider claim', () => {
  assert.deepEqual(validateStructuredOutput('{"ok":true}'), { ok: true, kind: 'object' })
  assert.deepEqual(validateStructuredOutput('[1,2]'), { ok: true, kind: 'array' })
  assert.equal(validateStructuredOutput('').ok, false)
  assert.equal(validateStructuredOutput('42').ok, false)
  assert.equal(validateStructuredOutput('null').ok, false)
  assert.equal(validateStructuredOutput('{oops').ok, false)
})

test('context and output labels keep unknown metadata unknown', () => {
  const evidence = { capabilities: { contextTokens: 8192, maxOutputTokens: 2048 } }
  assert.equal(contextLimitLabel(evidence), '8,192 tokens')
  assert.equal(outputLimitLabel(evidence), '2,048 tokens')
  assert.equal(contextLimitLabel(null), 'unknown')
  assert.equal(outputLimitLabel({ capabilities: { maxOutputTokens: null } }), 'unknown')
})

test('keyboard shortcuts require explicit modifiers and do not hijack plain keys', () => {
  assert.equal(isSearchShortcut({ key: 'k', ctrlKey: true }), true)
  assert.equal(isSearchShortcut({ key: 'K', metaKey: true }), true)
  assert.equal(isSearchShortcut({ key: 'k' }), false)
  assert.equal(isStopShortcut({ key: 'S', ctrlKey: true, shiftKey: true }), true)
  assert.equal(isStopShortcut({ key: 's', ctrlKey: true }), false)
  assert.equal(isClearSearchKey({ key: 'Escape' }), true)
  assert.equal(isClearSearchKey({ key: 'Escape', ctrlKey: true }), false)
})

test('message ids stay stable across replacement and stale pins are removed', () => {
  const first = withMessageId({ role: 'user', content: 'one' })
  const second = withMessageId({ role: 'assistant', content: '', pending: true })
  assert.notEqual(first.id, second.id)
  assert.equal(withMessageId(first).id, first.id)
  assert.notEqual(nextMessageId(), nextMessageId())
  const updated = replaceLastMessage([first, second], { content: 'done', pending: false })
  assert.equal(updated[1].id, second.id)
  assert.equal(updated[1].content, 'done')
  const failed = replaceLastTurn([first, second], { failed: true }, { failed: true, content: 'partial' })
  assert.deepEqual(failed.map((message) => message.id), [first.id, second.id])
  assert.equal(failed[1].content, 'partial')
  const clean = cleanPinnedIds(new Set(['a', 'stale']), messages)
  assert.deepEqual([...clean], ['a'])
  assert.equal(messageText({ content: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.equal(messageText({ content: [{ type: 'image', data: 'bytes' }] }), '')
})
